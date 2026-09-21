// PART II H-matrix qualification for the V2-handlefix architecture.
//
// Implements the final-handoff handle-coverage contract from the
// final-handoff handle-audit mission (§29 H1..H18). tests/handles.test.js
// carries the Phase-A matrix under the same H labels — a DIFFERENT numbering;
// this file pins the handlefix behavior:
//   - current-turn and retrieve-to-cite citation paths (H1/H2)
//   - malformed-length refs rejected fail-closed, diagnostics never applied (H3-H6)
//   - every handle-accepting field resolves to canonical durable refs (H7-H10)
//   - multi-turn final handoff without manual SHA copying (H11)
//   - Phase E pruning never separates a citeable ref from its handle (H12)
//   - Reviewer receipt -> typed claim -> handle -> handoff (H13)
//   - expiry/foreign rejection and API/CAS/prefix invariants (H14-H18)
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Trace, RECALL_MARKER, RECALL_EVIDENCE_POLICY } from '../src/trace.js';
import { definitions } from '../src/tools.js';
import { assignSnapshotHandles, HANDLE_PATTERN } from '../src/handles.js';

async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-trace-handlefix-'));
  const trace = new Trace({ location: { directory: dir } }, { storeRoot: path.join(dir, 'store'), ...options });
  await trace.ready;
  t.after(async () => { await trace.store.close(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); });
  return { dir, trace, store: trace.store };
}
const host = (sessionID = 's1') => ({ sessionID, messageID: 'm1', id: 'c1', agent: 'build' });
const tool = (trace, name) => definitions(trace).find(d => d.name === name);

async function captureOne(trace, command = 'node --test', sessionID = 's1') {
  await trace.after({ sessionID, messageID: 'm1', id: 'c1', agent: 'build',
    tool: 'shell', input: { command }, status: 'completed', result: { output: `ok ${command}` } });
}
async function turn(trace, sessionID = 's1') {
  const { snapshot, assignments } = trace.recallSnapshot(sessionID);
  trace.handles.newGeneration(sessionID, assignments ?? []);
  return { snapshot, assignments };
}
const notePayload = async (trace, ref) => {
  const ev = await trace.store.readEvent(ref);
  return JSON.parse((await trace.store.readBlob(ev.payload.ref)).toString());
};
const noteCount = trace => trace.store.findEntriesAll({ type: 'trace.note' }).length;
const isCanonical = r => /^(evt|blob)_[0-9a-f]{64}$/.test(r);

const COMMIT_A = 'a'.repeat(64);
const validReceipt = () => ({
  checkID: `chk_${'1'.repeat(32)}`, kind: 'test', status: 'passed', commandExitCode: 0,
  timedOut: false, signal: 'none', candidate: { commit: COMMIT_A, branch: 'candidate/v2-handlefix' },
  output: { sha256: 'c'.repeat(64) },
});

test('HF-H1: current-turn evidence has a handle; final handoff cites the handle and stores canonical refs', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace, 'gate-evidence-hf1');
  const { snapshot } = await turn(trace);
  const canonical = snapshot.recent.at(-1).ref;
  const out = await tool(trace, 'trace_note').execute(
    { kind: 'handoff', text: 'final gate closed', source_handles: ['e1'],
      milestone: { kind: 'handoff', summary: 'final gate closed', evidence_handles: ['e1'] } }, host());
  assert.equal(out.metadata.raw.ok, true);
  const data = await notePayload(trace, out.metadata.raw.ref);
  assert.deepEqual(data.source_refs, [canonical]);
  assert.deepEqual(data.milestone.evidence_refs, [canonical]);
  assert.equal('source_handles' in data, false);
  assert.equal('evidence_handles' in data.milestone, false);
});

