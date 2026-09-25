// Phase B qualification: causal event graph + session continuity.
// Internal integrity/continuity evidence — NOT external attestation.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Trace } from '../src/trace.js';
import { Store } from '../src/store.js';
import { definitions } from '../src/tools.js';
import { atomic, hash, stable } from '../src/util.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-trace-causal-'));
  const trace = new Trace({ location: { directory: dir } }, { storeRoot: path.join(dir, 'store') });
  await trace.ready;
  t.after(async () => { await trace.store.close(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); });
  return { dir, trace, store: trace.store };
}
const host = (sessionID = 's1') => ({ sessionID, messageID: 'm1', id: 'c1', agent: 'build' });
const seqsOf = async (store, sessionID) => {
  const rows = store.findEntriesAll({ session: sessionID });
  const seqs = [];
  for (const row of rows) {
    const ev = await store.readEvent(row.ref).catch(() => null);
    if (ev?.session_seq != null) seqs.push(ev.session_seq);
  }
  return seqs.sort((a, b) => a - b);
};
async function craft(store, sessionID, body) {
  const payload = await store.blob({ craft: true });
  const full = { schema: 1, workspaceID: store.workspaceID, type: 'probe.craft', host: { sessionID }, payload: { ref: payload.ref, bytes: payload.bytes, encoding: 'json', sha256: payload.sha256 }, ...body };
  const ref = `evt_${hash(stable(full))}`;
  const event = { ...full, ref, at: Date.now() };
  await atomic(path.join(store.root, 'events', `${ref}.json`), stable(event), true);
  await store.ingest(event);
  return event;
}

test('B1: session sequence is monotonic per session', async t => {
  const { store } = await fixture(t);
  for (let i = 0; i < 5; i++) await store.record('probe.a', { sessionID: 's1' }, { i });
  assert.deepEqual(await seqsOf(store, 's1'), [1, 2, 3, 4, 5]);
});

test('B2: concurrent allocation stays race-safe (unique, gap-free seqs)', async t => {
  const { store } = await fixture(t);
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.record('probe.c', { sessionID: 's2' }, { i })));
  assert.deepEqual(await seqsOf(store, 's2'), Array.from({ length: 20 }, (_, i) => i + 1));
});

test('B3: previous_event_ref forms a continuous chain', async t => {
  const { store } = await fixture(t);
  const refs = [];
  for (let i = 0; i < 4; i++) refs.push((await store.record('probe.a', { sessionID: 's1' }, { i })).ref);
  for (let i = 1; i < refs.length; i++) {
    const ev = await store.readEvent(refs[i]);
    assert.equal(ev.previous_event_ref, refs[i - 1], `event ${i} must chain to its predecessor`);
  }
  assert.equal((await store.readEvent(refs[0])).previous_event_ref ?? null, null);
});

test('B4: tool.after caused_by its tool.before', async t => {
  const { trace } = await fixture(t);
  const e = { sessionID: 's1', messageID: 'm1', id: 'call-1', agent: 'build', tool: 'shell', input: { command: 'x' } };
  await trace.before(e);
  const after = await trace.after({ ...e, status: 'completed', result: { output: 'ok' } });
  assert.ok(after.caused_by, 'tool.after must carry caused_by');
  const before = await trace.store.readEvent(after.caused_by);
  assert.equal(before.type, 'tool.before');
  assert.equal(before.callKey, after.callKey);
});

test('B5: chain continuity spans mixed event kinds (prompt -> tool -> message)', async t => {
  const { trace, store } = await fixture(t);
  const a = await store.record('prompt.received', { sessionID: 's1' }, { text: 'q' });
  const b = await store.record('tool.before', { sessionID: 's1', id: 'k1' }, { tool: 'shell' });
  const c = await store.record('message.persisted', { sessionID: 's1' }, { role: 'assistant' });
  for (const [prev, next] of [[a.ref, b.ref], [b.ref, c.ref]]) {
    const ev = await store.readEvent(next);
    assert.equal(ev.previous_event_ref, prev);
  }
  const verdict = await trace.verifyChain('s1');
  assert.equal(verdict.ok, true);
});

