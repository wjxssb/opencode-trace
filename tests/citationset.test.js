// V3 S5 qualification: generalized ephemeral CitationSet (mission §14-§18, Z1-Z8).
//
// CitationSet is: ephemeral, turn-scoped, host-managed, non-CAS, non-durable.
// It is NOT a second identity system, not a permanent alias, not an evt_/blob_.
// Purpose: temporary validated grouping of canonical citations for
// handoff/notes/claims/plans/finalization — so the model copies ZERO SHA
// strings end-to-end.
//
// All tests use the REAL tool execute path (middleware -> gateway -> core),
// never a direct Trace.note() bypass: citation_set is expanded and DELETED by
// the gateway before the core API validates input, by design.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { Trace } from '../src/trace.js';
import { definitions } from '../src/tools.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-trace-cset-'));
  const trace = new Trace({ location: { directory: dir } }, { storeRoot: path.join(dir, 'store') });
  await trace.ready;
  t.after(async () => { await trace.store.close(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); });
  return { dir, trace, store: trace.store };
}
const host = (sessionID = 's1') => ({ sessionID, messageID: 'm1', id: 'c1', agent: 'build' });
const tool = (trace, name) => definitions(trace).find(d => d.name === name);
const isCanonical = r => /^(evt|blob)_[0-9a-f]{64}$/.test(r);

async function captureOne(trace, command, sessionID = 's1') {
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

test('Z1: current-turn citation set — handles in, canonical-only set out, nothing durable', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace, 'z1-evidence');
  await turn(trace);
  const first = await tool(trace, 'trace_note').execute({ kind: 'finding', text: 'z1 semantic evidence' }, host());
  assert.equal(first.metadata.raw.ok, true);
  await turn(trace); // note becomes n1
  const out = await tool(trace, 'trace_prepare_citations').execute({ handles: ['e1', 'n1'] }, host());
  assert.equal(out.metadata.raw.ok, true, 'prepare via the real tool surface');
  const raw = out.metadata.raw;
  assert.match(raw.token, /^cb_[0-9a-f]{24}$/, 'ephemeral token shape');
  assert.equal(raw.refs.length, 2);
  for (const r of raw.refs) assert.ok(isCanonical(r), 'set internals are canonical refs only');
  assert.ok(raw.entries.some(e => e.role === 'execution'), 'execution evidence role');
  assert.ok(raw.entries.some(e => e.role === 'semantic'), 'semantic (note) evidence role');
  // Non-durable: prepare itself persists NO event and the token is nowhere on disk.
  assert.equal(trace.store.findEntriesAll({ type: 'trace.citation_set' }).length, 0);
  const files = await fs.readdir(path.join(trace.store.root, 'events'));
  for (const f of files) {
    const body = await fs.readFile(path.join(trace.store.root, 'events', f), 'utf8');
    assert.ok(!body.includes(raw.token), 'cb_ token never touches durable storage');
  }
});

test('Z2: tool-surface handoff — citation_set expands to canonical refs; token never persists', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace, 'z2-evidence');
  await turn(trace);
  const prep = await tool(trace, 'trace_prepare_citations').execute({ handles: ['e1'] }, host());
  assert.equal(prep.metadata.raw.ok, true);
  const token = prep.metadata.raw.token;
  const noteInput = { kind: 'handoff', text: 'final handoff via CitationSet', citation_set: token,
    milestone: { kind: 'handoff', summary: 'final handoff via CitationSet' } };
  assert.doesNotMatch(JSON.stringify(noteInput), /[0-9a-f]{64}/, 'the handoff input contains zero SHA strings');
  const out = await tool(trace, 'trace_note').execute(noteInput, host());
  assert.equal(out.metadata.raw.ok, true, 'citation_set resolves through the tool middleware');
  const data = await notePayload(trace, out.metadata.raw.ref);
  assert.deepEqual(data.source_refs, prep.metadata.raw.refs, 'durable note stores the canonical refs');
  assert.deepEqual(data.milestone.evidence_refs, prep.metadata.raw.refs);
  assert.equal('citation_set' in data, false, 'token never reaches the durable payload');
  assert.doesNotMatch(JSON.stringify(data), /cb_[0-9a-f]{24}/, 'no token anywhere in the payload');
});