test('HF-H2: historical evidence without a current handle — retrieve via trace_find, fresh handle, cite', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace, 'legacy-marker-hf2');
  await turn(trace); // generation 1 knows e1
  trace.handles.newGeneration('s1', []); // generation 2: handle expired
  const found = await tool(trace, 'trace_find').execute({ text: 'legacy-marker-hf2' }, host());
  const row = found.metadata.raw.results.find(r => r.handle);
  assert.ok(row, 'retrieve-to-cite must register a fresh discovery handle');
  const out = await tool(trace, 'trace_note').execute(
    { kind: 'finding', text: 'recovered historical evidence', source_handles: [row.handle] }, host());
  assert.equal(out.metadata.raw.ok, true);
  const data = await notePayload(trace, out.metadata.raw.ref);
  assert.deepEqual(data.source_refs, [row.ref], 'cited handle resolved to the historical canonical ref');
});

test('HF-H3: malformed 65-hex ref rejected fail-closed, nothing persisted', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace);
  await turn(trace);
  const bad = `evt_${'9f'}${'a'.repeat(63)}`; // 65 hex chars
  const out = await tool(trace, 'trace_note').execute(
    { kind: 'fact', text: 'typo attempt', source_refs: [bad] }, host());
  assert.equal(out.metadata.raw.ok, false);
  assert.match(out.metadata.raw.error, /Invalid source_refs\[0\]/);
  assert.equal(noteCount(trace), 0, 'no note persisted for a malformed ref');
});

test('HF-H4: malformed 63/61/49-hex refs all rejected fail-closed', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace);
  await turn(trace);
  for (const n of [63, 61, 49]) {
    const bad = `evt_${'9f'}${'a'.repeat(n - 2)}`;
    const out = await tool(trace, 'trace_note').execute(
      { kind: 'fact', text: `typo ${n}`, source_refs: [bad] }, host());
    assert.equal(out.metadata.raw.ok, false, `${n}-hex must reject`);
    assert.match(out.metadata.raw.error, /Invalid source_refs\[0\]/);
  }
  assert.equal(noteCount(trace), 0);
});

test('HF-H5: no automatic truncation or prefix repair of a REAL ref', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace, 'real-ref-hf5');
  const { snapshot } = await turn(trace);
  const real = snapshot.recent.at(-1).ref;
  const hex = real.slice(4);
  for (const mutated of [`evt_${hex.slice(0, -1)}`, `evt_${hex}a`]) { // 63 and 65 hex
    const out = await tool(trace, 'trace_note').execute(
      { kind: 'fact', text: 'near-miss copy', source_refs: [mutated] }, host());
    assert.equal(out.metadata.raw.ok, false, `${mutated.length - 4}-hex near-miss must reject`);
    assert.equal(noteCount(trace), 0, 'no silent repair: a near-miss never becomes the real ref');
  }
  const expand = await tool(trace, 'trace_expand').execute({ ref: `evt_${hex.slice(0, -1)}` }, host());
  assert.equal(expand.metadata.raw.ok, false);
  assert.match(expand.metadata.raw.error, /Invalid ref/);
});

test('HF-H6: unique diagnostic hint may name the exact canonical candidate, never auto-applied', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace, 'hint-target-hf6');
  const { snapshot } = await turn(trace);
  const real = snapshot.recent.at(-1).ref;
  const hex = real.slice(4);
  // A 65-hex near-miss (one extra hex char) stays malformed: >=16 hex chars
  // shared with exactly one stored ref, so the diagnostic may name it.
  const mutated = `evt_${hex}a`;
  assert.notEqual(mutated, real);
  const out = await tool(trace, 'trace_note').execute(
    { kind: 'fact', text: 'one-char typo of a real ref', source_refs: [mutated] }, host());
  assert.equal(out.metadata.raw.ok, false, 'malformed ref is still rejected');
  assert.match(out.metadata.raw.error, /Invalid source_refs\[0\]/);
  assert.match(out.metadata.raw.error, /Closest stored ref: evt_[0-9a-f]{64}/, 'diagnostic names the exact candidate');
  assert.ok(out.metadata.raw.error.includes(real), 'the candidate is the full canonical ref');
  assert.equal(noteCount(trace), 0, 'the hint is never auto-applied');
  // Well-formed-but-unknown refs get the handle-first diagnostic instead.
  const unknown = `evt_${'9f'.repeat(32)}`;
  const out2 = await tool(trace, 'trace_note').execute(
    { kind: 'fact', text: 'plausible but unknown ref', source_refs: [unknown] }, host());
  assert.equal(out2.metadata.raw.ok, false);
  assert.match(out2.metadata.raw.error, /not found in this workspace/);
  assert.match(out2.metadata.raw.error, /Current turn evidence handles: e1/, 'diagnostic lists the live handles');
  assert.equal(noteCount(trace), 0, 'still nothing persisted');
});

