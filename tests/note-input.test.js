import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const base = process.env.TRACE_TEST_ROOT ? `file://${process.env.TRACE_TEST_ROOT}/src/` : new URL('../src/', import.meta.url).href;
const { Trace } = await import(`${base}trace.js`);
const { definitions } = await import(`${base}tools.js`);
const host = { sessionID: 'note-test', messageID: 'm', id: 'c', agent: 'build' };
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-note-input-'));
  const trace = new Trace({ location: { directory } }, { storeRoot: path.join(directory, 'store') });
  await trace.ready;
  t.after(async () => { await trace.store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { trace, tool: definitions(trace).find(x => x.name === 'trace_note') };
}
test('summary alias is exposed and persists exact text, survives reload and enters recall', async t => {
  const { trace, tool } = await fixture(t);
  assert.equal(tool.input.properties.summary.type, 'string');
  const input = Object.freeze({ kind: 'finding', summary: 'Never delete home-data or tooling. 保留目录。' });
  const result = await tool.execute(input, host);
  assert.equal(result.metadata.raw.ok, true);
  assert.match(JSON.stringify(await trace.store.expand(result.metadata.raw.ref)), /Never delete home-data/);
  assert.match(trace.recall(host.sessionID), /Never delete home-data/);
  const { Store } = await import(`${base}store.js`);
  const reopened = await new Store(trace.store.workspace, trace.store.base).init();
  t.after(() => reopened.close());
  assert.equal(reopened.session(host.sessionID).notes[0].text, input.summary);
  assert.equal(input.text, undefined);
});
test('canonical text and milestone-only calls still work', async t => {
  const { tool } = await fixture(t);
  for (const input of [{ kind: 'fact', text: 'canonical' }, { kind: 'fact', text: 'same', summary: 'same' }, { milestone: { kind: 'handoff', summary: 'handoff body' } }]) {
    assert.equal((await tool.execute(input, host)).metadata.raw.ok, true);
  }
});
test('bad inputs fail clearly without saving a note; UTF-8 byte limit is enforced', async t => {
  const { trace, tool } = await fixture(t);
  for (const [input, error] of [
    [{ kind: 'finding' }, /text must be/],
    [{ kind: 'nope', text: 'body' }, /kind must be/],
    [{ kind: 'finding', summary: 42 }, /summary must be/],
    [{ kind: 'finding', summary: ' ' }, /summary must be/],
    [{ kind: 'finding', text: 'body', summary: 'x'.repeat(2049) }, /summary exceeds 2048/],
    [{ kind: 'finding', summary: '中'.repeat(1366) }, /4096 UTF-8 bytes/],
    [{ kind: 'finding', text: 'ok', source_refs: ['a'.repeat(16000)] }, /16000 UTF-8 bytes/],
  ]) {
    const r = (await tool.execute(input, host)).metadata.raw;
    assert.equal(r.ok, false); assert.match(r.error, error);
    assert.equal(r.native_execution, 'unaffected');
  }
  assert.equal(trace.store.session(host.sessionID).notes.length, 0);
  assert.equal((await tool.execute({ kind: 'fact', summary: 'a'.repeat(4096) }, host)).metadata.raw.ok, true);
  // A differing short summary beside text is kept, not rejected.
  const both = (await tool.execute({ kind: 'finding', text: 'a', summary: 'b' }, host)).metadata.raw;
  assert.equal(both.ok, true);
});

test('extra simple fields are kept as lines of the note body, not rejected (production 2026-09-28 21:30)', async t => {
  const { trace, tool } = await fixture(t);
  const input = Object.freeze({ kind: 'handoff', summary: '312-321 built, audit requested', text: 'batch 312-321: obs uploaded, build passed', status: 'waiting', attempt: 2, final: false });
  const out = await tool.execute(input, host);
  assert.equal(out.metadata.raw.ok, true);
  const note = trace.store.session(host.sessionID).notes.at(-1);
  assert.equal(note.text, 'batch 312-321: obs uploaded, build passed\nstatus: waiting\nattempt: 2\nfinal: false');
  assert.equal(note.summary, '312-321 built, audit requested');
  assert.deepEqual(out.metadata.raw.folded, ['status', 'attempt', 'final']);
  assert.match(out.output, /kept in text\*\*: status, attempt, final/);
  assert.equal(input.status, 'waiting'); // the caller's object is untouched
  // Only extra fields and no body: the lines are the body.
  const only = (await tool.execute({ kind: 'fact', status: 'blocked on audit' }, host)).metadata.raw;
  assert.equal(only.ok, true);
  assert.equal(trace.store.session(host.sessionID).notes.at(-1).text, 'status: blocked on audit');
  // Objects, arrays and near-misses of real fields are still refused, with nothing saved.
  const before = trace.store.session(host.sessionID).notes.length;
  for (const [extra, error] of [[{ status: { a: 1 } }, /unknown field status; use text/], [{ tags: ['x'] }, /unknown field tags; use text/], [{ sumary: 'x' }, /did you mean summary\?/]]) {
    const r = (await tool.execute({ kind: 'finding', text: 'body', ...extra }, host)).metadata.raw;
    assert.equal(r.ok, false); assert.match(r.error, error);
  }
  assert.equal(trace.store.session(host.sessionID).notes.length, before);
});

test('invalid structured notes are rejected rather than coerced, dropped or truncated', async t => {
  const { trace, tool } = await fixture(t);
  for (const extra of [
    { milestone: null }, { milestone: false }, { milestone: [] },
    { milestone: { kind: 'verification', summary: 7 } },
    { milestone: { kind: 'verification', summary: 'x'.repeat(2049) } },
    { milestone: { kind: 'handoff', to_session: 'x'.repeat(257) } },
    { milestone: { kind: 'blocker', unresolved: [{}] } },
    { milestone: { kind: 'blocker', unresolved: Array(17).fill('blocker') } },
    { milestone: { kind: 'blocker', do_not_repeat: ['x'.repeat(257)] } },
    { milestone: { kind: 'blocker', next_acton: 'misspelled' } },
    { summmary: 'misspelled' },
  ]) {
    const r = (await tool.execute({ kind: 'finding', text: 'body', ...extra }, host)).metadata.raw;
    assert.equal(r.ok, false, JSON.stringify(extra));
    assert.match(r.error, /trace_note:/);
  }
  assert.equal(trace.store.session(host.sessionID).notes.length, 0);
});

test('Unicode milestone boundaries preserve complete code points', async t => {
  const { tool } = await fixture(t);
  const summary = 'a'.repeat(2047) + '😀';
  const r = (await tool.execute({ milestone: { kind: 'handoff', summary } }, host)).metadata.raw;
  assert.equal(r.ok, true);
  assert.equal(r.note.milestone.summary, summary);
});

test('unverified and negative states are never presented as verified', async t => {
  const { trace } = await fixture(t);
  for (const state of ['CLAIMED / UNVERIFIED', 'NOT VERIFIED', 'NOT PASS', 'PASS pending', 'verification failed']) {
    const s = { notes: [{ ref: 'n', at: 1, kind: 'finding', text: 'claim', milestone: { kind: 'verification', summary: 'claim', current_state: state } }] };
    const am = trace.computeActiveMemory(s);
    assert.equal(am.verified_state, null, state);
    assert.doesNotMatch(trace.formatActiveMemory(am), /Verified state:/i, state);
  }
});

test('supersession survives note eviction and store reload', async t => {
  const { trace } = await fixture(t);
  const old = await trace.note({ kind: 'decision', text: 'OBSOLETE_DECISION' }, host);
  await trace.note({ kind: 'finding', text: 'replacement', supersedes: [old.ref] }, host);
  for (let i = 0; i < 70; i++) await trace.note({ kind: 'finding', text: `noise ${i}` }, { ...host, id: `noise-${i}` });
  assert.deepEqual(trace.computeActiveMemory(trace.store.session(host.sessionID)).latest_decisions, []);
  const { Store } = await import(`${base}store.js`);
  const reopened = await new Store(trace.store.workspace, trace.store.base).init();
  t.after(() => reopened.close());
  assert.deepEqual(trace.computeActiveMemory(reopened.session(host.sessionID)).latest_decisions, []);
});

test('baseline notes supersede only explicitly cited notes', async t => {
  const { trace } = await fixture(t);
  const old = await trace.note({ kind: 'fact', text: 'Storage baseline, keep this', milestone: { kind: 'baseline', summary: 'storage baseline', unresolved: ['Storage issue remains'] } }, host);
  const newer = await trace.note({ milestone: { kind: 'baseline', summary: 'GPU baseline' } }, host);
  assert.deepEqual(newer.note.supersedes, []);
  assert.ok(trace.computeActiveMemory(trace.store.session(host.sessionID)).open_blockers.includes('Storage issue remains'));
  const replacement = await trace.note({ milestone: { kind: 'baseline', summary: 'storage corrected', supersedes: [old.ref] } }, host);
  assert.deepEqual(replacement.note.supersedes, [old.ref]);
});

test('supersedes rejects other sessions and non-note references', async t => {
  const { trace, tool } = await fixture(t);
  const other = await trace.note({ kind: 'decision', text: 'another worker' }, { ...host, sessionID: 'other' });
  const ev = await trace.after({ ...host, tool: 'read', status: 'completed', result: { output: 'file' } });
  for (const ref of [other.ref, ev.ref]) {
    const r = (await tool.execute({ kind: 'correction', text: 'replacement', supersedes: [ref] }, host)).metadata.raw;
    assert.equal(r.ok, false);
    assert.match(r.error, /supersedes.*own session/);
  }
});

test('completed tool envelopes with explicit command failure cannot corroborate VERIFIED', async t => {
  const { trace } = await fixture(t);
  for (const result of [{ output: 'test failed', exit: 1 }, { output: 'command failed', metadata: { exitCode: 7 } }, { output: { output: 'failure', exit: 2 } }, { output: 'error', isError: true }]) {
    const ev = await trace.after({ ...host, tool: 'shell', input: { command: 'false' }, status: 'completed', result });
    const n = await trace.note({ kind: 'finding', text: 'claimed pass', source_refs: [ev.ref], milestone: { kind: 'verification', current_state: 'VERIFIED' } }, host);
    assert.equal(n.note.milestone.current_state, 'CLAIMED / UNVERIFIED');
  }
  const ev = await trace.store.record('trace.step.result', host, { outcome: 'worker_reported_failure' }, { status: 'completed' });
  assert.equal(await trace.isVerifiedEvidence(ev.ref), false);
});