test('Z3: historical retrieve-to-cite — expired handle, fresh discovery handle, canonicalized set', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace, 'z3-legacy-marker');
  await turn(trace); // generation 1 knows e1
  trace.handles.newGeneration('s1', []); // generation 2: the original handle expired
  const stale = await tool(trace, 'trace_prepare_citations').execute({ handles: ['e1'] }, host());
  assert.equal(stale.metadata.raw.ok, false, 'expired handle fails closed at prepare');
  assert.match(stale.metadata.raw.error, /Expired evidence handle 'e1'/);
  const found = await tool(trace, 'trace_find').execute({ text: 'z3-legacy-marker' }, host());
  const row = found.metadata.raw.results.find(r => r.handle);
  assert.ok(row, 'retrieve-to-cite registers a fresh discovery handle');
  const prep = await tool(trace, 'trace_prepare_citations').execute({ handles: [row.handle] }, host());
  assert.equal(prep.metadata.raw.ok, true);
  assert.deepEqual(prep.metadata.raw.refs, [row.ref], 'the set canonicalizes the historical evidence');
  const out = await tool(trace, 'trace_note').execute(
    { kind: 'handoff', text: 'historical handoff', citation_set: prep.metadata.raw.token,
      milestone: { kind: 'handoff', summary: 'historical handoff' } }, host());
  assert.equal(out.metadata.raw.ok, true);
  const data = await notePayload(trace, out.metadata.raw.ref);
  assert.deepEqual(data.source_refs, [row.ref]);
});

test('Z4: stale citation set fails closed — no canonical write occurs', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace, 'z4-evidence');
  await turn(trace);
  const prep = await tool(trace, 'trace_prepare_citations').execute({ handles: ['e1'] }, host());
  assert.equal(prep.metadata.raw.ok, true);
  const token = prep.metadata.raw.token;
  // Equivalent staleness state: the turn advanced (new runtime frame installed).
  await captureOne(trace, 'z4-later-work');
  await turn(trace);
  const out = await tool(trace, 'trace_note').execute(
    { kind: 'handoff', text: 'stale set attempt', citation_set: token,
      milestone: { kind: 'handoff', summary: 'stale set attempt' } }, host());
  assert.equal(out.metadata.raw.ok, false, 'stale set rejects');
  assert.match(out.metadata.raw.error, /stale.*re-run prepare_citations/);
  const notes = trace.store.findEntriesAll({ type: 'trace.note' });
  assert.equal(notes.length, 0, 'no durable note written from a stale set');
});

