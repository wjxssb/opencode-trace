import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Trace } from '../src/trace.js';
import { stable, hash, callKey, messageID, messageRole, textFromMessage, mutationPaths } from '../src/util.js';
import { parseMap, saveCompact } from '../src/compact.js';
import plugin from '../src/index.js';
import { definitions } from '../src/tools.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-trace-test-'));
  const trace = new Trace({ location: { directory: dir } }, { storeRoot: path.join(dir, 'store') });
  await trace.ready;
  t.after(async () => { trace.store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, trace, store: trace.store };
}
const host = (sessionID = 's1', id = 'c1') => ({ sessionID, messageID: 'm1', id, agent: 'build' });

test('canonical serialization, host message normalization and stable call IDs', () => {
  assert.equal(stable({ z: 1, a: ['x', undefined] }), '{"a":["x",null],"z":1}');
  assert.equal(messageID({ info: { id: 'm' } }), 'm');
  assert.equal(messageRole({ type: 'user' }), 'user');
  assert.equal(textFromMessage({ content: [{ type: 'text', text: 'old' }] }), 'old');
  assert.equal(callKey(host()), callKey({ ...host(), status: 'completed' }));
  assert.notEqual(callKey(host()), callKey(host('s2')));
  assert.notEqual(callKey({ ...host(), tool: 'execute' }), callKey({ ...host(), tool: 'inner_tool' }));
  assert.notEqual(callKey({ ...host(), tool: 'inner_tool', input: { x: 1 } }), callKey({ ...host(), tool: 'inner_tool', input: { x: 2 } }));
});

test('before/after pairing, exact outputs, immutable ID replay and restart', async t => {
  const { store, trace, dir } = await fixture(t);
  const e = { ...host(), tool: 'read', input: { filePath: path.join(dir, 'doc'), offset: 2, limit: 5 } };
  const before = await trace.before(e);
  const after = await trace.after({ ...e, status: 'completed', result: { content: [{ type: 'text', text: 'original\n中' }] } });
  assert.equal(before.callKey, after.callKey);
  assert.equal(after.host.messageID, 'm1');
  assert.equal(after.host.agent, 'build');
  assert.equal(after.source.offset, 2);
  const replay = await trace.after({ ...e, status: 'completed', result: { content: [{ type: 'text', text: 'original\n中' }] } });
  assert.equal(replay.ref, after.ref); assert.equal(replay.at, after.at);
  const note = await trace.note({ kind: 'finding', text: 'observed original', source_refs: [after.ref] }, host());
  await fs.writeFile(path.join(dir, 'doc'), 'changed');
  assert.match((await store.expand(after.ref)).exact_utf8, /original/);
  assert.equal((await store.expand(after.outputs[0].ref)).exact_utf8, 'original\n中');
  const second = await new Store(dir, path.join(dir, 'store')).init(); t.after(() => second.close());
  assert.equal(second.session('s1').notes[0].ref, note.ref);
  assert.equal((await second.expand(after.outputs[0].ref)).exact_utf8, 'original\n中');
  assert.equal(second.session('s1').pending[after.callKey].terminal, true);
});

test('blob and event tampering detected, page bytes exact, partial temp ignored', async t => {
  const { store, dir } = await fixture(t);
  const b = await store.blob('a中文b', 'utf8');
  let data = Buffer.alloc(0);
  for (let offset = 0; offset < b.bytes; offset += 2) data = Buffer.concat([data, Buffer.from((await store.expand(b.ref, offset, 2)).exact_base64, 'base64')]);
  assert.equal(data.toString(), 'a中文b');
  await fs.writeFile(path.join(store.root, 'blobs', b.sha256.slice(0, 2), b.sha256), 'tampered');
  await assert.rejects(store.readBlob(b.ref), /hash mismatch/);
  await fs.writeFile(path.join(store.root, 'events', 'partial.tmp'), '{');
  const restart = await new Store(dir, path.join(dir, 'store')).init(); t.after(() => restart.close());
  assert.equal(restart.seen.size, 0);
  await assert.rejects(store.expand('../../secret'));
});

test('valid compact recovery, malformed and absent maps record gaps and retain summary', async t => {
  const { store } = await fixture(t);
  const source = await store.record('tool.after', host(), { exact: 'old' });
  const map = { important_refs: [source.ref] };
  const summary = `Human summary\n<opencode-trace-map-v1>${JSON.stringify(map)}</opencode-trace-map-v1>`;
  assert.deepEqual(await parseMap(summary, store), map);
  const good = await saveCompact(store, 's1', { id: 'compact1', summary, type: 'compaction', status: 'completed' });
  assert.deepEqual(good.compact.refs, [source.ref]);
  for (const [id, text] of [['compact2', 'Native summary <opencode-trace-map-v1>{bad}</opencode-trace-map-v1>'], ['compact3', 'Native summary without map']]) {
    const bad = await saveCompact(store, 's1', { id, summary: text });
    assert.ok(bad.compact.recovery_gap);
    assert.match((await store.expand(bad.ref)).exact_utf8, /Native summary/);
  }
});

