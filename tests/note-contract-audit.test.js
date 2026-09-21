// Regression tests for the trace_note kind/source_ref contract failures
// observed in production on 2026-09-19 (session ses_f427e7ae9ffeze5yh969vDn4uN,
// workspace /home/frank). Audit: trace-note-contract-audit-20260919.
//
// KIND-1..3 pin the model-visible kind contract: exactly six top-level note
//            kinds, state_change is a milestone kind that maps to finding, and
//            the description states both mappings plus the ref discipline.
// REF-1..8  pin the canonical ref lifecycle: storage -> projection -> render ->
//            tool roundtrip, strict rejection of malformed/invented refs (the
//            exact production strings are replayed), optional refs,
//            correction/supersedes provenance, resume stability, and the
//            deterministic non-accepting closest-ref hint.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Trace } from '../src/trace.js';
import { definitions } from '../src/tools.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-trace-note-contract-'));
  const trace = new Trace({ location: { directory: dir } }, { storeRoot: path.join(dir, 'store') });
  await trace.ready;
  t.after(async () => { trace.store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, trace, store: trace.store };
}
const host = (sessionID = 's1') => ({ sessionID, messageID: 'm1', id: 'c1', agent: 'build' });

// The exact malformed source refs emitted by the failing model (49 hex, 61 hex).
// Both were corrupted copies of full stored refs visible in the same recall.
const MALFORMED_49 = 'evt_5d1929abe01a004e949a0f59d03a82bd316958af947ca4021';
const MALFORMED_61 = 'evt_babbf2641d782c8c17960df6c6e59218cf758a482d33bf1655e085a71f7d7';

test('KIND-1: model-visible trace_note schema exposes exactly the six note kinds', () => {
  const note = definitions(null).find(d => d.name === 'trace_note');
  assert.ok(note, 'trace_note must be defined');
  assert.deepEqual([...note.input.properties.kind.enum], ['fact', 'finding', 'decision', 'unresolved', 'handoff', 'correction']);
  assert.ok(!note.input.properties.kind.enum.includes('state_change'), 'state_change must not be a top-level note kind');
  assert.ok(note.input.properties.milestone.properties.kind.enum.includes('state_change'), 'state_change is a milestone kind, visible only inside milestone');
});

test('KIND-2: unsupported top-level kind state_change is rejected clearly', async t => {
  const { trace } = await fixture(t);
  await assert.rejects(
    () => trace.note({ kind: 'state_change', text: 'release cleanup done' }, host()),
    /kind must be one of fact, finding, decision, unresolved, handoff, correction/
  );
  // The tool-facing wrapper reports the same rejection without throwing.
  const noteTool = definitions(trace).find(d => d.name === 'trace_note');
  const out = await noteTool.execute({ kind: 'state_change', text: 'release cleanup done' }, host());
  assert.equal(out.metadata.raw.ok, false);
  assert.match(out.metadata.raw.error, /kind must be one of/);
});

test('KIND-2: milestone.kind state_change is accepted and maps to finding', async t => {
  const { trace } = await fixture(t);
  const { note } = await trace.note({ milestone: { kind: 'state_change', summary: 'release cleanup done' } }, host());
  assert.equal(note.kind, 'finding');
  assert.equal(note.milestone.kind, 'state_change');
});

test('KIND-3: tool description explains the kind mapping and the S3 handle-first ref discipline', () => {
  const note = definitions(null).find(d => d.name === 'trace_note');
  assert.match(note.description, /do not invent other kinds/i);
  assert.match(note.description, /state_change/);
  assert.match(note.description, /maps to finding/i);
  // S3: handles are the normal interface; canonical refs are the
  // compatibility/advanced path; copying verbatim is still the only
  // acceptable canonical-citation discipline.
  assert.match(note.description, /handle-first/i);
  assert.match(note.description, /normal interface/i);
  assert.match(note.description, /compatibility\/advanced path/i);
  assert.match(note.input.properties.kind.description, /state_change/);
  assert.match(note.input.properties.kind.description, /finding/);
  assert.match(note.input.properties.source_refs.description, /verbatim/);
  assert.match(note.input.properties.source_refs.description, /omit/);
  assert.match(note.input.properties.evidence.description, /PREFERRED/);
});