test('Z5: malformed SHA mutants rejected at both citation surfaces — never fuzzy-repaired', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace, 'z5-evidence');
  const { snapshot } = await turn(trace);
  const real = snapshot.recent.at(-1).ref;
  const hex = real.slice(4);
  // prepare_citations accepts ONLY handles: canonical-shaped or malformed
  // hex tokens are rejected outright (the set is the handles-only surface).
  for (const n of [49, 61, 63, 65]) {
    const bad = `evt_${'9f'}${'a'.repeat(n - 2)}`;
    const out = await tool(trace, 'trace_prepare_citations').execute({ handles: [bad] }, host());
    assert.equal(out.metadata.raw.ok, false, `${n}-hex token rejected by prepare_citations`);
    assert.match(out.metadata.raw.error, /accepts only evidence handles/);
  }
  // The real ref with one extra/missing hex char is still rejected on the
  // citation surface (evidence field), with the diagnostic naming the exact
  // candidate but never auto-applying it.
  const nearMiss = await tool(trace, 'trace_note').execute(
    { kind: 'fact', text: 'near miss', evidence: [`${real}a`] }, host());
  assert.equal(nearMiss.metadata.raw.ok, false);
  assert.match(nearMiss.metadata.raw.error, /Closest stored ref: evt_[0-9a-f]{64}/);
  assert.ok(nearMiss.metadata.raw.error.includes(real));
  // citation_set itself: malformed token shapes reject.
  for (const bad of ['cb_short', 'cb_' + 'z'.repeat(24), 'e1', real]) {
    const out = await tool(trace, 'trace_note').execute(
      { kind: 'fact', text: 'bad token', citation_set: bad }, host());
    assert.equal(out.metadata.raw.ok, false, `malformed citation_set ${bad.slice(0, 12)} rejected`);
    assert.match(out.metadata.raw.error, /citation_set must be a prepare_citations token/);
  }
  assert.equal(trace.store.findEntriesAll({ type: 'trace.note' }).length, 0, 'nothing persisted by any mutant');
});

test('Z6: durable canonical only — no e#/n#/b#/cb_ anywhere in persisted state', async t => {
  const { trace, dir } = await fixture(t);
  await captureOne(trace, 'z6-evidence');
  await turn(trace);
  const prep = await tool(trace, 'trace_prepare_citations').execute({ handles: ['e1'] }, host());
  const note = await tool(trace, 'trace_note').execute(
    { kind: 'handoff', text: 'z6 handoff', citation_set: prep.metadata.raw.token,
      milestone: { kind: 'handoff', summary: 'z6 handoff' } }, host());
  assert.equal(note.metadata.raw.ok, true);
  const claim = await tool(trace, 'trace_claim').execute({ subject: 'z6', text: 'z6 prose claim' }, host());
  assert.equal(claim.metadata.raw.ok, true);
  // Scan EVERY durable file under the store root for handle/token vocabulary.
  const walk = async d => {
    const out = [];
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) out.push(...await walk(p));
      else if (e.isFile() && p.endsWith('.json')) out.push(p);
    }
    return out;
  };
  const files = await walk(path.join(dir, 'store'));
  assert.ok(files.length > 0);
  const handleVocab = /"(e|b|n)[1-9][0-9]{0,3}"|cb_[0-9a-f]{24}/;
  for (const f of files) {
    const body = await fs.readFile(f, 'utf8');
    assert.ok(!handleVocab.test(body), `durable file must not contain handle/citation-set vocabulary: ${f}`);
    assert.ok(!body.includes(prep.metadata.raw.token), `token leaked into ${f}`);
  }
});

test('Z7: citation set expiry — generation rotation invalidates; never silently rebound', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace, 'z7-evidence-a');
  await turn(trace);
  const prep = await tool(trace, 'trace_prepare_citations').execute({ handles: ['e1'] }, host());
  const token = prep.metadata.raw.token;
  const refA = prep.metadata.raw.refs[0];
  // Rotate with ENOUGH new events to push evidence-A out of the 8-row
  // snapshot window, so the new generation's e1 genuinely rebinds.
  for (let i = 0; i < 9; i++) await captureOne(trace, `z7-evidence-b${i}`);
  const t2 = await turn(trace);
  const e1Now = t2.assignments.find(a => a.handle === 'e1')?.ref;
  assert.ok(e1Now && e1Now !== refA, 'sanity: the rotated e1 is different content');
  const out = await tool(trace, 'trace_note').execute(
    { kind: 'fact', text: 'expired set attempt', citation_set: token }, host());
  assert.equal(out.metadata.raw.ok, false, 'expired set rejects');
  assert.match(out.metadata.raw.error, /stale/);
  // Never silently rebound: the rejection is not a substitution of the new e1.
  const notes = trace.store.findEntriesAll({ type: 'trace.note' });
  assert.equal(notes.length, 0);
  if (e1Now) assert.notEqual(e1Now, refA, 'sanity: the rotated e1 is different content');
});

