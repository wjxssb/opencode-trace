// Phase C qualification: coverage watermarks + explicit gap semantics.
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-trace-cov-'));
  const trace = new Trace({ location: { directory: dir } }, { storeRoot: path.join(dir, 'store') });
  await trace.ready;
  t.after(async () => { trace.store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, trace, store: trace.store };
}
const host = (sessionID = 's1') => ({ sessionID, messageID: 'm1', id: 'c1', agent: 'build' });
async function craft(store, sessionID, body) {
  const payload = await store.blob({ craft: true });
  const full = { schema: 1, workspaceID: store.workspaceID, type: 'probe.craft', host: { sessionID }, payload: { ref: payload.ref, bytes: payload.bytes, encoding: 'json', sha256: payload.sha256 }, ...body };
  const ref = `evt_${hash(stable(full))}`;
  const event = { ...full, ref, at: Date.now() };
  await atomic(path.join(store.root, 'events', `${ref}.json`), stable(event), true);
  await store.ingest(event);
  return event;
}

test('C1: fresh store reports complete coverage', async t => {
  const { store } = await fixture(t);
  await store.record('probe.a', { sessionID: 's1' }, { i: 1 });
  const status = store.coverage.status();
  assert.equal(status.status, 'complete');
  assert.equal(status.known_gaps, 0);
});

test('C2: a sequence jump becomes a durable trace.capture_gap marker', async t => {
  const { store } = await fixture(t);
  await store.record('probe.a', { sessionID: 's1' }, { i: 1 });
  await store.record('probe.a', { sessionID: 's1' }, { i: 2 });
  await craft(store, 's1', { event_schema: 2, session_seq: 5 }); // skips 3,4
  await store.coverage.flushPending();
  const markers = store.findEntriesAll({ type: 'trace.capture_gap' });
  assert.equal(markers.length, 1);
  const payload = JSON.parse(await store.readBlob(markers[0].payloadRef));
  assert.deepEqual([payload.from_seq, payload.to_seq], [3, 4]);
  assert.equal(payload.reason, 'capture_gap');
  const status = store.coverage.status();
  assert.equal(status.status, 'incomplete');
  assert.equal(status.known_gaps, 1);
});

test('C3: multi-event loss is recorded as an explicit range', async t => {
  const { store } = await fixture(t);
  await store.record('probe.a', { sessionID: 's1' }, { i: 1 });
  await store.record('probe.a', { sessionID: 's1' }, { i: 2 });
  await craft(store, 's1', { event_schema: 2, session_seq: 10 });
  await store.coverage.flushPending();
  const markers = store.findEntriesAll({ type: 'trace.capture_gap' });
  const payload = JSON.parse(await store.readBlob(markers[0].payloadRef));
  assert.deepEqual([payload.from_seq, payload.to_seq], [3, 9], 'range loss recorded as from..to');
});

test('C4: watcher overflow becomes counted, durable gap evidence', async t => {
  const { store } = await fixture(t);
  store.noteWatcherMiss();
  store.noteWatcherMiss();
  await store.coverage.flushPending();
  assert.equal(store.missedWatchEvents, 2);
  assert.equal(store.coverage.counters.missed_watcher_total, 2);
  assert.equal(store.coverage.status().known_gaps >= 1, true, 'watcher gap marker present (deduped)');
});

test('C5: writer failure keeps the marker pending, then flush recovers it', async t => {
  const { store } = await fixture(t);
  const original = store.record.bind(store);
  let fail = false;
  store.record = (...args) => {
    if (fail && args[0] === 'trace.capture_gap') return Promise.reject(new Error('simulated disk full'));
    return original(...args);
  };
  fail = true;
  store.coverage.noteGap({ session: 'sC5', from_seq: 5, to_seq: 5, reason: 'writer_failure' });
  await store.coverage.flushPending();
  store.record = original;
  await store.coverage.flushPending();
  const markers = store.findEntriesAll({ type: 'trace.capture_gap', session: 'sC5' });
  assert.equal(markers.length, 1, 'marker survived the writer failure via pending retry');
  assert.equal(store.coverage.status().known_gaps, 1);
});