test('REF-1: full evt ref survives storage -> projection -> render -> tool roundtrip', async t => {
  const { dir, trace, store } = await fixture(t);
  const e = { ...host(), tool: 'read', input: { filePath: path.join(dir, 'doc') } };
  const after = await trace.after({ ...e, status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] } });
  assert.match(after.ref, /^evt_[a-f0-9]{64}$/);
  const { ref: noteRef, note } = await trace.note({ kind: 'finding', text: 'cites the read event', source_refs: [after.ref] }, host());
  assert.equal(note.source_refs[0], after.ref);
  // Durable storage keeps the canonical ref byte-exact.
  const stored = await store.readEvent(noteRef);
  const body = JSON.parse((await store.readBlob(stored.payload.ref)).toString());
  assert.equal(body.source_refs[0], after.ref);
  // The recall projection keeps the full ref.
  const { text, snapshot } = trace.recallSnapshot(host().sessionID);
  assert.ok(text.includes(after.ref), 'recall text must contain the full canonical ref');
  assert.ok(JSON.stringify(snapshot).includes(after.ref));
  // The tool-facing render shows the full ref in backticks.
  const noteTool = definitions(trace).find(d => d.name === 'trace_note');
  const out = await noteTool.execute({ kind: 'finding', text: 'again', source_refs: [after.ref] }, host());
  assert.match(out.content, new RegExp('`' + after.ref + '`'));
});

test('REF-2: full blob ref survives storage and note citation roundtrip', async t => {
  const { trace, store } = await fixture(t);
  const blob = await store.blob({ hello: 'world' }, 'json');
  assert.match(blob.ref, /^blob_[a-f0-9]{64}$/);
  const { ref: noteRef, note } = await trace.note({ kind: 'fact', text: 'cites a stored blob', source_refs: [blob.ref] }, host());
  assert.equal(note.source_refs[0], blob.ref);
  const stored = await store.readEvent(noteRef);
  const body = JSON.parse((await store.readBlob(stored.payload.ref)).toString());
  assert.equal(body.source_refs[0], blob.ref);
  assert.deepEqual(JSON.parse((await store.readBlob(blob.ref)).toString()), { hello: 'world' });
});

test('REF-3: the exact production-malformed 49/61 hex refs remain rejected', async t => {
  const { trace } = await fixture(t);
  await assert.rejects(
    () => trace.note({ kind: 'finding', text: 'x', source_refs: [MALFORMED_49] }, host()),
    (err) => {
      assert.match(err.message, /^Invalid source_refs\[0\] evt_5d1929ab/);
      assert.match(err.message, /expected evt_<64hex> or blob_<64hex>/);
      return true;
    }
  );
  await assert.rejects(
    () => trace.note({ kind: 'finding', text: 'x', source_refs: [MALFORMED_61] }, host()),
    (err) => {
      assert.match(err.message, /^Invalid source_refs\[0\] evt_babbf264/);
      assert.match(err.message, /expected evt_<64hex> or blob_<64hex>/);
      return true;
    }
  );
});

test('REF-3: truncating a real stored ref is still rejected; the error names the full canonical ref', async t => {
  const { dir, trace } = await fixture(t);
  const e = { ...host(), tool: 'read', input: { filePath: path.join(dir, 'doc') } };
  const after = await trace.after({ ...e, status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] } });
  const cut = after.ref.slice(0, 4 + 61); // evt_ + 61 hex, like the production 61-hex ref
  assert.match(cut, /^evt_[a-f0-9]{61}$/);
  await assert.rejects(
    () => trace.note({ kind: 'finding', text: 'x', source_refs: [cut] }, host()),
    (err) => {
      assert.match(err.message, /^Invalid source_refs\[0\] /);
      assert.match(err.message, /expected evt_<64hex> or blob_<64hex>/);
      assert.match(err.message, new RegExp(`Closest stored ref: ${after.ref} \\(copy it verbatim`));
      return true;
    }
  );
});

test('REF-4: display layers never shorten or overwrite the canonical machine ref', async t => {
  const { dir, trace, store } = await fixture(t);
  const e = { ...host(), tool: 'read', input: { filePath: path.join(dir, 'doc') } };
  const after = await trace.after({ ...e, status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] } });
  await trace.note({ kind: 'finding', text: 'cites event', source_refs: [after.ref] }, host());
  const { text } = trace.recallSnapshot(host().sessionID);
  assert.ok(text.includes(after.ref), 'recall must carry the full canonical ref');
  assert.ok(!text.includes(`${after.ref.slice(0, 20)}…`), 'no display-shortened ref variant in recall');
  // Byte-level invariant: every occurrence of the ref's 16-hex prefix must
  // continue as the full 64-hex ref, in the projection and in durable storage.
  const hex = after.ref.slice(4);
  const probe = hex.slice(0, 16);
  for (const source of [text, JSON.stringify(store.session(host().sessionID))]) {
    let pos = 0;
    while ((pos = source.indexOf(probe, pos)) !== -1) {
      assert.equal(source.slice(pos, pos + 64), hex, 'every 16-hex prefix occurrence must continue as the full canonical ref');
      pos += 16;
    }
  }
});