test('Z8: claim + review evidence — typed claim (n#) and old execution evidence canonicalize together', async t => {
  const { trace } = await fixture(t);
  await captureOne(trace, 'z8-old-execution-evidence');
  await turn(trace);
  // Reviewer receipt -> typed claim through the real tool surface.
  const receipt = { checkID: `chk_${'2'.repeat(32)}`, kind: 'test', status: 'passed', commandExitCode: 0,
    timedOut: false, signal: 'none', candidate: { commit: 'c'.repeat(64) }, output: { sha256: 'd'.repeat(64) } };
  const claimOut = await tool(trace, 'trace_claim_receipt').execute(
    { subject: 'z8 gates green', scope: 'test_command_completed', receipt }, host());
  assert.equal(claimOut.metadata.raw.ok, true);
  assert.equal(claimOut.metadata.raw.claim.status, 'VERIFIED_MECHANICAL');
  assert.match(claimOut.metadata.raw.saved_as, /^n[0-9]+$/, 'the claim presents as n# (S3 write-return)');
  const claimRef = claimOut.metadata.raw.ref;
  // The claim event is handle-accessible via retrieve-to-cite (trace.claim is
  // filtered from projection recent by design).
  const found = await tool(trace, 'trace_find').execute({ type: 'trace.claim' }, host());
  const claimRow = found.metadata.raw.results.find(r => r.ref === claimRef);
  assert.ok(claimRow?.handle, 'claim carries a discovery handle');
  const execRow = (await tool(trace, 'trace_find').execute({ text: 'z8-old-execution-evidence' }, host()))
    .metadata.raw.results.find(r => r.handle);
  assert.ok(execRow, 'old execution evidence re-registered');
  const prep = await tool(trace, 'trace_prepare_citations').execute(
    { handles: [execRow.handle, claimRow.handle] }, host());
  assert.equal(prep.metadata.raw.ok, true);
  assert.deepEqual(new Set(prep.metadata.raw.refs), new Set([execRow.ref, claimRef]),
    'the set resolves BOTH the execution evidence and the typed claim to canonical refs');
  const claimEntry = prep.metadata.raw.entries.find(e => e.ref === claimRef);
  assert.equal(claimEntry.claim_state, 'VERIFIED_MECHANICAL', 'claim state rides in the set');
  const out = await tool(trace, 'trace_note').execute(
    { kind: 'handoff', text: 'z8 final handoff', citation_set: prep.metadata.raw.token,
      milestone: { kind: 'handoff', summary: 'z8 final handoff', current_state: 'verified' } }, host());
  assert.equal(out.metadata.raw.ok, true);
  const data = await notePayload(trace, out.metadata.raw.ref);
  assert.deepEqual(new Set(data.source_refs), new Set([execRow.ref, claimRef]));
  // CONTRADICTED claims cannot justify: a nonzero-exit receipt contradicts.
  const bad = await tool(trace, 'trace_claim_receipt').execute(
    { subject: 'z8 gates green', scope: 'test_command_completed', receipt: { ...receipt, checkID: `chk_${'3'.repeat(32)}`, commandExitCode: 1 } }, host());
  assert.equal(bad.metadata.raw.ok, true);
  assert.equal(bad.metadata.raw.claim.status, 'CONTRADICTED');
  const badRow = (await tool(trace, 'trace_find').execute({ type: 'trace.claim' }, host()))
    .metadata.raw.results.find(r => r.ref === bad.metadata.raw.ref);
  const rejected = await tool(trace, 'trace_prepare_citations').execute({ handles: [badRow.handle] }, host());
  assert.equal(rejected.metadata.raw.ok, false, 'a CONTRADICTED claim cannot enter a citation set');
  assert.match(rejected.metadata.raw.error, /CONTRADICTED claim/);
});
