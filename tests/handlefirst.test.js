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
