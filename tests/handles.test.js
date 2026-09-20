// Trace V2 Phase A qualification: ephemeral, turn-scoped evidence handles.
//
// Mission test matrix (§16): H1..H11, plus determinism, discovery handles,
// restart regeneration and durable-storage canonical-only guarantees.
// Handles are transport/display labels only; every durable payload keeps
// full canonical evt_/blob_ refs.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Trace } from '../src/trace.js';
import { definitions } from '../src/tools.js';
import { assignSnapshotHandles, HANDLE_PATTERN } from '../src/handles.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-trace-handles-'));
  const trace = new Trace({ location: { directory: dir } }, { storeRoot: path.join(dir, 'store') });
  await trace.ready;
  t.after(async () => { trace.store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, trace, store: trace.store };
}
const host = (sessionID = 's1') => ({ sessionID, messageID: 'm1', id: 'c1', agent: 'build' });
const tool = (trace, name) => definitions(trace).find(d => d.name === name);

// Record one completed tool call and prepare a snapshot generation for s1.
async function captureOne(trace, command = 'node --test') {
  await trace.after({ sessionID: 's1', messageID: 'm1', id: 'c1', agent: 'build',
    tool: 'shell', input: { command }, status: 'completed', result: { output: `ok ${command}` } });
}
async function snapshotTurn(trace, sessionID = 's1') {
  const { snapshot, assignments, text } = trace.recallSnapshot(sessionID);
  trace.handles.newGeneration(sessionID, assignments ?? []);
  return { snapshot, assignments, text };
}

test('H1: snapshot assigns e1 to first recent event; trace_expand(e1) returns that verified event', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace, 'npm test');
  const { snapshot, text } = await snapshotTurn(trace);
  assert.ok(text.includes('=== EVIDENCE HANDLES'), 'recall text must expose the handle block');
  const row = snapshot.evidence_handles.find(r => r.handle === 'e1');
  assert.ok(row, 'e1 must be listed');
  const canonical = snapshot.recent.at(-1).ref;
  const out = await tool(trace, 'trace_expand').execute({ ref: 'e1' }, host());
  assert.equal(out.metadata.raw.ok, true);
  assert.equal(out.metadata.raw.ref, canonical);
  assert.equal(out.metadata.raw.hash_verified, true);
  const resolved = trace.handles.resolve('s1', 'e1');
  assert.equal(resolved.ok, true);
  assert.equal(resolved.ref, canonical);
});

test('H2: b1 resolves to the recorded output blob and expands to raw bytes', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace, 'blob-cmd');
  const { snapshot } = await snapshotTurn(trace);
  const blobRef = snapshot.recent.at(-1).outputs[0].ref;
  const out = await tool(trace, 'trace_expand').execute({ ref: 'b1' }, host());
  assert.equal(out.metadata.raw.ok, true);
  assert.equal(out.metadata.raw.ref, blobRef);
  assert.equal(out.metadata.raw.hash_verified, true);
  assert.equal(out.metadata.raw.total_bytes, Buffer.byteLength('ok blob-cmd'));
});

test('H3: unknown handle rejected clearly, never guessed', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace);
  await snapshotTurn(trace);
  const out = await tool(trace, 'trace_expand').execute({ ref: 'e42' }, host());
  assert.equal(out.metadata.raw.ok, false);
  assert.match(out.metadata.raw.error, /Unknown evidence handle 'e42'/);
  assert.equal(out.metadata.raw.native_execution, 'unaffected');
});

test('H4: handle from a superseded snapshot generation is expired', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace);
  const { assignments } = await snapshotTurn(trace);
  assert.ok(assignments.length > 0);
  trace.handles.newGeneration('s1', []); // next request: fresh, empty mapping
  const out = await tool(trace, 'trace_expand').execute({ ref: 'e1' }, host());
  assert.equal(out.metadata.raw.ok, false);
  assert.match(out.metadata.raw.error, /Expired evidence handle 'e1'/);
});

test('H5: handle from another session is rejected as foreign', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace);
  await snapshotTurn(trace, 's1');
  trace.handles.newGeneration('s2', []);
  const out = await tool(trace, 'trace_expand').execute({ ref: 'e1' }, host('s2'));
  assert.equal(out.metadata.raw.ok, false);
  assert.match(out.metadata.raw.error, /belongs to a different session/);
});

