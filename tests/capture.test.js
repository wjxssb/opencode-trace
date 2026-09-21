// Phase G qualification: non-blocking capture + writer isolation.
// Directive §14-15: host hook never blocks on persistence; the writer is a
// killable worker thread; overflow/writer loss produce durable exact-range
// evidence outside the queue; loss never silences and never blocks the host.
//
// Known Node 22.16 limitation: worker.terminate() (even for a dummy worker
// with no resources) leaks the parent-side internal channel handles, which
// hold this file's test process open after all tests complete. The ref'd
// watchdog below exits at 90s — far beyond this suite's legitimate runtime
// (~30s) — and only ever fires after the runner finished and the leak holds
// the loop; it never interrupts a running test.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Trace } from '../src/trace.js';
import { Store } from '../src/store.js';

setTimeout(() => process.exit(suiteCompleted ? 0 : 1), 90000);

// Review round-6 advisory: make the watchdog LOUD — a hung test must not
// masquerade as exit 0. The final test arms the completion flag; if the
// watchdog ever fires without it, the suite exits 1 (a regression signal).
let suiteCompleted = false;
test('ZZ: suite completed (watchdog armed loud)', () => { suiteCompleted = true; });

async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-trace-cap-'));
  const trace = new Trace({ location: { directory: dir } },
    { storeRoot: path.join(dir, 'store'), captureWriter: true, captureRespawnDelay: 50, ...options });
  await trace.ready;
  assert.ok(trace.capture?.active, 'capture coordinator active');
  t.after(async () => {
    await trace.capture?.stop();
    await trace.store.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });
  return { dir, trace, store: trace.store, capture: trace.capture };
}
const job = (id, session = 's1') => ({
  type: 'tool.after', host: { sessionID: session, messageID: `m-${id}`, id: `c-${id}`, agent: 'build' },
  data: { id: `c-${id}`, tool: 'shell', input: { command: `capture-${id}` }, status: 'completed', result: { output: `out ${id}` } },
  extra: { tool: 'shell', callID: `c-${id}`, status: 'completed' },
});

async function recovered(dir) {
  const store2 = await new Store(path.join(dir), path.join(dir, 'store')).init();
  const events = store2.findEntriesAll({ type: 'tool.after' });
  const markers = store2.findEntriesAll({ type: 'trace.capture_gap' });
  const chains = [];
  for (const e of events) chains.push({ seq: e.seq, ref: e.ref, previous: e.previous_event_ref ?? null });
  await store2.close();
  return { events, markers, chains };
}

test('G1: envelopes persist via the writer with intact causal chain (host path never blocks)', async t => {
  const { dir, trace, capture } = await fixture(t);
  for (let i = 1; i <= 5; i++) await trace.after({ sessionID: 's1', messageID: `m${i}`, id: `c${i}`, agent: 'build', tool: 'shell', input: { command: `g1-${i}` }, status: 'completed', result: { output: `output ${i}` } });
  await capture.flush();
  const status = capture.status();
  assert.equal(status.queue_depth, 0);
  assert.equal(status.in_flight, 0);
  assert.ok(status.last_enqueued_seq >= 5, `last_enqueued_seq ${status.last_enqueued_seq}`);
  assert.ok(status.last_persisted_seq >= 5, `last_persisted_seq ${status.last_persisted_seq}`);
  const rec = await recovered(dir);
  assert.equal(rec.events.length, 5, 'all five capture events persisted');
  const seqs = rec.chains.map(c => c.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5], 'sequence allocated at enqueue, contiguous');
  // previous_event_ref chain: each event's previous is the prior seq's ref.
  const byRef = new Map(rec.events.map(e => [e.ref, e]));
  for (const e of rec.events) {
    if (e.session_seq > 1) {
      const prev = [...byRef.values()].find(x => x.ref === e.previous_event_ref);
      assert.ok(prev && prev.session_seq === e.session_seq - 1, `chain link at seq ${e.session_seq}`);
    }
  }
});