test('B6: attempt identity preserved on retry-shaped events', async t => {
  const { store } = await fixture(t);
  const started1 = await store.record('trace.step', { sessionID: 'w1' }, { state: 'started', attempt_id: 'a1' }, { plan_id: 'p', step: 's1' });
  const started2 = await store.record('trace.step', { sessionID: 'w1' }, { state: 'started', attempt_id: 'a2' }, { plan_id: 'p', step: 's1' });
  assert.notEqual(started1.ref, started2.ref, 'different attempts are distinct events');
  assert.equal(JSON.parse(await store.readBlob(started1.payload.ref)).attempt_id, 'a1');
  assert.equal(JSON.parse(await store.readBlob(started2.payload.ref)).attempt_id, 'a2');
  const result = await store.record('trace.step.result', { sessionID: 'w1' }, { status: 'success', attempt_id: 'a2' }, { plan_id: 'p', step: 's1', caused_by: started2.ref });
  assert.equal(result.caused_by, started2.ref, 'result causally linked to its attempt');
});

test('B7: parent_event_ref containment + expand children projection', async t => {
  const { store } = await fixture(t);
  const parent = await store.record('probe.parent', { sessionID: 's1' }, { n: 0 });
  const child = await store.record('probe.child', { sessionID: 's1' }, { n: 1 }, { parent_event_ref: parent.ref });
  assert.equal(child.parent_event_ref, parent.ref);
  const view = await store.expand(parent.ref, 0, 2048, true);
  assert.deepEqual(view.children, [child.ref]);
  assert.equal(view.causal.session_seq, parent.session_seq);
});

test('B8: legacy v1 events (no causal fields) remain valid and readable', async t => {
  const { store, trace } = await fixture(t);
  await craft(store, 's1', { session_seq: undefined });
  const rows = store.findEntriesAll({ type: 'probe.craft', session: 's1' });
  const ev = await store.readEvent(rows[0].ref);
  assert.equal(ev.session_seq, undefined, 'crafted v1 event carries no causal fields');
  assert.equal(ev.event_schema, undefined);
  const verdict = await trace.verifyChain('s1');
  assert.equal(verdict.legacy_v1_events, 1);
  assert.equal(verdict.ok, true, 'legacy events do not break chain verification');
});

test('B9: lost event and source are visibly incomplete despite durable admission', async t => {
  const { store, dir } = await fixture(t);
  const refs = [];
  for (let i = 0; i < 3; i++) refs.push((await store.record('probe.a', { sessionID: 's1' }, { i })).ref);
  const eventsDir = path.join(store.root, 'events'); // store.root = <storeRoot>/workspaces/<workspaceHash>
  const missing = await store.readEvent(refs[1]);
  await store.close();
  await fs.unlink(path.join(eventsDir, `${refs[1]}.json`)); // seq 2 disappears
  await fs.unlink(path.join(store.root, 'blobs', missing.payload.sha256.slice(0, 2), missing.payload.sha256));
  const store2 = await new Store(path.join(dir), path.join(dir, 'store')).init();
  try {
    const trace2 = new Trace({ location: { directory: dir } }, { storeRoot: path.join(dir, 'store') });
    await trace2.ready;
    const verdict = await trace2.verifyChain('s1');
    assert.equal(store2.admissions.recovery.incomplete.length, 1);
    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.gaps, [[2, 2]], 'the unpersisted/deleted sequence is reported as a gap');
    assert.ok(verdict.missing.length >= 1, 'the child pointing at the deleted node reports a missing link');
  } finally { store2.close(); }
});

