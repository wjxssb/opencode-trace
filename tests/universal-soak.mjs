// Bounded, offline workload. No host API, model, external tools or production
// state. The retained store and receipt make all loss/recovery checks repeatable.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Trace } from '../src/trace.js';
import { Store } from '../src/store.js';
import { hash, stable, storageTiming } from '../src/util.js';

const base = path.resolve(process.argv[2] ?? '');
if (!base.includes('/universal-closeout-20260923/trace-soak-')) throw new Error('Explicit isolated soak path required');
await fs.mkdir(base, { recursive: false, mode: 0o700 });
const workspace = path.join(base, 'project'), root = path.join(base, 'store');
await fs.mkdir(workspace);
const sourceFiles = Object.fromEntries(await Promise.all((await fs.readdir(new URL('../src/', import.meta.url))).filter(name => name.endsWith('.js')).map(async name => [name, hash(await fs.readFile(new URL('../src/' + name, import.meta.url)))])));
const durationMs = 120000, maximumIterations = 5000, deadline = Date.now() + 180000;
const started = performance.now(), cpu = process.cpuUsage();
const expected = new Map(), samples = [], latencies = [], restarts = [];
let trace, reopened, failure, iterations = 0, retryChecks = 0, final, counts;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const processSample = async () => ({ at_ms: performance.now() - started, rss: process.memoryUsage().rss,
  heap: process.memoryUsage().heapUsed, fd: (await fs.readdir('/proc/self/fd')).length,
  threads: (await fs.readdir('/proc/self/task')).length, capture: trace?.capture?.status() });
