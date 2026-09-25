// Characterization of delivery boundaries; these tests do not certify
// raw-event exactly-once delivery or reinterpret repeated host observations.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Trace } from '../src/trace.js';
import { CaptureCoordinator } from '../src/capture.js';

const noWatch = () => ({ on() {}, unref() {}, close() {} });
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-replay-contract-'));
  const stores = [];
  const open = async () => {
    const store = await new Store(dir, path.join(dir, 'store'), () => {}, { watch: noWatch }).init();
    stores.push(store);
    return store;
  };
  t.after(async () => {
    for (const store of stores) await store.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });
  return { store: await open(), open };
}
const event = { sessionID: 's1', messageID: 'm1', id: 'c1', agent: 'build', tool: 'shell',
  input: { command: 'printf observed' }, status: 'completed', result: { output: 'observed' } };
const host = { sessionID: 's1', messageID: 'm1', agent: 'build' };
const data = { id: 'c1', tool: 'shell', status: 'completed', result: { output: 'observed' } };
const extra = { callID: 'c1', tool: 'shell' };

test('raw capture observations allocate separately; only the already allocated envelope replays idempotently', async t => {
  const { store } = await fixture(t);
  const trace = Object.create(Trace.prototype);
  trace.store = store;
  trace.warning = (_where, error) => { throw error; };
  const capture = new CaptureCoordinator(trace);
  trace.capture = capture;
  capture.active = true;
  capture.paused = true; // Real host router/allocator; no worker needed to inspect admission.
  const a = await trace.after(structuredClone(event));
  const b = await trace.after(structuredClone(event));
  assert.notEqual(a.ref, b.ref);
  await Promise.all([trace.after(structuredClone(event)), trace.after(structuredClone(event))]);
  assert.deepEqual(capture.queue.map(env => env.session_seq).sort(), [1, 2, 3, 4]);
  assert.equal(new Set(capture.queue.map(env => env.idempotency_key)).size, 4);
  assert.equal(new Set(capture.queue.map(env => env.payload_ref)).size, 1);
  assert.equal(new Set(capture.queue.map(env => env.body.callKey)).size, 1);
  for (const envelope of capture.queue) await store.persistEnvelope(envelope);
  assert.equal(store.findEntriesAll({ type: 'tool.after' }).length, 4);
  const filename = path.join(store.root, 'events', `${a.ref}.json`);
  const original = await fs.readFile(filename, 'utf8');
  await store.persistEnvelope(capture.queue[0]);
  assert.equal(await fs.readFile(filename, 'utf8'), original);
  assert.equal(store.findEntriesAll({ type: 'tool.after' }).length, 4);

  const changed = await trace.after({ ...event, result: { output: 'changed result under the same call ID' } });
  assert.notEqual(changed.ref, a.ref);
  const failed = await trace.after({ ...event, status: 'error', result: undefined, error: { message: 'later failure' } });
  assert.notEqual(failed.ref, changed.ref);
  assert.deepEqual(capture.queue.slice(-2).map(env => env.body.status), ['completed', 'error']);
  assert.equal((await store.sequences.watermark('s1')).seq, 6);
});

test('stable occurrence retry survives restart while identical distinct occurrences remain distinct', async t => {
  const { store, open } = await fixture(t);
  const a = await store.record('tool.after', host, data, extra, 'producer:retry');
  const b = await store.record('tool.after', host, data, extra, 'producer:retry');
  assert.equal(a.ref, b.ref);
  assert.equal(a.at, b.at);
  assert.equal((await store.sequences.watermark('s1')).seq, 1);
  await store.close();
  const recovered = await open();
  const replayed = await recovered.record('tool.after', host, data, extra, 'producer:retry');
  assert.equal(replayed.ref, a.ref);
  const distinct = await recovered.record('tool.after', host, data, extra, 'producer:distinct');
  assert.notEqual(distinct.ref, a.ref);
  assert.equal(distinct.session_seq, 2);
  assert.equal(recovered.findEntriesAll({ type: 'tool.after' }).length, 2);
});

test('concurrent identical observations with distinct producer identities remain separate', async t => {
  const { store } = await fixture(t);
  const results = await Promise.all([
    store.record('tool.after', host, data, extra, 'producer:concurrent-a'),
    store.record('tool.after', host, data, extra, 'producer:concurrent-b'),
  ]);
  assert.equal(new Set(results.map(value => value.ref)).size, 2);
  assert.deepEqual(results.map(value => value.session_seq).sort(), [1, 2]);
  assert.equal(store.findEntriesAll({ type: 'tool.after' }).length, 2);
});