test('REF-5: a note without source_refs is accepted (refs are optional)', async t => {
  const { trace } = await fixture(t);
  const { note } = await trace.note({ kind: 'finding', text: 'no provenance available' }, host());
  assert.deepEqual(note.source_refs, []);
});

test('REF-6: an invented well-formed ref is rejected, not silently accepted', async t => {
  const { trace } = await fixture(t);
  const invented = `evt_${'a'.repeat(64)}`;
  await assert.rejects(
    () => trace.note({ kind: 'finding', text: 'x', source_refs: [invented] }, host()),
    (err) => {
      assert.match(err.message, /^Unknown source_refs\[0\] evt_a{64}: not found in this workspace/);
      assert.doesNotMatch(err.message, /Closest stored ref/);
      return true;
    }
  );
});

test('REF-7: correction/supersedes provenance still works end to end', async t => {
  const { trace, store } = await fixture(t);
  const a = await trace.note({ kind: 'finding', text: 'initial claim' }, host());
  const b = await trace.note({ kind: 'correction', text: 'correcting initial claim', supersedes: [a.ref] }, host());
  const stored = await store.readEvent(b.ref);
  const body = JSON.parse((await store.readBlob(stored.payload.ref)).toString());
  assert.equal(body.kind, 'correction');
  assert.deepEqual(body.supersedes, [a.ref]);
  // Recall keeps the live note and preserves the supersession link.
  const { snapshot } = trace.recallSnapshot(host().sessionID);
  const str = JSON.stringify(snapshot);
  assert.ok(str.includes(b.ref), 'live corrected note present in recall');
  assert.ok(str.includes(a.ref), 'superseded ref stays recoverable via history fields');
});

test('REF-8: resume from durable storage does not corrupt canonical refs', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-trace-note-contract-'));
  t.after(async () => fs.rm(dir, { recursive: true, force: true }));
  const first = new Trace({ location: { directory: dir } }, { storeRoot: path.join(dir, 'store') });
  await first.ready;
  const e = { ...host(), tool: 'shell', input: { command: 'true' } };
  await first.before(e);
  const after = await first.after({ ...e, status: 'completed', result: { output: 'ok' } });
  const { ref: noteRef } = await first.note({ kind: 'fact', text: 'cites durable event', source_refs: [after.ref] }, host());
  first.store.close();
  // A fresh process resumes from the same durable store.
  const resumed = new Trace({ location: { directory: dir } }, { storeRoot: path.join(dir, 'store') });
  await resumed.ready;
  t.after(() => resumed.store.close());
  await resumed.store.reconcile();
  assert.equal((await resumed.store.readEvent(after.ref)).ref, after.ref);
  const { text } = resumed.recallSnapshot(host().sessionID);
  assert.ok(text.includes(after.ref), 'resumed projection keeps the full canonical ref');
  assert.ok(text.includes(noteRef), 'resumed projection keeps the note ref');
});

test('closest-ref hint: unique >=16 hex prefix points at the stored ref; ambiguity and short prefixes stay silent', async t => {
  const { trace, store } = await fixture(t);
  // No stored events: short prefix, no hint.
  assert.equal(await trace.closestRefHint(`evt_${'ab'.repeat(8)}`), '');
  // Unique stored ref: hint names the full canonical ref.
  const e = { ...host(), tool: 'shell', input: { command: 'true' } };
  const after = await trace.after({ ...e, status: 'completed', result: { output: 'ok' } });
  const hex = after.ref.slice(4);
  assert.equal(await trace.closestRefHint(`evt_${hex.slice(0, 30)}`), ` Closest stored ref: ${after.ref} (copy it verbatim or omit this field; shortened or invented refs are rejected).`);
  // 15 shared hex: below threshold, no hint.
  assert.equal(await trace.closestRefHint(`evt_${hex.slice(0, 15)}zz`), '');
  // Ambiguity: two stored refs sharing a >=16 hex prefix -> no hint.
  const eventsDir = path.join(store.root, 'events');
  const shared = '1234567890abcdef';
  await fs.writeFile(path.join(eventsDir, `evt_${shared}${'a'.repeat(48)}.json`), '{}');
  await fs.writeFile(path.join(eventsDir, `evt_${shared}${'b'.repeat(48)}.json`), '{}');
  assert.equal(await trace.closestRefHint(`evt_${shared}${'c'.repeat(16)}`), '');
});
