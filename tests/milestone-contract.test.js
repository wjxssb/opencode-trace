// P4-C: trace_note milestone API / validator consistency.
//
// Production evidence (2026-09-21, session ses_f3ae48db3ffe00yy9WdbNfghT2):
// the exact form
//   { kind: "milestone", milestone: { kind: "verification", ... } }
// was rejected with
//   "trace_note: kind must be one of fact, finding, decision, unresolved,
//    handoff, correction (or provide milestone.kind)"
// even though milestone.kind WAS provided. Root cause: the handler applies
// the milestone kind-map default only while top-level kind is absent, then
// the generic NOTE_KINDS check rejects the redundant kind "milestone".
//
// Canonical contract (unchanged, already documented in the tool description
// and schema):
//   normal note:   { kind: <one of six>, text | summary, ... }
//   milestone:     { milestone: { kind: <one of seven>, summary, ... } }
// with NO top-level kind (the kind-map default applies).
//
// P4-C adds:
//   1. validator-boundary normalization: { kind: "milestone", milestone }
//      -> identical durable output as the canonical milestone form;
//   2. precise errors: bare kind "milestone" (no milestone object) and any
//      other invalid top-level kind name the exact problem.
// The model-visible surface (description, schema, enums, required) is
// deliberately UNCHANGED — contract-snapshot and cache-gate stay green.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Trace } from '../src/trace.js';
import { definitions } from '../src/tools.js';