const remember = async row => {
  if (row?.ref) expected.set(row.ref, true);
  return row;
};
try {
  trace = new Trace({ location: { directory: workspace } }, { storeRoot: root, captureWriter: true, captureQueueCap: 64, captureRespawnDelay: 20 });
  await trace.ready;
  samples.push(await processSample());
  for (; iterations < maximumIterations && performance.now() - started < durationMs; iterations++) {
    if (Date.now() > deadline) throw new Error('bounded soak deadline');
    const i = iterations;
    if (i > 0 && i % 800 === 0) trace.capture.paused = true;
    const sessionID = `soak-session-${i % 4}`;
    const host = { sessionID, messageID: `message-${i}`, id: `call-${i}`, agent: 'build' };
    const output = i % 20 === 0 ? `large-${i}:` + 'historical plain output\n'.repeat(4096) : 'identical legitimate result';
    const before = { ...host, occurrenceID: `soak-before-${i}`, tool: 'read', input: { path: `fixture-${i % 7}.txt` } };
    const after = { ...before, occurrenceID: `soak-after-${i}`, status: 'completed', result: { output } };
    const tick = performance.now();
    await remember(await trace.before(before));
    const row = await remember(await trace.after(after));
    latencies.push(performance.now() - tick);
    if (i % 50 === 0) {
      const retry = await trace.after({ ...after });
      assert.equal(retry.ref, row.ref); retryChecks++;
    }
    if (i % 10 === 0) await remember(await trace.note({ kind: 'finding', text: `CPU soak observation ${i}`, source_refs: [] }, host));
    if (i % 25 === 0) await remember(await trace.intent({ summary: `isolated intent ${i}`, status: 'active', paths: [`fixture-${i % 7}.txt`], resources: [], related_refs: [] }, host));
    if (i % 20 === 0) await remember(await trace.recordClaim({ subject: `CPU fixture claim ${i}`, text: 'Synthetic unverified report', source_refs: [] }, host));
    if (i % 40 === 0) await remember(await trace.store.record('review.cpu-observation', host, { source: 'isolated-soak-fixture', reviewID: `synthetic-${i}`, obligation: 'incomplete', settled: false }));
    if (i % 80 === 0) {
      await trace.store.reconcileSnapshot();
      const refs = trace.store.findEntriesNewest({ type: 'trace.note' }, 2);
      for (const entry of refs) await trace.store.expand(entry.ref, 0, 2048);
    }
    if (i > 0 && i % 800 === 0) {
      const generation = trace.capture.generation;
      trace.capture.paused = false; trace.capture.drain();
      const inFlight = trace.capture.inFlight.size;
      assert.ok(inFlight > 0, 'terminate a real worker with an unacknowledged admitted envelope');
      await trace.capture.worker?.terminate();
      restarts.push({ iteration: i, prior_generation: generation, in_flight: inFlight });
      await sleep(60);
    }
    if (i % 100 === 0) samples.push(await processSample());
    // Maintain a sustained workload instead of ending in one unrepresentative
    // short burst; this wait is inside an owned offline child process only.
    const target = ((i + 1) / maximumIterations) * durationMs;
    const remaining = target - (performance.now() - started);
    if (remaining > 0) await sleep(Math.min(remaining, 100));
  }
  await trace.capture.flush(20000);
  await trace.store.reconcileSnapshot();
  samples.push(await processSample());
  const capture = trace.capture.status();
  await trace.capture.stop(); await trace.store.close();
  const stopped = await processSample();
  reopened = await new Store(workspace, root, () => {}).init();
  const missing = [];
  for (const ref of expected.keys()) {
    const event = await reopened.readEvent(ref).catch(() => null);
    if (!event) { missing.push(ref); continue; }
    await reopened.readBlob(event.payload.ref);
    for (const output of event.outputs ?? []) await reopened.readBlob(output.ref);
  }
  const events = [...reopened.index.keys()];
  const bySession = new Map();
  const sequences = new Map(), duplicateSequences = [];
  for (const ref of events) {
    const event = await reopened.readEvent(ref);
    const key = `${event.host.sessionID ?? '_workspace'}:${event.session_seq}`;
    if (sequences.has(key)) duplicateSequences.push(key);
    sequences.set(key, ref);
    const sid = event.host.sessionID ?? '_workspace';
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push(event.session_seq);
  }
  const gaps = [];
  for (const [sid, seqs] of bySession) { seqs.sort((a,b) => a-b); for (let i = 0; i < seqs.length; i++) if (seqs[i] !== i+1) gaps.push({ sid, expected: i+1, actual: seqs[i] }); }
  assert.equal(gaps.length, 0, 'all allocated sequences accounted for');
  const coverage = reopened.coverage.status();
  assert.equal(coverage.known_gaps, 0, 'no false durable capture-gap markers');
  const peakRSS = Math.max(...samples.map(row => row.rss));
  const peakFD = Math.max(...samples.map(row => row.fd));
  assert.ok(peakRSS < 512 * 1024 * 1024, 'bounded 5000-iteration RSS under predeclared 512MiB ceiling');
  assert.ok(peakFD <= samples[0].fd + 24, 'bounded FD trend');
  assert.ok(stopped.fd <= samples[0].fd, 'shutdown releases owned FDs');
  const indexBefore = reopened.derivedIndex.persistedCount;
  await reopened.derivedIndex.close();
  await fs.rm(path.join(reopened.root, 'derived'), { recursive: true });
  await reopened.close();
  reopened = await new Store(workspace, root, () => {}).init();
  const indexAfter = reopened.derivedIndex.persistedCount;
  assert.equal(indexAfter, reopened.index.size);
  assert.equal(indexBefore, indexAfter);
  assert.equal(missing.length, 0);
  assert.equal(duplicateSequences.length, 0);
  assert.equal(reopened.admissions.recovery.incomplete.length, 0);
  assert.equal(capture.physical_loss_events, 0);
  await reopened.close();
  final = { expected_occurrences: expected.size, committed_events: events.length, missing,
    duplicate_sequences: duplicateSequences, unexplained_sequence_gaps: gaps, coverage, peak_rss_bytes: peakRSS, peak_fd: peakFD, recovered_incomplete: reopened.admissions.recovery.incomplete,
    original_index_rows: indexBefore, rebuilt_index_rows: indexAfter, capture, after_stop: stopped,
    worker_reference_cleared: trace.capture.worker === null, sqlite_closed: reopened.derivedIndex.db === null };
} catch (error) { failure = { name: error.name, message: error.message, stack: error.stack }; }
finally {
  await trace?.capture?.stop().catch(() => {});
  await trace?.store?.close().catch(() => {});
  await reopened?.close().catch(() => {});
}
const inodes = new Set();
const disk = { files: 0, bytes: 0, allocated_bytes: 0, index_bytes: 0, admission_bytes: 0 };
async function walk(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(filename);
    else if (entry.isFile()) { const st = await fs.stat(filename); disk.files++; disk.bytes += st.size; const inode = `${st.dev}:${st.ino}`; if (!inodes.has(inode)) { disk.allocated_bytes += st.blocks * 512; inodes.add(inode); }
      if (filename.includes('/derived/')) disk.index_bytes += st.size;
      if (filename.includes('/admission/')) disk.admission_bytes += st.size; }
  }
}
await walk(root);
const times = [...latencies].sort((a, b) => a - b), quantile = p => times[Math.min(times.length - 1, Math.floor(p * times.length))] ?? null;
const elapsed = performance.now() - started;
const receipt = { status: failure ? 'FAIL' : 'PASS_BOUNDED_OFFLINE_TRACE_SOAK', scope: 'Synthetic isolated CPU/IO workload; no models or production state',
  source_files_sha256: sourceFiles, script_sha256: hash(await fs.readFile(new URL(import.meta.url))),
  acceptance_limits: { rss_bytes: 512 * 1024 * 1024, fd_growth: 24, shutdown_fd_not_above_start: true },
  duration_limit_ms: durationMs, deadline_ms: 180000, max_iterations: maximumIterations,
  iterations, elapsed_ms: elapsed, cpu_us: process.cpuUsage(cpu), events_per_second: expected.size / (elapsed / 1000),
  retry_checks: retryChecks, worker_restarts: restarts, persist_pair_latency_ms: { p50: quantile(.5), p95: quantile(.95), p99: quantile(.99) },
  fsync: storageTiming(), disk, samples, final, failure,
  limits: ['Two-minute isolated workload is not an indefinite production soak.', 'SQLite transaction duration includes busy wait; wait cannot be independently separated by node:sqlite.', 'Host failure before durable admission is outside exactly-once admission.', 'RSS includes rebuildable in-memory indexes and grows with retained history; test evaluates growth per retained event, not constant-memory storage.'] };
await fs.writeFile(path.join(base, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ status: receipt.status, base, iterations, elapsed_ms: elapsed, expected: expected.size, failure }));
process.exitCode = failure ? 1 : 0;