test('note structural validation, workspace scope, supersession and dependency links', async t => {
  const { trace, store } = await fixture(t);
  await assert.rejects(trace.note({ kind: 'invented', text: 'x', source_refs: [] }, host()));
  await assert.rejects(trace.note({ kind: 'finding', text: 'x', source_refs: [`evt_${'a'.repeat(64)}`] }, host()));
  const a = await trace.note({ kind: 'unresolved', text: 'Question', source_refs: [] }, host());
  const b = await trace.note({ kind: 'correction', text: 'Resolved', source_refs: [a.ref], supersedes: [a.ref], depends_on: [a.ref] }, host('s1', 'c2'));
  assert.equal(trace.projection('s1').unresolved.length, 0);
  assert.deepEqual((await store.readEvent(b.ref)).note.depends_on, [a.ref]);
});

test('unlimited peer admission, two-way advisory, intent lifecycle and canonical structured mutation', async t => {
  const { trace, store, dir } = await fixture(t);
  await fs.mkdir(path.join(dir, 'folder')); await fs.symlink(path.join(dir, 'folder'), path.join(dir, 'alias'));
  await trace.intent({ summary: 'Change file', paths: ['folder/x'], status: 'active' }, host('s1'));
  const second = await trace.intent({ summary: 'Same file', paths: ['alias/x'], status: 'active' }, host('s2'));
  assert.equal(second.advisories.length, 1); assert.equal(second.execution_effect, 'none');
  assert.equal(store.session('s1').conflicts.length, 1); assert.equal(store.session('s2').conflicts.length, 1);
  await trace.before({ ...host('s3'), tool: 'edit', input: { filePath: path.join(dir, 'alias/x') } });
  assert.ok(store.session('s3').conflicts.length >= 2);
  await trace.before({ ...host('s4'), tool: 'write', input: { filePath: path.join(dir, 'folder/x') } });
  assert.ok(store.session('s4').conflicts.some(c => c.peers.includes('s3')));
  for (let i = 5; i < 80; i++) store.session(`s${i}`);
  assert.equal(trace.projection('s1', 0, 8).peer_total, 78);
  assert.equal(trace.projection('s1', 8, 64).peers.length, 64);
  await trace.intent({ summary: 'Done', paths: ['folder/x'], status: 'done' }, host('s1', 'c2'));
  assert.equal(store.session('s1').intent.status, 'done');
});

test('arbitrary shell and textual patch remain unknown in any language', async t => {
  const { dir, trace } = await fixture(t);
  for (const command of ['echo x > secret', 'sed -i x file', 'git reset --hard', '修改文件 a.txt', 'touch foo']) {
    assert.equal(await mutationPaths('shell', { command }, dir), null);
    const event = await trace.before({ ...host(), tool: 'shell', input: { command } });
    assert.equal(event.paths, 'unknown');
  }
  assert.equal(await mutationPaths('patch', { patch: '*** Update File: foo' }, dir), null);
});

test('recall has hard UTF8 ceiling, contains refs and no large output', async t => {
  const { trace } = await fixture(t);
  for (let i = 0; i < 18; i++) await trace.note({ kind: 'unresolved', text: '中'.repeat(1200), source_refs: [] }, host('s1', `c${i}`));
  await trace.after({ ...host(), tool: 'read', input: {}, status: 'completed', result: { content: [{ type: 'text', text: 'LARGE_PAYLOAD'.repeat(20000) }] } });
  const recall = trace.recall('s1');
  assert.ok(Buffer.byteLength(recall) <= 12288);
  assert.ok(recall.startsWith('OPENCODE_TRACE_RECALL_V1'));
  assert.ok(recall.includes('evt_')); assert.ok(!recall.includes('LARGE_PAYLOAD'));
});

test('cross-process store updates merge via immutable events and restart', async t => {
  const { store, dir } = await fixture(t);
  const second = await new Store(dir, path.join(dir, 'store')).init(); t.after(() => second.close());
  await Promise.all([store.record('prompt.received', host('s1'), { text: 'one' }), second.record('prompt.received', host('s2'), { text: 'two' })]);
  await new Promise(r => setTimeout(r, 30)); await store.flush(); await second.flush();
  // Cross-process convergence also works with request-driven reconciliation
  // when the host has exhausted inotify watches.
  await store.reconcile(); await second.reconcile();
  assert.ok(store.sessions.has('s2')); assert.ok(second.sessions.has('s1'));
});

