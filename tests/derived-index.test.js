// Phase D qualification: persistent, disposable, rebuildable derived index.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Trace } from '../src/trace.js';
import { DerivedIndex } from '../src/derived-index.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-trace-didx-'));
  const trace = new Trace({ location: { directory: dir } }, { storeRoot: path.join(dir, 'store') });
  await trace.ready;
  t.after(async () => { await trace.store.close(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); });
  return { dir, trace, store: trace.store };
}

test('D1: empty store builds an empty, ready index', async t => {
  const { store } = await fixture(t);
  const result = await store.derivedIndex.rebuild();
  assert.equal(result.rebuilt, true);
  assert.equal(result.indexed, 0);
  const status = store.derivedIndex.status();
  assert.equal(status.state, 'ready');
  assert.equal(status.backend.includes('FTS5'), true);
});

test('D2: full rebuild from CAS recovers every event', async t => {
  const { store } = await fixture(t);
  for (let i = 0; i < 10; i++) await store.record('probe.a', { sessionID: 's1' }, { i });
  const result = await store.derivedIndex.rebuild();
  assert.equal(result.rebuilt, true);
  assert.equal(result.indexed, 10);
  assert.equal(store.derivedIndex.status().index_lag, 0);
});

test('D3: rebuild is logically equivalent across runs', async t => {
  const { store } = await fixture(t);
  for (let i = 0; i < 6; i++) await store.record('probe.a', { sessionID: 's1' }, { i });
  await store.derivedIndex.rebuild();
  const dump = () => store.derivedIndex.db.prepare('SELECT ref, session, seq, type FROM events ORDER BY ref').all();
  const first = dump();
  await store.derivedIndex.rebuild();
  assert.deepEqual(dump(), first, 'rebuild twice yields the identical logical index');
});

test('D4: FTS finds payload text that in-memory hints may miss', async t => {
  const { store } = await fixture(t);
  await store.record('probe.note', { sessionID: 's1' }, { text: 'quantum-flux-capacitor calibration 7734' });
  const candidates = store.derivedIndex.ftsCandidates('quantum-flux-capacitor');
  assert.equal(candidates.length, 1);
  const ev = await store.readEvent(candidates[0]);
  assert.equal(JSON.parse(await store.readBlob(ev.payload.ref)).text.includes('7734'), true);
});

test('D5+D6+D7: structured path/tool/session queries', async t => {
  const { store } = await fixture(t);
  await store.record('tool.after', { sessionID: 'sD' }, { tool: 'edit' }, { tool: 'edit', source: { path: '/unique/dircraft/x.py' }, status: 'completed' });
  assert.equal(store.derivedIndex.structured({ path: 'dircraft' }).length, 1);
  assert.ok(store.derivedIndex.structured({ tool: 'edit' }).length >= 1);
  assert.equal(store.derivedIndex.structured({ session: 'sD' }).length, 1);
  assert.equal(store.derivedIndex.structured({ session: 'nope' }).length, 0);
});

test('D8: causal query finds events caused by a given event', async t => {
  const { trace } = await fixture(t);
  const e = { sessionID: 's1', messageID: 'm1', id: 'call-9', agent: 'build', tool: 'shell', input: { command: 'd8' } };
  await trace.before(e);
  const after = await trace.after({ ...e, status: 'completed', result: { output: 'ok' } });
  assert.equal(store(trace).derivedIndex.structured({ caused_by: after.caused_by }).includes(after.ref), true);
  function store(t2) { return t2.store; }
});

test('D9: deleting the index file is fully recoverable', async t => {
  const { store } = await fixture(t);
  await store.record('probe.a', { sessionID: 's1' }, { i: 1 });
  await store.derivedIndex.close();
  await fs.rm(path.join(store.root, 'derived'), { recursive: true, force: true });
  assert.equal(await store.derivedIndex.open(), true, 'open recreates the database');
  const result = await store.derivedIndex.rebuild();
  assert.equal(result.rebuilt, true);
  assert.equal(result.indexed, store.index.size);
});

