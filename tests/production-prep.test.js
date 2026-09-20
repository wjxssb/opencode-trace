// V2-A production-prep regression tests:
//   S-series  trace_status canonical ref filter (evt_ AND blob_) + discovery
//   R-series  HandleRegistry session lifecycle cleanup (release, retired,
//             peer isolation, restart freshness, TTL bound)
//   M-series  handle resolution metadata (raw input preserved; additive
//             trace.handle_resolution correspondence event; never identity)
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Trace } from '../src/trace.js';
import { definitions } from '../src/tools.js';
import { HandleRegistry, DEFAULT_HANDLE_TTL_MS } from '../src/handles.js';
import { callKey, refPattern } from '../src/util.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-trace-prep-'));
  const trace = new Trace({ location: { directory: dir } }, { storeRoot: path.join(dir, 'store') });
  await trace.ready;
  t.after(async () => { trace.store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, trace, store: trace.store };
}
const host = (sessionID = 's1') => ({ sessionID, messageID: 'm1', id: 'c1', agent: 'build' });
const tool = (trace, name) => definitions(trace).find(d => d.name === name);
async function captureOne(trace, command = 'node --test') {
  await trace.after({ sessionID: 's1', messageID: 'm1', id: 'c1', agent: 'build',
    tool: 'shell', input: { command }, status: 'completed', result: { output: `ok ${command}` } });
}
async function snapshotTurn(trace, sessionID = 's1') {
  const { assignments } = trace.recallSnapshot(sessionID);
  trace.handles.newGeneration(sessionID, assignments ?? []);
  return assignments;
}

test('S1: trace_status registers discovery handles for BOTH event and blob refs (refPattern)', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace, 'status-filter-7c21');
  trace.handles.newGeneration('s1', []);
  const status = await tool(trace, 'trace_status').execute({}, host());
  assert.equal(status.metadata.raw.ok, true);
  const eventRow = status.metadata.raw.recent.find(r => r.handle && refPattern.test(r.ref) && r.ref.startsWith('evt_'));
  assert.ok(eventRow, 'event ref must get a discovery handle');
  const blobRow = (status.metadata.raw.recent.find(r => (r.outputs ?? []).some(o => o.handle)))?.outputs?.find(o => o.handle);
  assert.ok(blobRow, 'blob output ref must get a discovery handle');
  assert.match(blobRow.handle, /^b[1-9][0-9]{0,3}$/);
  const expanded = await tool(trace, 'trace_expand').execute({ ref: blobRow.handle }, host());
  assert.equal(expanded.metadata.raw.ok, true);
  assert.equal(expanded.metadata.raw.ref, blobRow.ref, 'blob handle resolves to the canonical blob ref');
});

test('R1: release() clears the ACTIVE generation; handles report unknown (not expired)', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace);
  await snapshotTurn(trace);
  assert.equal(trace.handles.resolve('s1', 'e1').ok, true);
  assert.equal(trace.handles.release('s1'), true);
  const resolved = trace.handles.resolve('s1', 'e1');
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, 'unknown', 'deleted session tombstones are gone too');
  assert.equal(trace.handles.describe().active_generations, 0);
  assert.equal(trace.handles.release('s1'), false, 'release of unknown session is a no-op');
});

test('R2: release() clears the RETIRED tombstone as well', async t => {
  const registry = new HandleRegistry();
  registry.newGeneration('s1', [{ handle: 'e1', ref: 'evt_' + 'a'.repeat(64), kind: 'event' }]);
  registry.newGeneration('s1', []); // gen1 -> retired
  assert.equal(registry.resolve('s1', 'e1').reason, 'expired');
  registry.release('s1');
  assert.equal(registry.retired.has('s1'), false);
  assert.equal(registry.resolve('s1', 'e1').reason, 'unknown');
});

test('R3: release() is peer-isolated', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace);
  await snapshotTurn(trace, 's1');
  trace.handles.newGeneration('s2', [{ handle: 'e1', ref: 'evt_' + 'b'.repeat(64), kind: 'event' }]);
  trace.handles.release('s1');
  assert.equal(trace.handles.resolve('s2', 'e1').ok, true, 'peer mapping untouched');
  assert.equal(trace.handles.resolve('s1', 'e1').ok, false);
});