test('C6: reconciliation keeps the original marker and adds a follow-up', async t => {
  const { store } = await fixture(t);
  await store.record('probe.a', { sessionID: 's1' }, { i: 1 });
  await store.record('probe.a', { sessionID: 's1' }, { i: 2 });
  await craft(store, 's1', { event_schema: 2, session_seq: 5 }); // gap 3..4
  await store.coverage.flushPending();
  await craft(store, 's1', { event_schema: 2, session_seq: 3 }); // backfill one missing seq
  await store.coverage.flushPending();
  const markers = store.findEntriesAll({ type: 'trace.capture_gap' });
  const payloads = [];
  for (const m of markers) payloads.push(JSON.parse(await store.readBlob(m.payloadRef)));
  const detected = payloads.filter(p => p.status === 'detected');
  const reconciled = payloads.filter(p => p.status === 'reconciled');
  assert.equal(detected.length, 1, 'original gap marker preserved (never deleted)');
  assert.equal(reconciled.length, 1, 'reconciliation recorded as follow-up evidence');
  assert.equal(reconciled[0].reconciles_seq, 3);
  const status = store.coverage.status();
  assert.equal(status.known_gaps, 0, 'range 3..4 partially reconciled at seq 3 leaves no unresolved whole-marker');
  assert.equal(status.reconciled_gaps, 1);
});

test('C7: restart rebuilds coverage state from durable markers', async t => {
  const { store, dir } = await fixture(t);
  await store.record('probe.a', { sessionID: 's1' }, { i: 1 });
  await craft(store, 's1', { event_schema: 2, session_seq: 9 }); // gap 2..8
  await store.coverage.flushPending();
  store.close();
  const store2 = await new Store(path.join(dir), path.join(dir, 'store')).init();
  try {
    const status = store2.coverage.status();
    assert.equal(status.status, 'incomplete', 'coverage survives restart via durable markers');
    assert.equal(status.known_gaps, 1);
  } finally { store2.close(); }
});

test('C8: no-match with complete coverage says so', async t => {
  const { trace } = await fixture(t);
  const found = await trace.find({ text: 'no-such-marker-xyz-42' });
  assert.deepEqual(found.matches ?? found.results, []);
  assert.equal(found.coverage.capture.status, 'complete');
});

test('C9: no-match with known gaps refuses to establish absence', async t => {
  const { trace, store } = await fixture(t);
  await store.record('probe.a', { sessionID: 's1' }, { i: 1 });
  await craft(store, 's1', { event_schema: 2, session_seq: 9 });
  await store.coverage.flushPending();
  const found = await trace.find({ text: 'no-such-marker-xyz-42' });
  assert.deepEqual(found.matches ?? found.results, []);
  assert.equal(found.coverage.capture.status, 'incomplete');
  assert.ok(found.coverage.capture.known_gaps >= 1);
});

test('C10/C11: trace_status exposes capture_coverage for Reviewer/Supervisor consumption', async t => {
  const { trace, store } = await fixture(t);
  await store.record('probe.a', { sessionID: 's1' }, { i: 1 });
  await craft(store, 's1', { event_schema: 2, session_seq: 7 });
  await store.coverage.flushPending();
  const status = await definitions(trace).find(d => d.name === 'trace_status').execute({}, host());
  assert.equal(status.metadata.raw.ok, true);
  assert.equal(status.metadata.raw.capture_coverage.status, 'incomplete');
  assert.ok(status.metadata.raw.capture_coverage.known_gaps >= 1);
});

test('C12: V2-A handles unaffected by coverage machinery', async t => {
  const { trace } = await fixture(t);
  await trace.after({ sessionID: 's1', messageID: 'm1', id: 'c1', agent: 'build', tool: 'shell', input: { command: 'c12' }, status: 'completed', result: { output: 'ok c12' } });
  const { assignments } = trace.recallSnapshot('s1');
  trace.handles.newGeneration('s1', assignments ?? []);
  assert.equal(trace.handles.resolve('s1', 'e1').ok, true);
});

test('C13: runtime-context stays late; capture warning appears only when incomplete', async t => {
  const { trace } = await fixture(t);
  const clean = await trace.context({ sessionID: 's1', messages: [], agent: 'build', model: { providerID: 'local-qwen-auto', id: '27b-dense' } });
  assert.match(clean.recall, /^OPENCODE_TRACE_RECALL_V1/);
  assert.equal(clean.snapshot.capture_coverage, undefined, 'no coverage noise when complete');
  await craft(trace.store, 's1', { event_schema: 2, session_seq: 9, __jump: true });
  await trace.store.coverage.flushPending();
  const warned = await trace.context({ sessionID: 's1', messages: [], agent: 'build', model: { providerID: 'local-qwen-auto', id: '27b-dense' } });
  assert.match(warned.recall, /^OPENCODE_TRACE_RECALL_V1/);
  assert.ok(warned.snapshot.capture_coverage?.status === 'incomplete' || warned.recall.includes('incomplete'), 'compact warning when incomplete');
});
