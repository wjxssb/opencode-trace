import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { CaptureCoordinator } from '../src/capture.js';
import { Trace } from '../src/trace.js';
import { hash } from '../src/util.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const noWatch = () => ({ on() {}, unref() {}, close() {} });
const host = { sessionID: 'admission-session', messageID: 'message', agent: 'build' };
const data = { tool: 'read', result: { output: 'same legitimate observation' } };
const job = { type: 'tool.after', host, data, extra: { tool: 'read' } };
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-admission-'));
  const stores = [];
  const open = async options => {
    const store = await new Store(directory, path.join(directory, 'store'), () => {}, { watch: noWatch, ...options }).init();
    stores.push(store); return store;
  };
  t.after(async () => {
    for (const store of stores) await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { open, store: await open(), directory };
}

test('stable occurrence retries, concurrent retry, restart and ACK loss allocate exactly once', async t => {
  const { store, open } = await fixture(t);
  const records = await Promise.all(Array.from({ length: 16 }, () => store.record(job.type, host, data, job.extra, 'producer:one')));
  assert.equal(new Set(records.map(row => row.ref)).size, 1);
  assert.equal((await store.sequences.watermark(host.sessionID)).seq, 1);
  const bytes = await fs.readFile(path.join(store.root, 'events', records[0].ref + '.json'));
  await store.close();
  const reopened = await open();
  const retry = await reopened.record(job.type, host, data, job.extra, 'producer:one');
  assert.equal(retry.ref, records[0].ref);
  assert.deepEqual(await fs.readFile(path.join(store.root, 'events', retry.ref + '.json')), bytes);
  assert.equal((await reopened.sequences.watermark(host.sessionID)).seq, 1);
  assert.equal(reopened.findEntriesAll({ type: 'tool.after' }).length, 1);
});

test('identical distinct occurrences survive; conflicting reuse does not consume sequence', async t => {
  const { store } = await fixture(t);
  const a = await store.record(job.type, host, data, job.extra, 'producer:first');
  const b = await store.record(job.type, host, data, job.extra, 'producer:second');
  assert.notEqual(a.ref, b.ref);
  assert.equal(a.payload.ref, b.payload.ref);
  await assert.rejects(store.record(job.type, host, { changed: true }, job.extra, 'producer:first'), /different observation/);
  assert.equal((await store.sequences.watermark(host.sessionID)).seq, 2);
});

test('native host occurrence survives separate retry objects; legacy producer IDs distinguish equal observations', () => {
  const trace = Object.create(Trace.prototype);
  const a = { occurrenceID: 'native-occurrence-one', tool: 'read' };
  assert.equal(trace.occurrence(a, 'after'), trace.occurrence(structuredClone(a), 'after'));
  assert.notEqual(trace.occurrence(a, 'before'), trace.occurrence(a, 'after'));
  assert.notEqual(trace.occurrence({ tool: 'read' }, 'after'), trace.occurrence({ tool: 'read' }, 'after'));
});

test('late stable tool observation retains its original cause after another equal call begins', async t => {
  const { store } = await fixture(t);
  const trace = Object.create(Trace.prototype); trace.store = store;
  trace.verificationMilestone = async () => {};
  const before = { ...host, id: 'same-call', tool: 'read', input: { path: 'fixture' }, occurrenceID: 'before-first' };
  const firstCause = await trace.before(before);
  const after = { ...before, occurrenceID: 'after-first', status: 'completed', result: { output: 'same' } };
  const first = await trace.after(after);
  const newCause = await trace.before({ ...before, occurrenceID: 'before-second' });
  assert.notEqual(firstCause.ref, newCause.ref);
  const retry = await trace.after(structuredClone(after));
  assert.equal(retry.ref, first.ref);
  assert.equal(retry.caused_by, firstCause.ref);
  assert.equal(store.findEntriesAll({ type: 'tool.after' }).length, 1);
  await assert.rejects(trace.after({ ...after, result: { output: 'changed' } }), /different observation/);
});

test('coverage flush drains marker writes created by an in-flight sequence check', async t => {
  const { store } = await fixture(t);
  let releaseWrite, announceWrite;
  const blocked = new Promise(resolve => { releaseWrite = resolve; });
  const started = new Promise(resolve => { announceWrite = resolve; });
  const recordGap = store.recordGap.bind(store);
  store.recordGap = async (...args) => { announceWrite(); await blocked; return recordGap(...args); };
  const check = Promise.resolve().then(() => {
    store.coverage.noteGap({ session: host.sessionID, from_seq: 100, to_seq: 100, reason: 'legacy-missing' });
  });
  store.coverage.pending.add(check);
  check.finally(() => store.coverage.pending.delete(check));
  let done = false;
  const flush = store.coverage.flushPending().then(() => { done = true; });
  try {
    await started; await new Promise(resolve => setImmediate(resolve));
    assert.equal(done, false, 'flush must await the newly created durable write');
  } finally { releaseWrite(); await flush; }
  assert.equal(store.findEntriesAll({ type: 'trace.capture_gap' }).length, 1);
});

for (const point of ['before-intent', 'after-intent', 'after-admission', 'after-sequence']) {
  test(`restart recovers admission crash window ${point} without allocating a second sequence`, async t => {
    const { store, open } = await fixture(t);
    store.admissions.fault = async where => { if (where === point) throw new Error('injected process stop'); };
    await assert.rejects(store.record(job.type, host, data, job.extra, 'crash:stable'), /injected/);
    await store.close();
    const recovered = await open();
    assert.equal(recovered.findEntriesAll({ type: 'tool.after' }).length, point === 'before-intent' ? 0 : 1);
    const row = await recovered.record(job.type, host, data, job.extra, 'crash:stable');
    assert.equal(row.session_seq, 1);
    assert.equal(recovered.findEntriesAll({ type: 'tool.after' }).length, 1);
    assert.equal(recovered.admissions.recovery.incomplete.length, 0);
  });
}

test('accepted envelope survives worker loss, and same-object retry preserves host occurrence', async t => {
  const { store } = await fixture(t);
  const trace = Object.create(Trace.prototype); trace.store = store; trace.warning = () => {};
  const capture = new CaptureCoordinator(trace); trace.capture = capture;
  capture.active = true; capture.paused = true;
  const observation = { ...host, id: 'call', tool: 'read', input: { path: 'fixture' }, status: 'completed', result: { output: 'same' } };
  const first = await trace.after(observation);
  const retry = await trace.after(observation);
  assert.equal(first.ref, retry.ref);
  assert.equal(capture.queue.length, 1);
  const env = capture.queue.shift();
  await store.persistEnvelope(env); // Actual commit before a lost ACK.
  capture.inFlight.set(env.env_id, env);
  const worker = { terminate() {} }; capture.worker = worker; capture.respawnAttempts = 5;
  capture.onWorkerDeath(worker);
  assert.equal(capture.droppedTotal, 0);
  assert.equal(capture.queue[0].ref, first.ref);
  await store.persistEnvelope(capture.queue[0]);
  assert.equal(store.findEntriesAll({ type: 'tool.after' }).length, 1);
  const distinct = await trace.after(structuredClone(observation));
  assert.notEqual(distinct.ref, first.ref);
});

test('admitted but delayed sequence is pending work rather than a physical capture gap', async t => {
  const { store } = await fixture(t);
  await store.record(job.type, host, { n: 0 }, job.extra, 'ordered:zero');
  const { envelope } = await store.admissions.admit({ ...job, data: { n: 1 } }, 'ordered:one');
  await store.record(job.type, host, { n: 2 }, job.extra, 'ordered:two');
  await store.coverage.flushPending();
  assert.equal(store.findEntriesAll({ type: 'trace.capture_gap' }).length, 0);
  await store.persistEnvelope(envelope);
  await store.coverage.flushPending();
  assert.equal(store.coverage.statusFor(host.sessionID).session_coverage.unresolved_seqs, 0);
  assert.equal(store.findEntriesAll({ type: 'tool.after' }).length, 3);
});

test('one recovered sequence reconciles every overlapping historical marker', async t => {
  const { store } = await fixture(t);
  store.coverage.noteGap({ session: host.sessionID, from_seq: 41, to_seq: 42, reason: 'legacy-a' });
  store.coverage.noteGap({ session: host.sessionID, from_seq: 42, to_seq: 43, reason: 'legacy-b' });
  await store.coverage.flushPending();
  await store.coverage.noteReconciled(host.sessionID, 42);
  const markers = [...store.coverage.markers.values()].filter(row => row.session === host.sessionID);
  assert.deepEqual(markers.map(row => row.ranges), [[{ from: 41, to: 41 }], [{ from: 43, to: 43 }]]);
  assert.equal(store.findEntriesAll({ type: 'trace.capture_gap' }).length, 4);
});

test('missing admitted source is visibly incomplete; restoring exact bytes recovers original identity', async t => {
  const { store, open } = await fixture(t);
  const { envelope } = await store.admissions.admit(job, 'source:missing');
  const source = path.join(store.root, 'blobs', envelope.payload.sha256.slice(0, 2), envelope.payload.sha256);
  const bytes = await fs.readFile(source);
  await fs.unlink(source); await store.close();
  const incomplete = await open();
  assert.equal(incomplete.admissions.recovery.incomplete.length, 1);
  assert.equal(incomplete.findEntriesAll({ type: 'tool.after' }).length, 0);
  assert.equal((await incomplete.sequences.watermark(host.sessionID)).seq, 1);
  assert.equal(hash(bytes), envelope.payload.sha256);
  await fs.writeFile(source, bytes); await incomplete.close();
  const recovered = await open();
  assert.equal(recovered.admissions.recovery.incomplete.length, 0);
  assert.equal(recovered.findEntriesAll({ type: 'tool.after' })[0].ref, envelope.ref);
});

test('index loss rebuilds from committed source/event; closing store closes SQLite handle', async t => {
  const { store, open } = await fixture(t);
  const row = await store.record(job.type, host, data, job.extra, 'index:event');
  const index = store.derivedIndex;
  await store.close(); assert.equal(index.db, null);
  await fs.rm(path.join(store.root, 'derived'), { recursive: true });
  const recovered = await open();
  assert.equal(recovered.findEntriesAll({ type: 'tool.after' })[0].ref, row.ref);
  assert.equal(recovered.derivedIndex.persistedCount, recovered.index.size);
  assert.equal(recovered.derivedIndex.ftsCandidates('read').includes(row.ref), true);
});

for (const point of ['before-intent', 'after-intent', 'after-admission', 'after-sequence', 'after-event', 'after-index']) {
  test(`real child process death at ${point} recovers with stable sequence and byte-exact source`, async t => {
    const { store, open, directory } = await fixture(t);
    await store.close();
    const script = `
      import { Store } from ${JSON.stringify(new URL('../src/store.js', import.meta.url).href)};
      const store = await new Store(${JSON.stringify(directory)}, ${JSON.stringify(path.join(directory, 'store'))}, () => {}, {
        watch: () => ({ on() {}, unref() {}, close() {} }),
        admissionFault: async point => { if (point === ${JSON.stringify(point)}) process.exit(73); }
      }).init();
      await store.record('tool.after', ${JSON.stringify(host)}, ${JSON.stringify(data)}, ${JSON.stringify(job.extra)}, 'process:crash');
      process.exit(99);
    `;
    await assert.rejects(promisify(execFile)(process.execPath, ['--input-type=module', '-e', script]), error => error.code === 73);
    const recovered = await open();
    assert.equal(recovered.findEntriesAll({ type: 'tool.after' }).length, point === 'before-intent' ? 0 : 1);
    const row = await recovered.record(job.type, host, data, job.extra, 'process:crash');
    assert.equal(row.session_seq, 1);
    assert.deepEqual(JSON.parse(await recovered.readBlob(row.payload.ref)), data);
    assert.equal(recovered.findEntriesAll({ type: 'tool.after' }).length, 1);
    assert.equal(recovered.admissions.recovery.incomplete.length, 0);
  });
}