test('H6: restart regenerates the mapping from canonical refs; pre-restart handles are unknown', async t => {
  const { trace, dir } = await fixture(t);
  await captureOne(trace, 'resume-cmd');
  const { assignments } = await snapshotTurn(trace);
  const canonical = assignments.find(a => a.handle === 'e1').ref;
  // Simulate restart: a brand-new Trace instance over the same durable store
  // root recovers events from CAS; its handle registry starts empty.
  const trace2 = new Trace({ location: { directory: dir } }, { storeRoot: path.join(dir, 'store') });
  await trace2.ready;
  try {
    assert.equal(trace2.handles.resolve('s1', 'e1').ok, false, 'fresh process has no mapping');
    const fresh = trace2.recallSnapshot('s1');
    trace2.handles.newGeneration('s1', fresh.assignments);
    const again = trace2.handles.resolve('s1', 'e1');
    assert.equal(again.ok, true);
    assert.equal(again.ref, canonical, 'resume must re-derive the same handle -> canonical ref');
  } finally {
    trace2.store.close();
  }
});

test('H7: durable note stores full canonical refs only (handles never persisted)', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace);
  const { assignments } = await snapshotTurn(trace);
  const canonical = assignments.find(a => a.handle === 'e1').ref;
  const out = await tool(trace, 'trace_note').execute(
    { kind: 'finding', text: 'cited via handle', source_handles: ['e1'] }, host());
  assert.equal(out.metadata.raw.ok, true);
  const noteRef = out.metadata.raw.ref;
  const ev = await trace.store.readEvent(noteRef);
  const data = JSON.parse(await trace.store.readBlob(ev.payload.ref));
  assert.deepEqual(data.source_refs, [canonical]);
  assert.equal('source_handles' in data, false);
  assert.equal(JSON.stringify(ev.note.source_refs), JSON.stringify([canonical]));
});

test('H8: correction/supersedes through a note handle stores canonical refs', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace);
  await snapshotTurn(trace);
  const first = await tool(trace, 'trace_note').execute({ kind: 'finding', text: 'initial claim' }, host());
  assert.equal(first.metadata.raw.ok, true);
  // n1 was assigned to the note by the turn snapshot? The note was created
  // after snapshot install, so use discovery registration via a fresh snapshot.
  const { assignments } = trace.recallSnapshot('s1');
  trace.handles.newGeneration('s1', assignments);
  const noteHandle = assignments.find(a => a.ref === first.metadata.raw.ref)?.handle;
  assert.ok(noteHandle, 'created note must be handle-mapped by the new snapshot');
  assert.match(noteHandle, /^n[0-9]+$/);
  const second = await tool(trace, 'trace_note').execute(
    { kind: 'correction', text: 'corrected claim', supersedes: [noteHandle] }, host());
  assert.equal(second.metadata.raw.ok, true);
  const ev = await trace.store.readEvent(second.metadata.raw.ref);
  const data = JSON.parse(await trace.store.readBlob(ev.payload.ref));
  assert.deepEqual(data.supersedes, [first.metadata.raw.ref]);
});

test('H9: trace_expand(handle) equals trace_expand(canonical) byte-for-byte', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace, 'identical-bytes');
  const { assignments } = await snapshotTurn(trace);
  const canonical = assignments.find(a => a.handle === 'e1').ref;
  const viaHandle = await tool(trace, 'trace_expand').execute({ ref: 'e1', limit: 4096 }, host());
  const viaCanonical = await tool(trace, 'trace_expand').execute({ ref: canonical, limit: 4096 }, host());
  // Same verified bytes and metadata; presentation may differ only by the
  // additive discovery-handle line registered by the first call.
  assert.equal(viaHandle.metadata.raw.exact_base64, viaCanonical.metadata.raw.exact_base64);
  assert.equal(viaHandle.metadata.raw.sha256, viaCanonical.metadata.raw.sha256);
  assert.equal(viaHandle.metadata.raw.total_bytes, viaCanonical.metadata.raw.total_bytes);
  assert.equal(viaHandle.metadata.raw.metadata.payload.ref, viaCanonical.metadata.raw.metadata.payload.ref);
});

