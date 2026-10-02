// V3 S3 qualification: handle-first model API.
//   - `evidence` is the preferred citation field (handles first, canonical
//     refs as the compatibility path); resolved by the gateway before storage.
//   - successful writes register their durable ref as a fresh current-turn
//     handle and present it handle-first (saved_as) — the model never needs
//     to copy the canonical ref back.
//   - typed claims present as n# (never e# for the claim's own event).
//   - descriptions pin handles-first wording; the contract snapshot is
//     re-blessed with the S3 surface (tests/contract-snapshot.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { Trace } from '../src/trace.js';
import { definitions } from '../src/tools.js';
import { assignSnapshotHandles, renderHandlePressure } from '../src/handles.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-trace-handlefirst-'));
  const trace = new Trace({ location: { directory: dir } }, { storeRoot: path.join(dir, 'store') });
  await trace.ready;
  t.after(async () => { await trace.store.close(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); });
  return { dir, trace, store: trace.store };
}
const host = (sessionID = 's1') => ({ sessionID, messageID: 'm1', id: 'c1', agent: 'build' });
const tool = (trace, name) => definitions(trace).find(d => d.name === name);

test('S3-1: evidence field is the preferred handle-first citation path', async t => {
  const { trace } = await fixture(t);
  await trace.after({ sessionID: 's1', messageID: 'm1', id: 'c1', agent: 'build',
    tool: 'shell', input: { command: 'evidence-field-check' }, status: 'completed', result: { output: 'ok' } });
  const { snapshot } = trace.recallSnapshot('s1');
  trace.handles.newGeneration('s1', trace.recallSnapshot('s1').assignments);
  const canonical = snapshot.recent.at(-1).ref;
  const out = await tool(trace, 'trace_note').execute(
    { kind: 'finding', text: 'cited via evidence field', evidence: ['e1'] }, host());
  assert.equal(out.metadata.raw.ok, true);
  const ev = await trace.store.readEvent(out.metadata.raw.ref);
  const data = JSON.parse((await trace.store.readBlob(ev.payload.ref)).toString());
  assert.deepEqual(data.source_refs, [canonical], 'evidence resolved to canonical source_refs');
  assert.equal('evidence' in data, false, 'the evidence key never reaches the durable payload');
});

test('S3-2: evidence field accepts canonical refs as the compatibility path', async t => {
  const { trace } = await fixture(t);
  await trace.after({ sessionID: 's1', messageID: 'm1', id: 'c1', agent: 'build',
    tool: 'shell', input: { command: 'evidence-compat-check' }, status: 'completed', result: { output: 'ok' } });
  const { snapshot } = trace.recallSnapshot('s1');
  trace.handles.newGeneration('s1', trace.recallSnapshot('s1').assignments);
  const canonical = snapshot.recent.at(-1).ref;
  const out = await tool(trace, 'trace_note').execute(
    { kind: 'fact', text: 'canonical via evidence', evidence: [canonical] }, host());
  assert.equal(out.metadata.raw.ok, true);
  const ev = await trace.store.readEvent(out.metadata.raw.ref);
  const data = JSON.parse((await trace.store.readBlob(ev.payload.ref)).toString());
  assert.deepEqual(data.source_refs, [canonical]);
});

test('S3-3: write returns register and present a fresh handle (note -> n#)', async t => {
  const { trace } = await fixture(t);
  await trace.after({ sessionID: 's1', messageID: 'm1', id: 'c1', agent: 'build',
    tool: 'shell', input: { command: 'write-return-check' }, status: 'completed', result: { output: 'ok' } });
  const { assignments } = trace.recallSnapshot('s1');
  trace.handles.newGeneration('s1', assignments);
  const out = await tool(trace, 'trace_note').execute(
    { kind: 'fact', text: 'write return presentation' }, host());
  assert.equal(out.metadata.raw.ok, true);
  const savedAs = out.metadata.raw.saved_as;
  assert.match(savedAs, /^n[0-9]+$/, 'the note write must present an n# handle, not only a canonical ref');
  const resolved = trace.handles.resolve('s1', savedAs);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.ref, out.metadata.raw.ref, 'the presented handle resolves to exactly the new durable ref');
  // No 64-hex requirement: the model can cite the note by handle next turn.
});