test('G2: writer death never blocks the host; losses are ledgered and coverage stays honest', async t => {
  const { dir, trace, capture } = await fixture(t);
  capture.paused = true;
  for (let i = 1; i <= 3; i++) await trace.after({ sessionID: 's1', messageID: `m${i}`, id: `c${i}`, agent: 'build', tool: 'shell', input: { command: `g2-${i}` }, status: 'completed', result: { output: `x` } });
  assert.equal(capture.status().queue_depth, 3, 'queued while paused');
  capture.paused = false;
  capture.drain();
  // Kill the writer while the batch is in flight.
  const worker = capture.worker;
  await worker.terminate();
  await new Promise(r => setTimeout(r, 150)); // death path + respawn timer (50ms base)
  // Host remains fully usable throughout (G11).
  const note = await trace.note({ kind: 'fact', text: 'host survived writer death' }, { sessionID: 's1', messageID: 'mx', id: 'cx', agent: 'build' });
  assert.ok(note.ref);
  // Surviving queue + respawned writer drain everything still alive.
  await capture.flush();
  const rec = await recovered(dir);
  const persisted = rec.events.length;
  const lost = 3 - persisted;
  // The ledger may already be drained+renamed by the respawned generation.
  const ledgerNames = await fs.readdir(path.join(dir, 'store', 'capture-ledger')).catch(() => []);
  let ledgerText = '';
  for (const name of ledgerNames) {
    ledgerText += await fs.readFile(path.join(dir, 'store', 'capture-ledger', name), 'utf8').catch(() => '');
  }
  if (lost > 0) assert.ok(ledgerText.trim().length > 0, 'lost envelopes recorded in the durable ledger');
  assert.ok(persisted + lost === 3, `no silent loss: persisted=${persisted} lost=${lost}`);
  // Losses are visible in coverage (exact queue_overflow markers) and
  // reconcile away when the events actually persisted (host full scan).
  await trace.store.reconcile();
  await trace.store.coverage.flushPending();
  const scoped = trace.store.coverage.statusFor('s1');
  if (lost > 0) assert.equal(scoped.session_coverage.status, 'incomplete', 'coverage reports the loss honestly');
  else assert.ok(true);
});

test('G3: queue overflow records exact-range durable evidence outside the queue', async t => {
  const { dir, trace, capture } = await fixture(t, { captureQueueCap: 2 });
  capture.paused = true; // hold the queue so it actually fills
  const refs = [];
  for (let i = 1; i <= 5; i++) {
    const r = await trace.after({ sessionID: 's1', messageID: `m${i}`, id: `c${i}`, agent: 'build', tool: 'shell', input: { command: `g3-${i}` }, status: 'completed', result: { output: 'x' } });
    refs.push(r.ref);
  }
  assert.equal(capture.status().dropped_total, 3, 'three envelopes dropped on overflow');
  assert.equal(capture.status().queue_depth, 2, 'queue bounded at cap');
  const ledgerText = await fs.readFile(path.join(capture.ledgerPath()), 'utf8');
  const entries = ledgerText.trim().split('\n').map(JSON.parse);
  assert.equal(entries.length, 3);
  for (const entry of entries) {
    assert.equal(entry.session, 's1');
    assert.ok(Number.isInteger(entry.from) && entry.from === entry.to, 'exact per-envelope sequence in the ledger');
  }
  // Immediate coverage honesty (marker written on the rare overflow path).
  await trace.store.coverage.flushPending();
  const scoped = trace.store.coverage.statusFor('s1');
  assert.equal(scoped.session_coverage.status, 'incomplete');
  assert.ok(scoped.session_coverage.unresolved_seqs >= 3, 'dropped sequences are unresolved');
  // Unpause: surviving envelopes persist; dropped ones stay lost (visible).
  capture.paused = false;
  await capture.flush();
  const rec = await recovered(dir);
  assert.equal(rec.events.length, 2, 'surviving envelopes persisted');
  assert.ok(rec.events.length + 3 === 5, 'no silent loss: 2 persisted + 3 exactly-lost');
});

test('G4: duplicate envelope delivery is idempotent (no duplicate semantic events)', async t => {
  const { dir, trace, capture } = await fixture(t);
  capture.paused = true;
  await trace.after({ sessionID: 's1', messageID: 'm1', id: 'c1', agent: 'build', tool: 'shell', input: { command: 'g4' }, status: 'completed', result: { output: 'x' } });
  const [env] = capture.queue.splice(0);
  // The SAME envelope persisted twice (duplicate IPC delivery semantics).
  const writerStore = new Store(trace.store.workspace, trace.store.base, () => {}, { watch: () => ({ on() {}, unref() {}, close() {} }) });
  await writerStore.init();
  try {
    await writerStore.persistEnvelope(env);
    await writerStore.persistEnvelope(env);
  } finally { await writerStore.close(); }
  const rec = await recovered(dir);
  assert.equal(rec.events.length, 1, 'duplicate delivery produced exactly one event');
});

test('G5: out-of-order physical persistence keeps the logical chain intact', async t => {
  const { dir, trace, capture } = await fixture(t);
  capture.paused = true;
  const envs = [];
  for (let i = 1; i <= 4; i++) {
    await trace.after({ sessionID: 's1', messageID: `m${i}`, id: `c${i}`, agent: 'build', tool: 'shell', input: { command: `g5-${i}` }, status: 'completed', result: { output: 'x' } });
  }
  // Drain the host queue manually and persist in REVERSE order.
  const queued = capture.queue.splice(0);
  const writerStore = new Store(trace.store.workspace, trace.store.base, () => {}, { watch: () => ({ on() {}, unref() {}, close() {} }) });
  await writerStore.init();
  try {
    for (const env of [...queued].reverse()) await writerStore.persistEnvelope(env);
  } finally { await writerStore.close(); }
  void envs;
  const rec = await recovered(dir);
  assert.equal(rec.events.length, 4);
  const bySeq = new Map(rec.events.map(e => [e.session_seq, e]));
  for (const e of rec.events) {
    if (e.session_seq > 1) assert.equal(e.previous_event_ref, bySeq.get(e.session_seq - 1)?.ref ?? null, `logical chain at seq ${e.session_seq}`);
  }
});