test('B10: backward (cycle-shaped) causal edge is detected', async t => {
  const { store, trace } = await fixture(t);
  const later = await craft(store, 's1', { event_schema: 2, session_seq: 60 });
  await craft(store, 's1', { event_schema: 2, session_seq: 50, previous_event_ref: later.ref });
  const verdict = await trace.verifyChain('s1');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.cycles.length, 1, 'previous edge pointing forward in seq is a detected cycle-shaped violation');
});

test('B10b: cross-session chain link is rejected by verification', async t => {
  const { store, trace } = await fixture(t);
  const foreign = await store.record('probe.a', { sessionID: 'other' }, { x: 1 });
  await craft(store, 's1', { event_schema: 2, session_seq: 9, previous_event_ref: foreign.ref });
  const verdict = await trace.verifyChain('s1');
  assert.equal(verdict.cross_session.length, 1, 'previous edge into another session is invalid');
  assert.equal(verdict.ok, false);
});

test('B11: restart continues the session sequence from the durable watermark', async t => {
  const { store, dir } = await fixture(t);
  for (let i = 0; i < 3; i++) await store.record('probe.a', { sessionID: 's3' }, { i });
  store.close();
  const store2 = await new Store(path.join(dir), path.join(dir, 'store')).init();
  try {
    const next = await store2.record('probe.a', { sessionID: 's3' }, { restarted: true });
    assert.equal(next.session_seq, 4, 'allocator resumes from durable state');
    assert.match(next.previous_event_ref ?? '', /^evt_[a-f0-9]{64}$/);
  } finally { store2.close(); }
});

test('B12: canonical event hashes still verify (readEvent integrity intact)', async t => {
  const { store } = await fixture(t);
  const refs = [];
  for (let i = 0; i < 3; i++) refs.push((await store.record('probe.a', { sessionID: 's1' }, { i })).ref);
  for (const ref of refs) {
    const ev = await store.readEvent(ref); // throws on integrity mismatch
    assert.equal(ev.ref, ref);
  }
  await assert.rejects(() => store.readEvent('evt_' + '0'.repeat(64)), /not found|unreadable/);
});

test('B13: V2-A handles still resolve correctly alongside causality', async t => {
  const { trace } = await fixture(t);
  await trace.after({ sessionID: 's1', messageID: 'm1', id: 'c1', agent: 'build', tool: 'shell', input: { command: 'b13' }, status: 'completed', result: { output: 'ok b13' } });
  const { assignments } = trace.recallSnapshot('s1');
  trace.handles.newGeneration('s1', assignments ?? []);
  const canonical = assignments.find(a => a.handle === 'e1').ref;
  const resolved = trace.handles.resolve('s1', 'e1');
  assert.equal(resolved.ok, true);
  assert.equal(resolved.ref, canonical);
  const out = await definitions(trace).find(d => d.name === 'trace_expand').execute({ ref: 'e1' }, { sessionID: 's1', agent: 'build' });
  assert.equal(out.metadata.raw.ok, true);
  assert.equal(out.metadata.raw.hash_verified, true);
});

test('B14: runtime-context contract unchanged (late injection, marker, handles block)', async t => {
  const { trace } = await fixture(t);
  await trace.after({ sessionID: 's1', messageID: 'm1', id: 'c1', agent: 'build', tool: 'shell', input: { command: 'b14' }, status: 'completed', result: { output: 'ok b14' } });
  const { recall } = await trace.context({ sessionID: 's1', messages: [], agent: 'build', model: { providerID: 'local-qwen-auto', id: '27b-dense' } });
  assert.match(recall, /^OPENCODE_TRACE_RECALL_V1/);
  assert.ok(recall.includes('EVIDENCE HANDLES'), 'handle block still delivered late');
  assert.equal(trace.handles.resolve('s1', 'e1').ok, true, 'context() installed the turn generation');
  assert.ok(typeof recall === 'string' && recall.length < 20000, 'bounded recall');
});