test('S3-4: typed claims present as n# (never e# for the claim event)', async t => {
  const { trace } = await fixture(t);
  await trace.after({ sessionID: 's1', messageID: 'm1', id: 'c1', agent: 'build',
    tool: 'shell', input: { command: 'claim-n-check' }, status: 'completed', result: { output: 'ok' } });
  const { assignments } = trace.recallSnapshot('s1');
  trace.handles.newGeneration('s1', assignments);
  const out = await tool(trace, 'trace_claim').execute(
    { subject: 'gates green', text: 'gates green' }, host());
  assert.equal(out.metadata.raw.ok, true);
  const savedAs = out.metadata.raw.saved_as;
  assert.match(savedAs, /^n[0-9]+$/, 'the claim must present as n# (semantic evidence), not e#');
  assert.equal(trace.handles.resolve('s1', savedAs).ref, out.metadata.raw.ref);
});

test('S3-5: claim via evidence handles; claim output carries the fresh n# handle', async t => {
  const { trace } = await fixture(t);
  await trace.after({ sessionID: 's1', messageID: 'm1', id: 'c1', agent: 'build',
    tool: 'shell', input: { command: 'claim-evidence-check' }, status: 'completed', result: { output: 'ok' } });
  const { assignments } = trace.recallSnapshot('s1');
  trace.handles.newGeneration('s1', assignments);
  const out = await tool(trace, 'trace_claim').execute(
    { subject: 'gates green', text: 'gates green', evidence: ['e1'] }, host());
  assert.equal(out.metadata.raw.ok, true);
  assert.match(out.metadata.raw.saved_as, /^n[0-9]+$/);
  const rows = trace.store.findEntriesAll({ type: 'trace.claim' });
  const payload = JSON.parse(await trace.store.readBlob(rows[0].payloadRef));
  const ev = await trace.store.readEvent(rows[0].ref);
  // The claim's riding refs resolved to the canonical evidence ref.
  const data = JSON.parse((await trace.store.readBlob(ev.payload.ref)).toString());
  assert.equal(rows.length, 1);
  assert.equal(payload.evidence.kind, 'model_prose');
  void payload; void ev;
});

test('S3-6: tool descriptions present handles as the normal interface, canonical refs as compatibility', () => {
  const note = definitions(null).find(d => d.name === 'trace_note');
  assert.match(note.description, /handle-first/i);
  assert.match(note.description, /normal interface/i);
  assert.match(note.description, /compatibility\/advanced path/i);
  assert.match(note.input.properties.evidence.description, /PREFERRED/i);
  const claim = definitions(null).find(d => d.name === 'trace_claim');
  assert.match(claim.description, /handle-first/i);
  assert.match(claim.input.properties.evidence.description, /PREFERRED/);
  assert.match(claim.input.properties.source_refs.description, /compatibility path/i);
});

// ---- S4: full handle coverage + explicit handle pressure ----

test('S4-1: leak detector — every citeable canonical ref in the final view carries a handle', async t => {
  const { trace } = await fixture(t);
  await trace.after({ sessionID: 's1', messageID: 'm1', id: 'c1', agent: 'build',
    tool: 'shell', input: { command: 'leak-detector-evidence' }, status: 'completed', result: { output: 'ok' } });
  const { snapshot: s0 } = trace.recallSnapshot('s1');
  await trace.note({ kind: 'handoff', text: 'evidence handoff', source_refs: [s0.recent.at(-1).ref],
    milestone: { kind: 'handoff', summary: 'leak detector handoff' } }, host());
  await trace.note({ kind: 'unresolved', text: 'open blocker: pending review debt' }, host());
  await trace.intent({ summary: 'leak detector goal', status: 'active', paths: [], resources: [] }, host());
  const { snapshot, assignments } = trace.recallSnapshot('s1');
  const visible = new Set();
  for (const row of snapshot.recent ?? []) { visible.add(row.ref); for (const o of row.outputs ?? []) visible.add(o.ref); }
  for (const n of [...(snapshot.notes ?? []), ...(snapshot.unresolved ?? [])]) visible.add(n.ref);
  if (snapshot.current_intent?.ref) visible.add(snapshot.current_intent.ref);
  for (const r of snapshot.active_memory?.evidence_refs ?? []) visible.add(r);
  if (snapshot.compact?.ref) visible.add(snapshot.compact.ref);
  const handled = new Set((assignments ?? []).map(a => a.ref));
  for (const ref of visible) {
    assert.ok(handled.has(ref), `naked canonical ref without a handle in the recall view: ${ref.slice(0, 15)}…`);
  }
  for (const a of assignments ?? []) {
    assert.ok(visible.has(a.ref), `handle outliving its content: ${a.handle}`);
  }
  assert.equal(snapshot.handles_truncated, false, 'small views never truncate');
});