test('direct tool output satisfies host presentation contract after real observations', async t => {
  const { trace } = await fixture(t);
  await trace.after({ ...host(), tool: 'read', input: { filePath: 'doc' }, status: 'completed', result: { content: [{ type: 'text', text: 'old' }] } });
  await trace.note({ kind: 'finding', text: 'found', source_refs: [] }, host());
  const result = await definitions(trace).find(t => t.name === 'trace_status').execute({}, host());
  // P1 contract (Phase 0 spike): content is human Markdown + fenced machine
  // block; the structured value rides in metadata.raw, size-bounded.
  assert.equal(typeof result.content, 'string');
  assert.equal(result.output, result.content);
  assert.match(result.content, /```json/);
  assert.equal(typeof result.metadata.raw, 'object');
  assert.equal(result.metadata.raw.ok, true);
  assert.equal(result.metadata.raw.ok, true);
  assert.equal(result.metadata.raw.recent[0].tool, 'read');
  assert.match(result.title, /Memory for s1:/);
});

test('V2 compaction ended archives trusted summary and rejects other workspace events', async t => {
  const { trace, dir, store } = await fixture(t);
  const source = await store.record('tool.after', host(), { old: 'evidence' });
  trace.ctx.session = { context: async () => ({ data: [{ type: 'compaction', id: 'msg_compact', status: 'completed', summary: `Native summary <opencode-trace-map-v1>{"important_refs":["${source.ref}"]}</opencode-trace-map-v1>` }] }) };
  await trace.lifecycle({ type: 'session.compaction.ended', id: 'host_evt1', location: { directory: dir }, data: { sessionID: 's1' } });
  assert.deepEqual(store.session('s1').compact.refs, [source.ref]);
  const size = store.seen.size;
  await trace.lifecycle({ type: 'session.created', location: { directory: '/tmp/other-workspace' }, data: { sessionID: 's2' } });
  assert.equal(store.seen.size, size);
  assert.ok(!store.sessions.has('s2'));
});

test('dispatcher and inner tools sharing host call ID keep independent pairs', async t => {
  const { trace, store } = await fixture(t);
  const events = [{ ...host(), tool: 'execute', input: { code: 'two inner calls' } }, { ...host(), tool: 'third_party', input: { query: 'one' } }, { ...host(), tool: 'third_party', input: { query: 'two' } }];
  const before = [];
  for (const e of events) before.push(await trace.before(e));
  assert.equal(new Set(before.map(e => e.callKey)).size, 3);
  for (const e of events.toReversed()) {
    const after = await trace.after({ ...e, status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] } });
    assert.equal(after.callKey, before.find(b => b.callKey === after.callKey).callKey);
  }
  assert.equal(Object.values(store.session('s1').pending).filter(p => !p.terminal).length, 0);
});

test('plugin store failure never throws native hooks, removes tools, or binds permission/shell hooks', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-fail-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const blocked = path.join(dir, 'file'); await fs.writeFile(blocked, 'not a directory');
  const hooks = {}, added = [];
  const ctx = { options: { storeRoot: blocked }, location: { directory: dir },
    session: { hook: async (name, fn) => { hooks[name] = fn; } },
    tool: { hook: async (name, fn) => { hooks[name] = fn; }, transform: async fn => fn({ add: d => added.push(d) }) },
    agent: { transform: async fn => fn({ list: () => [] }) }, event: { async *subscribe() {} } };
  const cleanup = await plugin.setup(ctx);
  const native = { shell: {}, edit: {}, subagent: {} };
  const event = { ...host(), tool: 'shell', input: { command: 'printf ok' }, system: [], tools: native };
  for (const fn of Object.values(hooks)) await assert.doesNotReject(() => fn(event));
  assert.deepEqual(Object.keys(native), ['shell', 'edit', 'subagent']);
  assert.deepEqual(Object.keys(hooks).sort(), ['context', 'execute.after', 'execute.before', 'prompt']);
  assert.equal(added.length, 13);
  const noteTool = added.find(d => d.name === 'trace_note');
  const report = await noteTool.execute({ kind: 'fact', text: 'x', source_refs: [] }, host());
  assert.equal(report.metadata.raw.ok, false);
  assert.match(report.title, /trace_note failed/);
  assert.match(report.content, /native execution is unaffected/);
  await cleanup();
});