test('HF-H7: milestone evidence_handles resolve to canonical durable evidence_refs', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace, 'verification-source-hf7');
  const { snapshot } = await turn(trace);
  const canonical = snapshot.recent.at(-1).ref;
  const out = await tool(trace, 'trace_note').execute(
    { kind: 'finding', text: 'gate verified',
      milestone: { kind: 'verification', summary: 'gate verified', current_state: 'verified', evidence_handles: ['e1'] } }, host());
  assert.equal(out.metadata.raw.ok, true);
  const data = await notePayload(trace, out.metadata.raw.ref);
  assert.deepEqual(data.milestone.evidence_refs, [canonical]);
});

test('HF-H8: source_handles resolve to canonical source_refs in the durable note', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace, 'source-hf8');
  const { snapshot } = await turn(trace);
  const canonical = snapshot.recent.at(-1).ref;
  const out = await tool(trace, 'trace_note').execute(
    { kind: 'fact', text: 'cited by handle', source_handles: ['e1'] }, host());
  assert.equal(out.metadata.raw.ok, true);
  const data = await notePayload(trace, out.metadata.raw.ref);
  assert.deepEqual(data.source_refs, [canonical]);
  assert.equal('source_handles' in data, false);
});

test('HF-H9: supersedes/depends_on handle paths resolve canonically and stay guarded', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace);
  await turn(trace);
  const first = await tool(trace, 'trace_note').execute({ kind: 'finding', text: 'initial claim' }, host());
  assert.equal(first.metadata.raw.ok, true);
  const { assignments } = await turn(trace); // note becomes handle-mapped
  const noteHandle = assignments.find(a => a.ref === first.metadata.raw.ref)?.handle;
  assert.ok(noteHandle && /^n[0-9]+$/.test(noteHandle));
  const second = await tool(trace, 'trace_note').execute(
    { kind: 'correction', text: 'corrected claim', supersedes: [noteHandle], depends_on: [noteHandle] }, host());
  assert.equal(second.metadata.raw.ok, true);
  const data = await notePayload(trace, second.metadata.raw.ref);
  assert.deepEqual(data.supersedes, [first.metadata.raw.ref]);
  assert.deepEqual(data.depends_on, [first.metadata.raw.ref]);
  // Guard intact: a tool-event handle is not a note and cannot be superseded.
  const bad = await tool(trace, 'trace_note').execute(
    { kind: 'correction', text: 'wrong target', supersedes: ['e1'] }, host());
  assert.equal(bad.metadata.raw.ok, false);
  assert.match(bad.metadata.raw.error, /supersedes must reference a note from your own session/);
});