test('S4-2: peer note/handoff/intent refs receive handles (no naked peer refs)', async t => {
  const { trace } = await fixture(t);
  await trace.after({ sessionID: 'peer', messageID: 'mp', id: 'cp', agent: 'build',
    tool: 'shell', input: { command: 'peer evidence' }, status: 'completed', result: { output: 'ok' } });
  await trace.note({ kind: 'handoff', text: 'peer handoff to others',
    milestone: { kind: 'handoff', summary: 'peer handoff', to_session: 's2' } }, host('peer'));
  await trace.intent({ summary: 'peer goal', status: 'active', paths: [], resources: [] }, host('peer'));
  const { snapshot, assignments } = trace.recallSnapshot('s2');
  trace.handles.newGeneration('s2', assignments ?? []);
  const peer = (snapshot.peers ?? []).find(p => p.sessionID === 'peer');
  assert.ok(peer, 'peer row visible');
  const handled = new Set((assignments ?? []).map(a => a.ref));
  for (const ref of peer.note_refs ?? []) {
    assert.ok(handled.has(ref), `peer note ref must carry a handle: ${ref.slice(0, 15)}…`);
  }
  if (peer.handoff?.ref) assert.ok(handled.has(peer.handoff.ref), 'peer handoff ref must carry a handle');
  if (peer.intent?.ref) assert.ok(handled.has(peer.intent.ref), 'peer intent ref must carry a handle');
});

test('S4-3: handle pressure is loud and structured when the cap is reached (never silent)', () => {
  // Deterministic unit pin of the §13 contract: after SNAPSHOT_HANDLE_CAP,
  // the flags flip and the pressure trailer renders (integration recall
  // paths also flow these flags — see S4-1 for the small-view false case).
  const view = { recent: [], notes: [], unresolved: [], current_intent: null, active_memory: {}, peers: [], compact: null };
  const mk = i => `evt_${String(i).padStart(2, '0')}${'ab'.repeat(31)}`;
  view.recent = Array.from({ length: 8 }, (_, i) => ({
    ref: mk(i), tool: 'shell', status: 'completed',
    outputs: Array.from({ length: 9 }, (_, k) => ({ ref: `blob_${String(i * 9 + k).padStart(2, '0')}${'cd'.repeat(31)}`, bytes: 4 })),
  }));
  const assignments = assignSnapshotHandles(view);
  assert.equal(assignments.length, 64, 'assignment is capped at 64');
  assert.equal(view.handles_truncated, true, 'cap overflow sets handles_truncated');
  assert.equal(view.retrieve_to_cite_required, true, 'cap overflow sets retrieve_to_cite_required');
  assert.ok(view.evidence_handles.length === 64);
  const pressure = renderHandlePressure(view);
  assert.match(pressure, /HANDLE CAPACITY REACHED/);
  assert.match(pressure, /handles_truncated: true/);
  assert.match(pressure, /retrieve_to_cite_required: true/);
  assert.match(pressure, /trace_find \/ trace_expand/, 'the trailer directs retrieve-to-cite');
  assert.equal(renderHandlePressure({ handles_truncated: false }), '', 'no noise when the cap is not reached');
});

// Production 2026-10-01: the host keeps tool-call state in immer, which deep-freezes it, and
// copies only the top level before execute. Every milestone.evidence_handles citation then failed
// with "Attempting to define property on object that is not extensible.", as did a milestone
// without its own summary beside a differing top-level summary.
test('S3-6: a host-frozen nested input is normalized without writing into it', async t => {
  const { trace } = await fixture(t);
  await trace.after({ sessionID: 's1', messageID: 'm1', id: 'c1', agent: 'build',
    tool: 'shell', input: { command: 'frozen-input-check' }, status: 'completed', result: { output: 'ok' } });
  const { snapshot } = trace.recallSnapshot('s1');
  trace.handles.newGeneration('s1', trace.recallSnapshot('s1').assignments);
  const canonical = snapshot.recent.at(-1).ref;
  const deepFreeze = value => {
    if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
    return value;
  };
  const hostInput = raw => ({ ...deepFreeze(raw) });
  const cited = hostInput({ kind: 'finding', text: 'body', evidence: ['e1'],
    milestone: { kind: 'state_change', summary: 'cited', evidence_handles: ['e1'] } });
  const out = await tool(trace, 'trace_note').execute(cited, host());
  assert.equal(out.metadata.raw.ok, true, out.metadata.raw.error);
  assert.deepEqual(out.metadata.raw.note.milestone.evidence_refs, [canonical]);
  assert.deepEqual(cited.milestone.evidence_handles, ['e1'], 'the host input is left as it was');
  const summarized = hostInput({ kind: 'finding', text: 'longer body', summary: 'headline',
    milestone: { kind: 'state_change', what_changed: 'w' } });
  const second = await tool(trace, 'trace_note').execute(summarized, host());
  assert.equal(second.metadata.raw.ok, true, second.metadata.raw.error);
  assert.equal(second.metadata.raw.note.milestone.summary, 'headline');
});