test('H10: canonical ref APIs unchanged (full refs accepted everywhere as before)', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace);
  const { assignments } = await snapshotTurn(trace);
  const canonical = assignments.find(a => a.handle === 'e1').ref;
  const direct = await trace.store.expand(canonical, 0, 2048, false);
  assert.equal(direct.ref, canonical);
  assert.equal(direct.hash_verified, true);
  const out = await tool(trace, 'trace_note').execute(
    { kind: 'fact', text: 'canonical citation', source_refs: [canonical] }, host());
  assert.equal(out.metadata.raw.ok, true);
});

test('H11: no prefix-collision or truncated-SHA semantics introduced', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace);
  await snapshotTurn(trace);
  // 63-hex truncated copy stays rejected in both interpretations.
  const truncated = await tool(trace, 'trace_expand').execute(
    { ref: 'evt_babbf2641d782c8c17960df6c6e59218cf758a482d33bf1655e085a71f7d7' }, host());
  assert.equal(truncated.metadata.raw.ok, false);
  assert.match(truncated.metadata.raw.error, /Invalid ref/);
  // Zero-padded ordinal is not a handle and not a canonical ref.
  const padded = await tool(trace, 'trace_expand').execute({ ref: 'e01' }, host());
  assert.equal(padded.metadata.raw.ok, false);
  assert.doesNotMatch(padded.metadata.raw.error, /handle/i, 'e01 must not be treated as a handle');
  // handle-form string inside a *_handles array field rejects precisely.
  const bad = await tool(trace, 'trace_note').execute(
    { kind: 'fact', text: 'x', source_handles: ['e1x'] }, host());
  assert.equal(bad.metadata.raw.ok, false);
  assert.match(bad.metadata.raw.error, /accepts only evidence handles/);
  assert.ok(HANDLE_PATTERN.test('n1') && HANDLE_PATTERN.test('b12') && !HANDLE_PATTERN.test('evt_abc'));
});

test('A1: handle assignment is deterministic for the same snapshot state', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace, 'det-a');
  await captureOne(trace, 'det-b');
  const one = assignSnapshotHandles(trace.recallSnapshot('s1').snapshot);
  const two = assignSnapshotHandles(trace.recallSnapshot('s1').snapshot);
  assert.deepEqual(one, two);
  assert.equal(one[0].handle, 'e1');
});

test('A2: trace_find registers discovery handles usable for trace_expand', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace, 'findme-unique-9f31');
  await snapshotTurn(trace);
  const found = await tool(trace, 'trace_find').execute({ text: 'findme-unique-9f31' }, host());
  assert.equal(found.metadata.raw.ok, true);
  const row = found.metadata.raw.results.find(r => r.handle);
  assert.ok(row, 'search results must carry discovery handles');
  const out = await tool(trace, 'trace_expand').execute({ ref: row.handle }, host());
  assert.equal(out.metadata.raw.ok, true);
  assert.equal(out.metadata.raw.ref, row.ref);
});

test('A3: milestone evidence_handles resolve before storage; strong-state downgrade unaffected', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace, 'evidence-source');
  const { assignments } = await snapshotTurn(trace);
  const canonical = assignments.find(a => a.handle === 'e1').ref;
  const out = await tool(trace, 'trace_note').execute(
    { kind: 'finding', milestone: { kind: 'verification', summary: 'claimed verified', current_state: 'verified', evidence_handles: ['e1'] } }, host());
  assert.equal(out.metadata.raw.ok, true);
  const ev = await trace.store.readEvent(out.metadata.raw.ref);
  const data = JSON.parse(await trace.store.readBlob(ev.payload.ref));
  assert.deepEqual(data.milestone.evidence_refs, [canonical]);
  assert.equal(data.milestone.current_state, 'verified', 'verified evidence ref keeps the strong state');
});

test('A4: trace_status discovery handles let the model act without copying hex', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace, 'status-visible');
  // No snapshot handles installed: status discovery must map the visible refs.
  trace.handles.newGeneration('s1', []);
  const status = await tool(trace, 'trace_status').execute({}, host());
  assert.equal(status.metadata.raw.ok, true);
  const handled = status.metadata.raw.recent.find(r => r.handle);
  assert.ok(handled, 'status recent rows should carry discovery handles');
  const out = await tool(trace, 'trace_expand').execute({ ref: handled.handle }, host());
  assert.equal(out.metadata.raw.ok, true);
  assert.equal(out.metadata.raw.ref, handled.ref);
});
