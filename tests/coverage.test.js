// Phase C qualification (V2 revision): scoped coverage, partial reconciliation,
// marker watermark advancement, durable gap evidence.
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
  t.after(async () => { await trace.store.close(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); });
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
  assert.equal(store.coverage.status().status, 'complete');
  assert.equal(store.coverage.statusFor('s1').session_coverage.status, 'complete');
});

test('C2/C3: a sequence jump becomes a durable range marker (single + multi-event)', async t => {
  const { store } = await fixture(t);
  await store.record('probe.a', { sessionID: 's1' }, { i: 1 });
  await store.record('probe.a', { sessionID: 's1' }, { i: 2 });
  await craft(store, 's1', { event_schema: 2, session_seq: 5 }); // skips 3,4
  await store.coverage.flushPending();
  const markers = store.findEntriesAll({ type: 'trace.capture_gap' });
  assert.equal(markers.length, 1);
  const payload = JSON.parse(await store.readBlob(markers[0].payloadRef));
  assert.deepEqual(payload.ranges, [{ from: 3, to: 4 }]);
  assert.equal(payload.unresolved_count, 2);
  const scoped = store.coverage.statusFor('s1');
  assert.equal(scoped.session_coverage.status, 'incomplete');
  assert.equal(scoped.session_coverage.unresolved_seqs, 2);
});

test('W1: full coverage -> complete; W8: no-match + complete distinguishes from W9', async t => {
  const { trace } = await fixture(t);
  const found = await trace.find({ text: 'no-such-marker-xyz-42' });
  assert.deepEqual(found.matches ?? found.results, []);
  assert.equal(found.coverage.capture.status, 'complete');
});

test('W9: no-match within an incomplete session reports scoped incompleteness', async t => {
  const { trace, store } = await fixture(t);
  await store.record('probe.a', { sessionID: 'sA' }, { i: 1 });
  await craft(store, 'sA', { event_schema: 2, session_seq: 9 }); // gap in sA
  await store.coverage.flushPending();
  const inSession = await trace.find({ text: 'no-such-marker-xyz-42', session: 'sA' });
  assert.equal(inSession.coverage.capture.session_coverage.status, 'incomplete');
  const otherSession = await trace.find({ text: 'no-such-marker-xyz-42', session: 'sB' });
  assert.equal(otherSession.coverage.capture.session_coverage.status, 'complete', 'unrelated session is NOT poisoned by sA gap');
  assert.equal(otherSession.coverage.capture.workspace_global.status, 'incomplete', 'workspace-global uncertainty stays visible');
});

test('3A-partial: recovering seq 3 of gap 3..4 leaves 4..4 unresolved', async t => {
  const { store } = await fixture(t);
  await store.record('probe.a', { sessionID: 's1' }, { i: 1 });
  await store.record('probe.a', { sessionID: 's1' }, { i: 2 });
  await craft(store, 's1', { event_schema: 2, session_seq: 5 }); // gap 3..4
  await store.coverage.flushPending();
  await craft(store, 's1', { event_schema: 2, session_seq: 3 }); // partial backfill
  await store.coverage.flushPending();
  const markers = store.findEntriesAll({ type: 'trace.capture_gap' });
  const payloads = [];
  for (const m of markers) payloads.push(JSON.parse(await store.readBlob(m.payloadRef)));
  const detected = payloads.find(p => p.status === 'detected');
  assert.ok(detected, 'original detected marker preserved');
  const followup = payloads.find(p => p.status === 'partially_reconciled');
  assert.ok(followup, 'partial reconciliation recorded');
  assert.deepEqual(followup.remaining, [{ from: 4, to: 4 }], 'remaining loss stays visible');
  const scoped = store.coverage.statusFor('s1');
  assert.equal(scoped.session_coverage.unresolved_seqs, 1, 'only seq 4 remains unresolved');
  assert.equal(scoped.session_coverage.status, 'incomplete');
});