const host = (sessionID = 'p4c') => ({ sessionID, messageID: 'm1', id: 'c1', agent: 'build' });

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-trace-milestone-contract-'));
  const trace = new Trace({ location: { directory: dir } }, { storeRoot: path.join(dir, 'store') });
  await trace.ready;
  t.after(async () => { trace.store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { trace };
}

test('P4C-REPRO: the exact production-rejected form is accepted via normalization', async t => {
  const { trace } = await fixture(t);
  const { ref, note } = await trace.note({
    kind: 'milestone',
    milestone: { kind: 'verification', summary: 'P4C repro milestone persisted' },
  }, host());
  assert.equal(note.kind, 'finding'); // kindMap default, identical to canonical form
  assert.equal(note.milestone.kind, 'verification');
  assert.equal(note.text, 'P4C repro milestone persisted');
  // Durable event: top-level kind is the canonical note kind, never "milestone".
  const durable = (await trace.store.exists(ref)).note;
  assert.equal(durable.kind, 'finding');
  assert.equal(durable.milestone.kind, 'verification');
});

test('P4C-1: canonical milestone-only shape accepted and byte-identical to normalized shape', async t => {
  const { trace } = await fixture(t);
  const body = { kind: 'baseline', summary: 'same body', why_it_matters: 'w' };
  const a = (await trace.note({ milestone: { ...body } }, host())).note;
  const b = (await trace.note({ kind: 'milestone', milestone: { ...body } }, host())).note;
  assert.deepEqual(b, a);
});

test('P4C-C1: normal fact note accepted', async t => {
  const { trace } = await fixture(t);
  const { note } = await trace.note({ kind: 'fact', text: 'P4C fact note' }, host());
  assert.equal(note.kind, 'fact');
  assert.equal(note.text, 'P4C fact note');
  assert.equal(note.milestone, undefined);
});

test('P4C-C2: normal finding accepted', async t => {
  const { trace } = await fixture(t);
  const { note } = await trace.note({ kind: 'finding', text: 'P4C finding note' }, host());
  assert.equal(note.kind, 'finding');
});

test('P4C-C4: redundant form accepted through the model-facing tool wrapper too', async t => {
  const { trace } = await fixture(t);
  const tool = definitions(trace).find(d => d.name === 'trace_note');
  const out = await tool.execute({ kind: 'milestone', milestone: { kind: 'baseline', summary: 'wrapper repro' } }, host());
  assert.equal(out.metadata.raw.ok, true);
  assert.equal(out.metadata.raw.note.kind, 'fact'); // kindMap: baseline -> fact
  assert.equal(out.metadata.raw.note.milestone.kind, 'baseline');
});

test('P4C-C5: invalid milestone.kind rejected with actionable error (both shapes)', async t => {
  const { trace } = await fixture(t);
  await assert.rejects(
    () => trace.note({ milestone: { kind: 'not_a_kind', summary: 'x' } }, host()),
    /invalid milestone\.kind: not_a_kind/
  );
  await assert.rejects(
    () => trace.note({ kind: 'milestone', milestone: { kind: 'not_a_kind', summary: 'x' } }, host()),
    /invalid milestone\.kind: not_a_kind/
  );
});

test('P4C-C6: invalid normal note kind rejected with precise, non-contradictory guidance', async t => {
  const { trace } = await fixture(t);
  await assert.rejects(
    () => trace.note({ kind: 'state_change', text: 'release cleanup done' }, host()),
    (err) => {
      assert.match(err.message, /kind must be one of fact, finding, decision, unresolved, handoff, correction/);
      assert.match(err.message, /state_change/);
      assert.match(err.message, /milestone/);
      return true;
    }
  );
});

test('P4C-bare: kind "milestone" without a milestone object rejected with the exact problem named', async t => {
  const { trace } = await fixture(t);
  await assert.rejects(
    () => trace.note({ kind: 'milestone', text: 'no milestone object' }, host()),
    (err) => {
      assert.match(err.message, /top-level kind "milestone"/);
      assert.match(err.message, /milestone\.kind|milestone: \{kind/);
      return true;
    }
  );
});

test('P4C-mixed: explicit normal kind alongside a valid milestone keeps the explicit kind', async t => {
  const { trace } = await fixture(t);
  const { note } = await trace.note({
    kind: 'decision',
    milestone: { kind: 'verification', summary: 'explicit outer kind wins' },
  }, host());
  assert.equal(note.kind, 'decision');
  assert.equal(note.milestone.kind, 'verification');
});

test('P4C-C7: strong current_state without verified evidence still downgrades to CLAIMED / UNVERIFIED', async t => {
  const { trace } = await fixture(t);
  const { note } = await trace.note({
    milestone: { kind: 'verification', summary: 'strong claim', current_state: 'RELEASE VERIFIED LIVE' },
  }, host());
  assert.equal(note.milestone.current_state, 'CLAIMED / UNVERIFIED');
});

test('P4C-C8: supersedes/source_refs validation unchanged (malformed canonical ref rejects)', async t => {
  const { trace } = await fixture(t);
  const bad = 'evt_5d1929abe01a004e949a0f59d03a82bd316958af947ca4021'; // 49 hex: the 2026-09-19 production string
  await assert.rejects(
    () => trace.note({ kind: 'finding', text: 'ref validation', source_refs: [bad] }, host()),
    /source_ref|ref/
  );
  await assert.rejects(
    () => trace.note({ milestone: { kind: 'verification', summary: 'ms ref validation', evidence_refs: [bad] } }, host()),
    /evidence_ref|ref/
  );
});

test('P4C-C10: durable event keeps canonical refs only; normalized form adds no durable "milestone" kind', async t => {
  const { trace } = await fixture(t);
  const { ref, note } = await trace.note({
    kind: 'milestone',
    milestone: { kind: 'state_change', summary: 'canonical refs only', depends_on: [], evidence_refs: [] },
  }, host());
  const entry = await trace.store.exists(ref);
  const durable = entry.note;
  assert.equal(durable.kind, 'finding');
  assert.deepEqual(durable.source_refs, []);
  for (const ref of [...(durable.source_refs ?? []), ...(durable.milestone?.evidence_refs ?? []), ...(durable.depends_on ?? [])]) {
    assert.match(ref, /^(evt|blob)_[0-9a-f]{64}$/);
  }
});

test('P4C-surface: model-visible contract stays canonical (no schema/description drift)', () => {
  const note = definitions(null).find(d => d.name === 'trace_note');
  assert.deepEqual([...note.input.properties.kind.enum], ['fact', 'finding', 'decision', 'unresolved', 'handoff', 'correction']);
  assert.ok(!note.input.properties.kind.enum.includes('milestone'));
  assert.deepEqual(note.input.required ?? [], []);
  assert.match(note.description, /do not invent other kinds/i);
  assert.match(note.description, /milestone\.kind and milestone\.summary/);
});