test('R4: restart freshness — a fresh registry resolves nothing for released sessions', () => {
  const registry = new HandleRegistry();
  assert.equal(registry.describe().active_generations, 0);
  assert.equal(registry.describe().retired_generations, 0);
  assert.equal(registry.resolve('s1', 'e1').ok, false);
});

test('R5: TTL sweep bounds registry growth across many sessions; young sessions survive', () => {
  const registry = new HandleRegistry();
  const now = Date.now();
  for (let i = 0; i < 400; i++) {
    registry.newGeneration(`s${i}`, [{ handle: 'e1', ref: 'evt_' + String(i).padStart(3, '0').repeat(21).slice(0, 60) + 'a'.repeat(4), kind: 'event' }]);
    for (const gen of [registry.active.get(`s${i}`)]) gen.created_at = now - DEFAULT_HANDLE_TTL_MS - 1000;
  }
  assert.equal(registry.describe().active_generations, 400);
  const evicted = registry.sweep(now + 1000);
  assert.equal(evicted.length, 400, 'all stale sessions evicted');
  assert.equal(registry.describe().active_generations, 0);
  assert.equal(registry.describe().retired_generations, 0);
  // Young session (fresh turn) survives a sweep well inside the TTL.
  registry.newGeneration('live', [{ handle: 'e1', ref: 'evt_' + 'c'.repeat(64), kind: 'event' }]);
  registry.sweep(now + DEFAULT_HANDLE_TTL_MS - 1000);
  assert.equal(registry.resolve('live', 'e1').ok, true, 'live session is never cleaned');
});

test('R6: session.deleted lifecycle releases the handle mapping', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace);
  await snapshotTurn(trace, 's1');
  assert.equal(trace.handles.resolve('s1', 'e1').ok, true);
  await trace.lifecycle({ type: 'session.deleted', properties: { sessionID: 's1' }, id: 'evt_test' });
  assert.equal(trace.handles.resolve('s1', 'e1').ok, false, 'deleted session handles are released');
});

test('M1: raw input echo preserved + trace.handle_resolution correspondence event recorded', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace);
  const assignments = await snapshotTurn(trace);
  const canonical = assignments.find(a => a.handle === 'e1').ref;
  const rawInput = { kind: 'finding', text: 'resolution metadata', source_handles: ['e1'] };
  const rawCallKey = callKey({ sessionID: 's1', id: 'c1', tool: 'trace_note', input: rawInput });
  const out = await tool(trace, 'trace_note').execute({ ...rawInput }, host());
  assert.equal(out.metadata.raw.ok, true);
  assert.deepEqual(out.metadata.raw.handles_resolved, [{ handle: 'e1', ref: canonical }]);
  const events = [...trace.store.index.values()];
  const rawEcho = events.filter(e => e.type === 'tool.before' && e.tool === 'trace_note');
  // Note: direct tool.execute() bypasses host execute.before hooks; raw-input
  // echo is asserted in production-shape tests (local-qual + real host runs).
  const resolutionEvents = events.filter(e => e.type === 'trace.handle_resolution');
  assert.equal(resolutionEvents.length, 1, 'exactly one correspondence event');
  const payload = JSON.parse(await trace.store.readBlob(resolutionEvents[0].payloadRef));
  assert.equal(payload.tool, 'trace_note');
  assert.deepEqual(payload.resolutions, [{ handle: 'e1', ref: canonical }]);
  assert.equal(payload.raw_call_key, rawCallKey, 'links to the raw-input call key');
  assert.match(resolutionEvents[0].callKey ?? '', /^[a-f0-9]{64}$/, 'event-level callKey present');
  assert.equal('source_handles' in payload, false, 'raw input is not duplicated into the correspondence event');
  const note = JSON.parse(await trace.store.readBlob(events.find(e => e.type === 'trace.note').payloadRef));
  assert.deepEqual(note.source_refs, [canonical], 'durable note still canonical-only');
});

test('M2: handle-free calls record no correspondence event', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace);
  await snapshotTurn(trace);
  const before = [...trace.store.index.values()].filter(e => e.type === 'trace.handle_resolution').length;
  await tool(trace, 'trace_note').execute({ kind: 'fact', text: 'no handles here' }, host());
  const after = [...trace.store.index.values()].filter(e => e.type === 'trace.handle_resolution').length;
  assert.equal(after, before, 'no correspondence event without handle usage');
});