test('3A-full: recovering every missing seq reconciles the whole marker', async t => {
  const { store } = await fixture(t);
  await store.record('probe.a', { sessionID: 's1' }, { i: 1 });
  await store.record('probe.a', { sessionID: 's1' }, { i: 2 });
  await craft(store, 's1', { event_schema: 2, session_seq: 5 }); // gap 3..4
  await store.coverage.flushPending();
  await craft(store, 's1', { event_schema: 2, session_seq: 4 });
  await craft(store, 's1', { event_schema: 2, session_seq: 3 }); // out-of-order backfill
  await store.coverage.flushPending();
  const payloads = [];
  for (const m of store.findEntriesAll({ type: 'trace.capture_gap' })) payloads.push(JSON.parse(await store.readBlob(m.payloadRef)));
  assert.ok(payloads.some(p => p.status === 'detected'), 'original marker preserved');
  assert.ok(payloads.some(p => p.status === 'reconciled'), 'full reconciliation recorded');
  assert.equal(store.coverage.statusFor('s1').session_coverage.status, 'complete');
  assert.equal(store.coverage.statusFor('s1').session_coverage.unresolved_seqs, 0);
});

test('3A-multi: out-of-order backfill across a wide gap splits ranges correctly', async t => {
  const { store } = await fixture(t);
  await store.record('probe.a', { sessionID: 's1' }, { i: 1 });
  await craft(store, 's1', { event_schema: 2, session_seq: 8 }); // gap 2..7
  await store.coverage.flushPending();
  await craft(store, 's1', { event_schema: 2, session_seq: 5 }); // middle -> [2..4] [6..7]
  await store.coverage.flushPending();
  let scoped = store.coverage.statusFor('s1');
  assert.equal(scoped.session_coverage.unresolved_seqs, 5);
  await craft(store, 's1', { event_schema: 2, session_seq: 2 }); // head
  await craft(store, 's1', { event_schema: 2, session_seq: 7 }); // tail (out of order)
  await store.coverage.flushPending();
  scoped = store.coverage.statusFor('s1');
  assert.equal(scoped.session_coverage.unresolved_seqs, 3, 'only 3,4,6 remain');
});

test('3B: gap markers advance the watermark (marker seq never looks missing)', async t => {
  const { store } = await fixture(t);
  // Ten ordinary events allocated through the allocator: seqs 1..10.
  for (let s = 1; s <= 10; s++) await store.record('probe.a', { sessionID: 'sM' }, { n: s });
  // A known loss at 7..8 recorded explicitly (simulating detected capture loss).
  // noteGap itself persists the durable marker event, which consumes the next
  // allocator slot (11). Flush first so the allocation is deterministic: an
  // extra manual marker write here used to race the async noteGap write and
  // shift every later expectation (test defect; product behavior is correct).
  store.coverage.noteGap({ session: 'sM', from_seq: 7, to_seq: 8, reason: 'capture_gap', component: 'sequence' });
  await store.coverage.flushPending();
  const markers = store.findEntriesAll({ type: 'trace.capture_gap', session: 'sM' });
  assert.equal(markers.length, 1, 'noteGap wrote exactly one durable marker');
  assert.equal(markers[0].seq, 11, 'marker occupies the next allocator slot');
  // Ordinary seq 12 afterwards must NOT be reported as missing 11.
  const after = await store.record('probe.a', { sessionID: 'sM' }, { afterMarker: true });
  assert.equal(after.session_seq, 12);
  await store.coverage.flushPending();
  const gapPayloads = [];
  for (const m of store.findEntriesAll({ type: 'trace.capture_gap', session: 'sM' })) gapPayloads.push(JSON.parse(await store.readBlob(m.payloadRef)));
  const claimsMissing11 = gapPayloads.some(p => (p.ranges ?? []).some(r => r.from <= 11 && r.to >= 11));
  assert.equal(claimsMissing11, false, 'seq 11 is the durable marker event, not a gap');
  const lossMarker = gapPayloads.find(p => (p.ranges ?? []).some(r => r.from === 7 && r.to === 8));
  assert.ok(lossMarker, 'the genuinely-detected 7..8 loss stays recorded');
});