test('HF-H10: durable notes contain zero handles across every handle-accepting field', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace, 'evidence-hf10');
  await turn(trace);
  const a = await tool(trace, 'trace_note').execute(
    { kind: 'decision', text: 'decided A', source_handles: ['e1'], supersedes: [], depends_on: [] }, host());
  await turn(trace); // a gets its n#
  const aHandle = trace.recallSnapshot('s1').assignments.find(x => a.metadata.raw.ref === x.ref)?.handle
    ?? trace.handles.handleFor('s1', a.metadata.raw.ref);
  await tool(trace, 'trace_note').execute(
    { kind: 'correction', text: 'superseding via handle', supersedes: [aHandle], depends_on: [aHandle],
      milestone: { kind: 'decision', summary: 'superseding via handle', decision: 'B', evidence_handles: ['e1'] } }, host());
  const rows = trace.store.findEntriesAll({ type: 'trace.note' });
  assert.ok(rows.length >= 2);
  for (const row of rows) {
    const data = await notePayload(trace, row.ref);
    assert.equal('source_handles' in data, false);
    assert.equal('evidence_handles' in (data.milestone ?? {}), false);
    for (const field of [data.source_refs ?? [], data.supersedes ?? [], data.depends_on ?? [], data.milestone?.evidence_refs ?? []]) {
      for (const r of field) assert.ok(isCanonical(r), `durable ref must be canonical, got ${r}`);
    }
    assert.doesNotMatch(JSON.stringify(data), /"(source_handles|evidence_handles)"/);
  }
});

test('HF-H11: multi-turn final handoff requires zero manual SHA copies', async t => {
  const { trace } = await fixture(t);
  const MARK = 'legacy-marker-hf11';
  await captureOne(trace, `legacy evidence ${MARK}`);
  await turn(trace); // turn 1: original evidence, handle known
  await captureOne(trace, 'later work A');
  await turn(trace); // turn 2: original handle expires
  await captureOne(trace, 'later work B');
  await turn(trace); // turn 3
  // Finalization turn: retrieve-to-cite only — no canonical string is passed anywhere.
  const found = await tool(trace, 'trace_find').execute({ text: MARK }, host());
  const row = found.metadata.raw.results.find(r => r.handle);
  assert.ok(row, 'historical evidence must be retrievable');
  const input = {
    kind: 'handoff', text: 'campaign complete', source_handles: [row.handle],
    milestone: { kind: 'handoff', summary: 'campaign complete', evidence_handles: [row.handle] },
  };
  assert.doesNotMatch(JSON.stringify(input), /[0-9a-f]{64}/, 'the handoff input contains no SHA string');
  const out = await tool(trace, 'trace_note').execute(input, host());
  assert.equal(out.metadata.raw.ok, true);
  const data = await notePayload(trace, out.metadata.raw.ref);
  assert.deepEqual(data.source_refs, [row.ref]);
  assert.deepEqual(data.milestone.evidence_refs, [row.ref]);
  // The inherited evidence also flows into active memory for later sessions.
  const { snapshot } = await turn(trace);
  assert.ok((snapshot.active_memory.evidence_refs ?? []).includes(row.ref),
    'final handoff evidence becomes the next turn\'s active-memory evidence');
});