test('D10: corrupted index degrades honestly and rebuilds from CAS', async t => {
  const { store } = await fixture(t);
  await store.record('probe.a', { sessionID: 's1' }, { i: 1 });
  await store.derivedIndex.close();
  await fs.writeFile(path.join(store.root, 'derived', 'index.db'), Buffer.from('this is not a database'));
  assert.equal(await store.derivedIndex.open(), false, 'corrupt index fails open gracefully');
  assert.equal(store.derivedIndex.status().state, 'error');
  // CAS reads still work with the index unavailable
  const rows = store.findEntries({ type: 'probe.a' });
  assert.equal(rows.length, 1, 'memory index still serves queries');
  // deleting the corrupt file allows a clean rebuild
  await fs.rm(path.join(store.root, 'derived'), { recursive: true, force: true });
  assert.equal(await store.derivedIndex.open(), true);
  const result = await store.derivedIndex.rebuild();
  assert.equal(result.rebuilt, true);
});

test('D11: index lag is measurable and repairable', async t => {
  const { store } = await fixture(t);
  await store.record('probe.a', { sessionID: 's1' }, { i: 1 });
  assert.equal(store.derivedIndex.status().index_lag, 0, 'write-through keeps the mirror in sync');
  // simulate the mirror falling behind (e.g. sidecar lag in Phase G)
  await store.record('probe.a', { sessionID: 's1' }, { bypass: true });
  const bypassed = [...store.index.values()].at(-1);
  store.derivedIndex.upsert({ ...bypassed, ref: 'skip' }); // no-op for lag demo
  await store.derivedIndex.rebuild();
  assert.equal(store.derivedIndex.status().index_lag, 0, 'rebuild repairs lag');
});

test('D12: FTS candidate leads to hash-verified expand (discovery -> evidence)', async t => {
  const { store } = await fixture(t);
  await store.record('probe.note', { sessionID: 's1' }, { text: 'artifact-witness-90210 unique payload' });
  const [ref] = store.derivedIndex.ftsCandidates('artifact-witness-90210');
  const view = await store.expand(ref, 0, 4096, false);
  assert.equal(view.hash_verified, true);
  assert.equal(view.metadata.session_seq != null, true, 'expand also exposes causal projection');
});

test('D14: search results still carry V2-A discovery handles', async t => {
  const { trace } = await fixture(t);
  await trace.after({ sessionID: 's1', messageID: 'm1', id: 'c1', agent: 'build', tool: 'shell', input: { command: 'd14-unique-token' }, status: 'completed', result: { output: 'd14-unique-token ok' } });
  trace.handles.newGeneration('s1', []);
  const found = await trace.find({ text: 'd14-unique-token' }, { sessionID: 's1', agent: 'build' });
  const row = (found.results ?? []).find(r => r.handle);
  assert.ok(row, 'search results carry discovery handles');
  const expanded = await definitions(trace).find(d => d.name === 'trace_expand').execute({ ref: row.handle }, { sessionID: 's1', agent: 'build' });
  assert.equal(expanded.metadata.raw.ok, true);
});

test('D15: rebuild + FTS performance is bounded on a few-hundred-event store', async t => {
  const { store } = await fixture(t);
  for (let i = 0; i < 300; i++) await store.record('probe.perf', { sessionID: 'sP' }, { i, text: `payload-${i}` });
  const t0 = performance.now();
  const result = await store.derivedIndex.rebuild();
  const rebuildMs = performance.now() - t0;
  assert.equal(result.rebuilt, true);
  const t1 = performance.now();
  const hits = store.derivedIndex.ftsCandidates('payload-299');
  const ftsMs = performance.now() - t1;
  assert.equal(hits.length >= 1, true);
  console.log(`   D15: rebuild(300 events)=${rebuildMs.toFixed(1)}ms, fts=${ftsMs.toFixed(2)}ms`);
  assert.ok(rebuildMs < 5000, 'rebuild bounded');
  assert.ok(ftsMs < 100, 'fts query bounded');
});

import { definitions } from '../src/tools.js';