test('3C: coverage is session-scoped; unrelated stale sessions do not poison queries', async t => {
  const { trace, store } = await fixture(t);
  await store.record('probe.a', { sessionID: 'fresh' }, { i: 1 });
  // A REAL detected loss in a legacy session: continuity baseline first, then
  // a jump (2..98 missing). Coverage detects gaps at watermark transitions —
  // a lone first event establishes the baseline and proves nothing by itself.
  await store.record('probe.a', { sessionID: 'stale-legacy' }, { i: 1 });
  await craft(store, 'stale-legacy', { event_schema: 2, session_seq: 99 });
  await store.coverage.flushPending();
  const found = await trace.find({ text: 'no-such-thing-913', session: 'fresh' });
  assert.equal(found.coverage.capture.session_coverage.status, 'complete', 'fresh session queries are complete');
  assert.equal(found.coverage.capture.workspace_global.status, 'incomplete', 'global uncertainty remains visible');
});

test('3A-restart: partial reconciliation survives restart (remaining range preserved)', async t => {
  const { store, dir } = await fixture(t);
  await store.record('probe.a', { sessionID: 's1' }, { i: 1 });
  await store.record('probe.a', { sessionID: 's1' }, { i: 2 });
  await craft(store, 's1', { event_schema: 2, session_seq: 5 }); // gap 3..4
  await store.coverage.flushPending();
  await craft(store, 's1', { event_schema: 2, session_seq: 3 }); // partial backfill -> 4..4 remains
  await store.coverage.flushPending();
  store.close();
  const store2 = await new Store(path.join(dir), path.join(dir, 'store')).init();
  try {
    const scoped = store2.coverage.statusFor('s1');
    assert.equal(scoped.session_coverage.status, 'incomplete', 'partial recovery stays incomplete across restart');
    assert.equal(scoped.session_coverage.unresolved_seqs, 1, 'only seq 4 remains unresolved after restart');
  } finally { store2.close(); }
});

test('C6: full directory reconcile reconciles watcher gaps; original marker remains', async t => {
  const { store } = await fixture(t);
  store.noteWatcherMiss(); // notification loss, unknown extent
  await store.coverage.flushPending();
  assert.equal(store.coverage.statusFor('s1').workspace_global.status, 'incomplete', 'watcher miss -> incomplete');
  // Events persisted while notifications were lost; a complete authoritative
  // directory scan imports (dedupes) them and is the reconciliation evidence.
  await store.record('probe.a', { sessionID: 's1' }, { late: 1 });
  await store.reconcile();
  const payloads = [];
  for (const m of store.findEntriesAll({ type: 'trace.capture_gap' })) payloads.push(JSON.parse(await store.readBlob(m.payloadRef)));
  assert.ok(payloads.some(p => p.status === 'detected' && p.reason === 'watcher_gap'), 'original marker preserved');
  assert.ok(payloads.some(p => p.status === 'reconciled' && p.reason === 'watcher_gap'), 'reconciliation marker recorded');
  assert.equal(store.coverage.statusFor('s1').workspace_global.status, 'complete', 'loss recovered by full scan');
});

test('C4: watcher overflow becomes counted, durable workspace-global evidence', async t => {
  const { store } = await fixture(t);
  store.noteWatcherMiss();
  store.noteWatcherMiss();
  await store.coverage.flushPending();
  assert.equal(store.missedWatchEvents, 2);
  assert.equal(store.coverage.counters.missed_watcher_total, 2);
  assert.equal(store.coverage.statusFor('any-session').workspace_global.known_gaps >= 1, true, 'watcher gap marker present (deduped)');
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
  assert.equal(store.coverage.statusFor('sC5').session_coverage.known_gaps, 1);
});