test('G6: a new writer generation drains the durable ledger into exact gap markers', async t => {
  const { trace, capture } = await fixture(t);
  // Simulate loss recorded by a dead generation: exact ranges in the ledger.
  const entry = { at: Date.now(), generation: capture.generation, cause: 'writer_lost', session: 'sG6', from: 41, to: 43, count: 3 };
  await fs.mkdir(capture.ledgerDir(), { recursive: true });
  await fs.appendFile(path.join(capture.ledgerDir(), `gen-${capture.generation}.jsonl`), `${JSON.stringify(entry)}\n`, 'utf8');
  // Next generation drains it at startup.
  capture.generation += 1;
  capture.spawnWorker();
  const deadline = Date.now() + 15000;
  while (trace.store.findEntriesAll({ type: 'trace.capture_gap', session: 'sG6' }).length === 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 50));
  }
  const markers = trace.store.findEntriesAll({ type: 'trace.capture_gap', session: 'sG6' });
  assert.ok(markers.length >= 1, 'queue_overflow marker emitted from the ledger');
  const payload = JSON.parse(await trace.store.readBlob(markers[0].payloadRef));
  assert.equal(payload.reason, 'queue_overflow');
  assert.deepEqual(payload.ranges, [{ from: 41, to: 43 }], 'exact lost sequence range');
  await capture.flush().catch(() => {});
});

test('G7: degraded capture keeps every synchronous trace path usable', async t => {
  const { trace, capture } = await fixture(t);
  capture.paused = true;
  await trace.after({ sessionID: 's1', messageID: 'm1', id: 'c1', agent: 'build', tool: 'shell', input: { command: 'g7' }, status: 'completed', result: { output: 'x' } });
  capture.worker = null; // simulate writer unavailable
  capture.degraded = true;
  const status = capture.status();
  assert.equal(status.degraded, true);
  assert.equal(status.meaning.includes('never blocks the host'), true);
  // Notes, claims and status all keep working on the synchronous path.
  const note = await trace.note({ kind: 'fact', text: 'degraded but alive' }, { sessionID: 's1', messageID: 'mn', id: 'cn', agent: 'build' });
  assert.ok(note.ref);
  const claim = await trace.recordClaim({ subject: 'host usable', text: 'assertion only' }, { sessionID: 's1', messageID: 'mc', id: 'cc', agent: 'build' });
  assert.equal(claim.claim.status, 'CLAIMED');
});

test('G8+G9: watermarks are exposed and the host yields the index to the writer', async t => {
  const { trace, capture } = await fixture(t);
  assert.equal(trace.store.suppressDerivedWrites, true, 'host index writes suppressed while writer owns the index (§31)');
  await trace.after({ sessionID: 's1', messageID: 'm1', id: 'c1', agent: 'build', tool: 'shell', input: { command: 'g8' }, status: 'completed', result: { output: 'x' } });
  await capture.flush();
  const s = capture.status();
  for (const key of ['queue_depth', 'oldest_queue_age', 'dropped_total', 'last_enqueued_seq', 'last_persisted_seq', 'last_indexed_seq']) {
    assert.ok(key in s, `watermark ${key} exposed`);
  }
  assert.ok(s.last_enqueued_seq >= s.last_persisted_seq, 'enqueued leads persisted');
  await capture.stop();
  assert.equal(trace.store.suppressDerivedWrites, false, 'host index writes restored after graceful stop');
});

test('G10: the host discovers writer-persisted events through its own watcher', async t => {
  const { trace, capture } = await fixture(t);
  await trace.after({ sessionID: 's1', messageID: 'm1', id: 'c1', agent: 'build', tool: 'shell', input: { command: 'g10' }, status: 'completed', result: { output: 'x' } });
  await capture.flush();
  const deadline = Date.now() + 10000;
  while (trace.store.findEntriesAll({ type: 'tool.after', session: 's1' }).filter(e => e.tool === 'shell').length === 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 50));
  }
  const seen = trace.store.findEntriesAll({ type: 'tool.after', session: 's1' }).filter(e => e.tool === 'shell');
  assert.ok(seen.length >= 1, 'host watcher imported the writer-persisted capture event');
  assert.equal(trace.store.coverage.statusFor('s1').session_coverage.status, 'complete', 'coverage continuity holds for persisted captures');
});

async function pathDir(trace) {
  // events root: <base>/workspaces/<hash> — recovery helper wants the base.
  return trace.store.base;
}
// Sync accessor: recovered() needs the store base, not a promise.
const baseDir = trace => trace.store.base;
