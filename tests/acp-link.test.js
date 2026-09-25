import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Trace } from '../src/trace.js';

// ACP blocks are derived interpretation; Trace must bind each block back to
// the original events of the host messages it covers (T2/T3 transitively).
const host = (messageID, id) => ({ sessionID: 'worker', messageID, id, agent: 'build' });
const parseRecall = text => JSON.parse(text.split('\n')[2]);
async function open(directory) {
  const trace = new Trace({ location: { directory }, session: {} }, { storeRoot: path.join(directory, 'store') });
  await trace.ready;
  return trace;
}
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-acp-link-'));
  const state = { trace: await open(directory), directory };
  t.after(async () => { await state.trace.store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return state;
}
const compressed = blocks => ({ type: 'session.context.compressed', properties: { sessionID: 'worker', reason: 'pressure', beforeBytes: 900, afterBytes: 300, blocks } });
const block = (blockId, tier, messageIDs, parentBlockIds = []) =>
  ({ blockId, ref: `acp:main:${blockId}`, scope: 'main', tier, messageIDs, parentBlockIds, summarySha256: `sha-${blockId}` });

test('an ACP block binds to the tool results of exactly the messages it covers', async t => {
  const { trace } = await fixture(t);
  const a = await trace.after({ ...host('m1', 'c1'), tool: 'read', input: { path: 'a' }, status: 'completed', result: { output: 'A' } });
  const b = await trace.after({ ...host('m2', 'c2'), tool: 'bash', input: { command: 'make' }, status: 'completed', result: { output: 'ok' } });
  const c = await trace.after({ ...host('m3', 'c3'), tool: 'read', input: { path: 'c' }, status: 'completed', result: { output: 'C' } });
  await trace.lifecycle(compressed([block('b1', 1, ['m1', 'm2', 'm-unknown'])]));
  const [entry] = trace.store.findEntriesAll({ type: 'acp.block', session: 'worker' });
  assert.ok(entry, 'acp.block recorded');
  const event = await trace.store.readEvent(entry.ref);
  assert.equal(event.acp_block.evidence_total, 2);
  assert.deepEqual(event.acp_block.evidence_refs, [a.ref, b.ref]);
  assert.equal(event.acp_block.unresolved_messages, 1, 'an uncovered message is reported, not hidden');
  const full = JSON.parse((await trace.store.expand(event.payload.ref)).exact_utf8);
  assert.deepEqual(full.evidence_refs, [a.ref, b.ref]);
  assert.deepEqual(full.unresolved_message_ids, ['m-unknown']);
  assert.ok(!full.evidence_refs.includes(c.ref));
  // The recall frame shows the block with citeable handles for its evidence.
  const view = parseRecall(trace.recall('worker'));
  assert.equal(view.acp_blocks.length, 1);
  assert.equal(view.acp_blocks[0].block, 'acp:main:b1');
  assert.deepEqual(view.acp_blocks[0].evidence_refs, [a.ref, b.ref]);
  // Every block ref and evidence ref is citeable this turn (a ref already
  // handled via recent keeps its first handle rather than a duplicate).
  const handled = new Set(trace.recallSnapshot('worker').assignments.map(a => a.ref));
  for (const ref of [view.acp_blocks[0].event_ref, a.ref, b.ref]) assert.ok(handled.has(ref), `handle for ${ref}`);
});

test('a T2 block absorbs its parent in recall and still resolves to original events', async t => {
  const { trace } = await fixture(t);
  const refs = [];
  for (const id of ['m1', 'm2', 'm3']) refs.push((await trace.after({ ...host(id, `c-${id}`), tool: 'read', input: { path: id }, status: 'completed', result: { output: id } })).ref);
  await trace.lifecycle(compressed([block('b1', 1, ['m1', 'm2'])]));
  await trace.lifecycle(compressed([block('b2', 2, ['m1', 'm2', 'm3'], ['b1'])]));
  const view = parseRecall(trace.recall('worker'));
  assert.deepEqual(view.acp_blocks.map(b => b.block), ['acp:main:b2']);
  assert.equal(view.acp_blocks[0].tier, 2);
  assert.deepEqual(view.acp_blocks[0].evidence_refs, refs);
  // Absorbed blocks leave recall but remain retrievable history.
  assert.equal(trace.store.findEntriesAll({ type: 'acp.block', session: 'worker' }).length, 2);
});

test('duplicate delivery records once, and the projection survives a restart', async t => {
  const state = await fixture(t);
  await state.trace.after({ ...host('m1', 'c1'), tool: 'read', input: { path: 'a' }, status: 'completed', result: { output: 'A' } });
  const event = compressed([block('b1', 1, ['m1'])]);
  await state.trace.lifecycle(event);
  await state.trace.lifecycle(event);
  assert.equal(state.trace.store.findEntriesAll({ type: 'acp.block', session: 'worker' }).length, 1);
  await state.trace.store.close();
  state.trace = await open(state.directory);
  const view = parseRecall(state.trace.recall('worker'));
  assert.deepEqual(view.acp_blocks.map(b => b.block), ['acp:main:b1']);
});

test('a later native compaction removes older ACP blocks from recall', async t => {
  const { trace } = await fixture(t);
  await trace.after({ ...host('m1', 'c1'), tool: 'read', input: { path: 'a' }, status: 'completed', result: { output: 'A' } });
  await trace.lifecycle(compressed([block('b1', 1, ['m1'])]));
  await new Promise(resolve => setTimeout(resolve, 5));
  await trace.observeMessages('worker', [{ type: 'compaction', id: 'cmp1', status: 'completed', summary: 'Native summary', time: { created: Date.now() } }]);
  assert.deepEqual(parseRecall(trace.recall('worker')).acp_blocks, []);
});

test('assistant messages persist at step end, before a native compaction hides them', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-step-persist-'));
  let window = [];
  const trace = new Trace({ location: { directory }, session: { context: async () => window } }, { storeRoot: path.join(directory, 'store') });
  await trace.ready;
  t.after(async () => { await trace.store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await trace.after({ ...host('m0', 'c0'), tool: 'read', input: { path: 'x' }, status: 'completed', result: { output: 'x' } });
  const step = id => ({ id, type: 'assistant', role: 'assistant', time: { created: 1, completed: 2 }, content: [{ type: 'text', text: `reasoned ${id}` }] });
  window = [step('a1')];
  await trace.lifecycle({ type: 'session.step.ended', properties: { sessionID: 'worker' } });
  window = [step('a2')];
  await trace.lifecycle({ type: 'session.compaction.started', properties: { sessionID: 'worker' } });
  // After compaction the plugin-visible window no longer contains a1/a2.
  window = [{ id: 'cmp', type: 'compaction', status: 'completed', summary: 'Native summary', time: { created: 3 } }];
  await trace.lifecycle({ type: 'session.compaction.ended', properties: { sessionID: 'worker' } });
  const persisted = trace.store.findEntriesAll({ type: 'message.persisted', session: 'worker' }).map(e => e.messageID);
  assert.ok(persisted.includes('a1') && persisted.includes('a2'), `persisted: ${persisted}`);
});

test('the documented session projection file is written for external read-only readers', async t => {
  const { trace } = await fixture(t);
  const ev = await trace.after({ ...host('m1', 'c1'), tool: 'read', input: { path: 'a' }, status: 'completed', result: { output: 'A' } });
  const { createHash } = await import('node:crypto');
  const file = path.join(trace.store.root, 'sessions', `${createHash('sha256').update('worker').digest('hex')}.json`);
  let projection = null;
  for (let i = 0; i < 40 && !projection; i++) {
    await new Promise(resolve => setTimeout(resolve, 25));
    projection = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
  }
  assert.ok(projection, 'sessions/<sha256(sessionID)>.json exists');
  assert.equal(projection.sessionID, 'worker');
  assert.ok(projection.recent.some(e => e.ref === ev.ref));
});

test('review rounds stay one handle away in recall, after the worker context moved on', async t => {
  const { trace } = await fixture(t);
  const review = await trace.after({ ...host('m1', 'c-review'), tool: 'review', input: { focus: 'parser' }, status: 'completed', result: { output: 'changes_requested: fix parse.js:41' } });
  for (let i = 0; i < 40; i++) await trace.after({ ...host(`m${i + 2}`, `c${i}`), tool: 'read', input: { path: `f${i}` }, status: 'completed', result: { output: 'x' } });
  const view = parseRecall(trace.recall('worker'));
  assert.equal(view.reviews.length, 1);
  assert.equal(view.reviews[0].ref, review.ref);
  assert.equal(view.reviews[0].callID, 'c-review');
  const handled = new Set(trace.recallSnapshot('worker').assignments.map(a => a.ref));
  assert.ok(handled.has(review.ref));
});

test('a burst of persisted messages and checkpoints never evicts tool results from recall', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-recent-tools-'));
  let window = [];
  const trace = new Trace({ location: { directory }, session: { context: async () => window } }, { storeRoot: path.join(directory, 'store') });
  await trace.ready;
  t.after(async () => { await trace.store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const tool = await trace.after({ ...host('m0', 'c0'), tool: 'bash', input: { command: 'make' }, status: 'completed', result: { output: 'ok' } });
  window = Array.from({ length: 60 }, (_, i) => ({ id: `a${i}`, type: 'assistant', role: 'assistant', time: { created: 1, completed: 2 }, content: [{ type: 'text', text: `step ${i}` }] }));
  await trace.lifecycle({ type: 'session.compaction.ended', properties: { sessionID: 'worker' } });
  const view = parseRecall(trace.recall('worker'));
  assert.deepEqual(view.recent.map(r => r.ref), [tool.ref]);
});