test('C7: restart rebuilds coverage state from durable markers (ranges preserved)', async t => {
  const { store, dir } = await fixture(t);
  await store.record('probe.a', { sessionID: 's1' }, { i: 1 });
  await craft(store, 's1', { event_schema: 2, session_seq: 9 }); // gap 2..8
  await store.coverage.flushPending();
  store.close();
  const store2 = await new Store(path.join(dir), path.join(dir, 'store')).init();
  try {
    const scoped = store2.coverage.statusFor('s1');
    assert.equal(scoped.session_coverage.status, 'incomplete');
    assert.deepEqual(scoped.session_coverage.known_gaps, 1);
  } finally { store2.close(); }
});

test('C7b: a follow-up shrinks exactly its own marker after restart; siblings untouched (F3)', async t => {
  const { store, dir } = await fixture(t);
  // Two sibling gaps in the SAME session with the SAME reason.
  await store.record('probe.a', { sessionID: 's1' }, { i: 1 });
  await craft(store, 's1', { event_schema: 2, session_seq: 5 }); // gap 2..4
  await craft(store, 's1', { event_schema: 2, session_seq: 9 }); // gap 6..8
  await store.coverage.flushPending();
  // Reconcile one sequence of the FIRST gap only (splits it to 3..4).
  await craft(store, 's1', { event_schema: 2, session_seq: 2 });
  await store.coverage.flushPending();
  assert.equal(store.coverage.statusFor('s1').session_coverage.unresolved_seqs, 5, '3,4,6,7,8 before restart');
  store.close();
  const store2 = await new Store(path.join(dir), path.join(dir, 'store')).init();
  try {
    const scoped = store2.coverage.statusFor('s1');
    // The follow-up must shrink ONLY the marker it reconciles: 3..4 from the
    // first marker plus the untouched sibling 6..8. A session+reason broadcast
    // would have corrupted the sibling with the first marker's remaining set.
    assert.equal(scoped.session_coverage.unresolved_seqs, 5, 'sibling markers keep their own ranges after restart');
    assert.equal(scoped.session_coverage.known_gaps, 2, 'both sibling markers remain');
    assert.equal(scoped.session_coverage.status, 'incomplete');
  } finally { store2.close(); }
});

test('C12: V2-A handles unaffected by coverage machinery', async t => {
  const { trace } = await fixture(t);
  await trace.after({ sessionID: 's1', messageID: 'm1', id: 'c1', agent: 'build', tool: 'shell', input: { command: 'c12' }, status: 'completed', result: { output: 'ok c12' } });
  const { assignments } = trace.recallSnapshot('s1');
  trace.handles.newGeneration('s1', assignments ?? []);
  assert.equal(trace.handles.resolve('s1', 'e1').ok, true);
});

test('C13: runtime-context stays late; scoped warning compact when incomplete', async t => {
  const { trace, store } = await fixture(t);
  const clean = await trace.context({ sessionID: 's1', messages: [], agent: 'build', model: { providerID: 'local-qwen-auto', id: '27b-dense' } });
  assert.match(clean.recall, /^OPENCODE_TRACE_RECALL_V1/);
  assert.equal(clean.snapshot.capture_coverage, undefined, 'no coverage noise when complete');
  await craft(store, 's1', { event_schema: 2, session_seq: 9 });
  await store.coverage.flushPending();
  const warned = await trace.context({ sessionID: 's1', messages: [], agent: 'build', model: { providerID: 'local-qwen-auto', id: '27b-dense' } });
  assert.match(warned.recall, /^OPENCODE_TRACE_RECALL_V1/);
  assert.equal(warned.snapshot.capture_coverage?.status, 'incomplete');
});

test('status tool exposes scoped capture_coverage', async t => {
  const { trace } = await fixture(t);
  const status = await definitions(trace).find(d => d.name === 'trace_status').execute({}, host());
  assert.equal(status.metadata.raw.ok, true);
  assert.ok(status.metadata.raw.capture_coverage.session === 's1');
  assert.equal(typeof status.metadata.raw.capture_coverage.session_coverage.status, 'string');
});