test('HF-H12: Phase E pruning never leaves a citeable canonical ref without its advertised handle', async t => {
  const { trace } = await fixture(t, { runtimeContextTokenBudget: 900 });
  // Pressure: enough content to force pruning with a small budget.
  for (let i = 0; i < 30; i++) {
    await trace.after({ sessionID: 's1', messageID: `m${i}`, id: `c${i}`, agent: 'build', tool: 'shell',
      input: { command: `pressure-${i}-with-a-fairly-long-command-line-payload` },
      status: 'completed', result: { output: `output ${i}: ${'x'.repeat(300)}` } });
  }
  await trace.note({ kind: 'unresolved', text: 'review debt: pending reviewer findings on module X' }, host());
  await trace.note({ kind: 'decision', text: 'chose approach A over B for the parser' }, host());
  await trace.intent({ summary: 'finish the parser migration with tests', status: 'active', paths: ['x.py'], resources: [] }, host());
  // A handoff note carrying evidence refs makes them active-memory evidence.
  await trace.note({ kind: 'handoff', text: 'parser handoff', milestone: { kind: 'handoff', summary: 'parser handoff', evidence_refs: [] } }, host());
  const { snapshot, assignments } = trace.recallSnapshot('s1');
  assert.ok((snapshot.context_budget?.dropped ?? []).length > 0, 'pruning must actually engage');
  const visible = new Set();
  for (const row of snapshot.recent ?? []) { visible.add(row.ref); for (const o of row.outputs ?? []) visible.add(o.ref); }
  for (const n of [...(snapshot.notes ?? []), ...(snapshot.unresolved ?? [])]) visible.add(n.ref);
  if (snapshot.current_intent?.ref) visible.add(snapshot.current_intent.ref);
  for (const r of snapshot.active_memory?.evidence_refs ?? []) visible.add(r);
  for (const a of assignments ?? []) {
    assert.ok(visible.has(a.ref), `handle ${a.handle} must never outlive its content (${a.ref.slice(0, 15)}…)`);
  }
  const handled = new Set((assignments ?? []).map(a => a.ref));
  for (const r of snapshot.active_memory?.evidence_refs ?? []) {
    assert.ok(handled.has(r), `surviving active-memory evidence must carry a handle (${r.slice(0, 15)}…)`);
  }
});

test('HF-H12-mutant: assignSnapshotHandles covers active-memory evidence even with no recent rows', async t => {
  const ref = `evt_${'ab'.repeat(32)}`;
  const view = { recent: [], outputs: [], notes: [], unresolved: [], current_intent: null,
    active_memory: { evidence_refs: [ref] } };
  const assignments = assignSnapshotHandles(view);
  const row = assignments.find(a => a.ref === ref);
  assert.ok(row, 'anti-mutant: active-memory evidence refs must receive handles');
  assert.match(row.handle, /^e[0-9]+$/);
  assert.equal(row.label, 'active-memory evidence');
  assert.ok(view.evidence_handles.some(h => h.handle === row.handle));
});

test('HF-H13: Reviewer CheckReceipt -> typed claim -> handle -> final handoff', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace);
  await turn(trace);
  const { ref: claimRef } = await trace.recordClaim(
    { subject: 'gates green', scope: 'test_command_completed', receipt: validReceipt() }, host());
  assert.equal(claimRef.startsWith('evt_'), true);
  // Claims are not in projection recent (trace_* tools filtered); the claim is
  // handle-accessed through retrieve-to-cite (trace_find registers discovery).
  const found = await tool(trace, 'trace_find').execute({ type: 'trace.claim' }, host());
  const row = found.metadata.raw.results.find(r => r.ref === claimRef);
  assert.ok(row?.handle, 'the typed claim must be handle-accessible via trace_find');
  const out = await tool(trace, 'trace_note').execute(
    { kind: 'handoff', text: 'shipping on the mechanical claim', source_handles: [row.handle],
      milestone: { kind: 'verification', summary: 'gates green', current_state: 'verified', evidence_handles: [row.handle] } }, host());
  assert.equal(out.metadata.raw.ok, true);
  const data = await notePayload(trace, out.metadata.raw.ref);
  assert.deepEqual(data.source_refs, [claimRef], 'handoff cites the claim via handle, stores the canonical claim ref');
  assert.deepEqual(data.milestone.evidence_refs, [claimRef]);
});

test('HF-H14: expired handles are rejected as stale and never silently rebound to old refs', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace, 'old-evidence-hf14');
  const t1 = await turn(trace);
  const oldRef = t1.assignments.find(a => a.handle === 'e1').ref;
  for (let i = 0; i < 9; i++) await captureOne(trace, `newer-${i}-hf14`); // push the old event out of the 8-row window
  const t2 = await turn(trace);
  const resolved = trace.handles.resolve('s1', 'e1');
  assert.equal(resolved.ok, true);
  assert.notEqual(resolved.ref, oldRef, 're-issued e1 maps to the new turn content, never the stale ref');
  assert.equal(trace.handles.retired.get('s1').byHandle.has('e1'), true, 'old mapping kept as tombstone for honest expiry');
  assert.equal(t1.assignments.filter(a => a.handle === 'e1').length, 1, 'mapping is exact-match single-valued');
  // The old evidence stays reachable canonically and via retrieve-to-cite.
  assert.equal((await trace.store.exists(oldRef)).type, 'tool.after');
  const found = await tool(trace, 'trace_find').execute({ text: 'old-evidence-hf14' }, host());
  assert.ok(found.metadata.raw.results.some(r => r.ref === oldRef));
});

test('HF-H15: cross-session handles are rejected on the note path; nothing persists', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace);
  await turn(trace, 's1');
  trace.handles.newGeneration('s2', []);
  const bad = await tool(trace, 'trace_note').execute(
    { kind: 'fact', text: 'foreign citation', source_handles: ['e1'] }, host('s2'));
  assert.equal(bad.metadata.raw.ok, false);
  assert.match(bad.metadata.raw.error, /belongs to a different session/);
  assert.equal(noteCount(trace), 0, 'no durable note for a foreign handle');
});

test('HF-H16: canonical internal API compatibility unchanged (full refs accepted everywhere)', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace, 'canonical-hf16');
  const { snapshot } = await turn(trace);
  const canonical = snapshot.recent.at(-1).ref;
  const direct = await trace.store.expand(canonical, 0, 2048, false);
  assert.equal(direct.ref, canonical);
  assert.equal(direct.hash_verified, true);
  const out = await tool(trace, 'trace_note').execute(
    { kind: 'fact', text: 'canonical citation', source_refs: [canonical] }, host());
  assert.equal(out.metadata.raw.ok, true);
  assert.deepEqual((await notePayload(trace, out.metadata.raw.ref)).source_refs, [canonical]);
});

test('HF-H17: CAS hash verification unchanged for handle-mediated writes', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace, 'integrity-hf17');
  await turn(trace);
  const out = await tool(trace, 'trace_note').execute(
    { kind: 'fact', text: 'integrity check', source_handles: ['e1'] }, host());
  assert.equal(out.metadata.raw.ok, true);
  const ev = await trace.store.readEvent(out.metadata.raw.ref);
  const data = await trace.store.readBlob(ev.payload.ref); // readBlob rejects on hash mismatch
  const digest = crypto.createHash('sha256').update(data).digest('hex');
  assert.equal(digest, ev.payload.sha256, 'durable payload still hash-verifies after handle resolution');
});

test('HF-H18: recall prefix invariant + deterministic handle assignment incl. active-memory evidence', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace, 'prefix-hf18');
  await turn(trace);
  const { text } = trace.recallSnapshot('s1');
  assert.ok(text.startsWith(`${RECALL_MARKER}\n${RECALL_EVIDENCE_POLICY}\n`), 'recall prefix invariant unchanged');
  const a1 = assignSnapshotHandles(trace.recallSnapshot('s1').snapshot);
  const a2 = assignSnapshotHandles(trace.recallSnapshot('s1').snapshot);
  assert.deepEqual(a1, a2, 'handle assignment is a pure function of the view');
  // The handlefix rendering: active-memory evidence carries [e#] prefixes.
  const saved = await tool(trace, 'trace_note').execute({ kind: 'handoff', text: 'evidence handoff hf18',
    source_handles: ['e1'], milestone: { kind: 'handoff', summary: 'evidence handoff hf18' } }, host());
  assert.equal(saved.metadata.raw.ok, true);
  await turn(trace);
  const { text: text2, snapshot } = trace.recallSnapshot('s1');
  const refs = snapshot.active_memory?.evidence_refs ?? [];
  assert.ok(refs.length > 0, 'handoff evidence flows into active memory');
  assert.match(text2, /Evidence refs: \[e[0-9]+\] evt_[0-9a-f]/, 'rendered with handle prefix');
});
