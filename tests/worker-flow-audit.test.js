import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const base = process.env.TRACE_TEST_ROOT
  ? pathToFileURL(path.join(process.env.TRACE_TEST_ROOT, 'src/')).href
  : new URL('../src/', import.meta.url).href;
const { Trace } = await import(`${base}trace.js`);
const { Store } = await import(`${base}store.js`);
const host = (sessionID = 'worker', id = 'c') => ({ sessionID, messageID: 'm', id, agent: 'build' });

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-worker-flow-'));
  const trace = new Trace({ location: { directory } }, { storeRoot: path.join(directory, 'store') });
  await trace.ready;
  t.after(async () => { await trace.store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { trace };
}

test('bound handoff preserves unverified state without a verified label', async t => {
  const { trace } = await fixture(t);
  for (const state of ['UNVERIFIED', 'NOT VERIFIED', 'PASS pending', 'UNCONFIRMED', 'VERIFIED but NOT_PROVEN', 'PASS but BLOCKED']) {
    const recipient = `recipient-${state}`;
    const sender = host(`sender-${state}`);
    const evidence = await trace.after({ ...sender, tool: 'read', status: 'completed', result: { output: 'inspection complete' } });
    await trace.note({ milestone: { kind: 'handoff', summary: 'unfinished work', current_state: state, to_session: recipient, evidence_refs: [evidence.ref] } }, sender);
    const am = trace.computeActiveMemory(trace.store.session(recipient));
    assert.equal(am.current_state, state);
    assert.equal(am.verified_state, null, state);
    assert.doesNotMatch(trace.formatActiveMemory(am), /Verified state:/);
  }
});

test('PASSED requires the same evidence as PASS and VERIFIED', async t => {
  const { trace } = await fixture(t);
  for (const current_state of ['PASSED', 'VERIFIED_FINAL']) {
    const note = await trace.note({ milestone: { kind: 'verification', summary: 'claimed pass', current_state } }, host());
    assert.equal(note.note.milestone.current_state, 'CLAIMED / UNVERIFIED');
  }
  assert.equal(trace.computeActiveMemory(trace.store.session('worker')).verified_state, null);
});

test('explicit failed result envelopes cannot auto-promote a passing log', async t => {
  const { trace } = await fixture(t);
  const failures = [
    { output: 'PASS', exit: 1 },
    { output: 'PASS', metadata: { exitCode: '2' } },
    { output: 'PASS', metadata: { raw: { ok: false } } },
    { output: 'PASS', status: 'FAILED' },
  ];
  for (const [i, result] of failures.entries()) {
    const h = host(`case-${i}`);
    await trace.after({ ...h, id: 'before', tool: 'shell', input: { command: 'npm test' }, status: 'completed', result: { output: 'FAIL', exit: 1 } });
    const event = await trace.after({ ...h, id: 'after', tool: 'shell', input: { command: 'npm test' }, status: 'completed', result });
    assert.equal(await trace.isVerifiedEvidence(event.ref), false, JSON.stringify(result));
    assert.equal(trace.computeActiveMemory(trace.store.session(h.sessionID)).verified_state, null, JSON.stringify(result));
  }
});

test('different verification commands do not automatically resolve each other', async t => {
  const { trace } = await fixture(t);
  await trace.after({ ...host(), id: 'a', tool: 'shell', input: { command: 'npm test -- storage' }, status: 'completed', result: { output: 'FAIL', exit: 1 } });
  await trace.after({ ...host(), id: 'b', tool: 'shell', input: { command: 'npm test -- gpu' }, status: 'completed', result: { output: 'PASS', exit: 0 } });
  assert.equal(trace.store.session('worker').notes.length, 0);
});

test('latest failing state does not advertise an older passing state as verified', async t => {
  const { trace } = await fixture(t);
  const am = trace.computeActiveMemory({ notes: [
    { ref: 'old', at: 1, milestone: { kind: 'verification', summary: 'old pass', current_state: 'PASS' } },
    { ref: 'new', at: 2, milestone: { kind: 'verification', summary: 'regression', current_state: 'FAIL' } },
  ] });
  assert.equal(am.current_state, 'FAIL');
  assert.equal(am.verified_state, null);
});

test('compaction checkpoint preserves source memory but cannot resurrect a resolved blocker', async t => {
  const { trace } = await fixture(t);
  const old = await trace.note({ milestone: { kind: 'blocker', summary: 'OLD_BLOCKER', unresolved: ['OLD_BLOCKER'], next_action: 'FIX_OLD' } }, host());
  await trace.ensureCompactionCheckpoint('worker');
  const snapshot = trace.store.session('worker').notes.find(n => n.milestone?.summary?.startsWith('Compaction checkpoint: '));
  assert.ok(snapshot, 'snapshot remains durable for exact historical retrieval');
  assert.match((await trace.store.expand(snapshot.ref)).data ?? JSON.stringify(await trace.store.expand(snapshot.ref)), /OLD_BLOCKER/);
  assert.deepEqual(trace.computeActiveMemory(trace.store.session('worker')).open_blockers, ['OLD_BLOCKER']);
  await trace.note({ kind: 'correction', text: 'resolved', supersedes: [old.ref] }, host('worker', 'fix'));
  const assertResolved = store => {
    const am = trace.computeActiveMemory(store.session('worker'));
    assert.deepEqual(am.open_blockers, []);
    assert.equal(am.next_action, null);
    assert.equal(am.current_state, null);
  };
  assertResolved(trace.store);
  assert.ok(!trace.projection('worker').notes.some(n => n.ref === snapshot.ref));
  const reopened = await new Store(trace.store.workspace, trace.store.base).init();
  try { assertResolved(reopened); } finally { await reopened.close(); }
});

test('legacy automatic snapshots are excluded without hiding same-named user notes', async t => {
  const { trace } = await fixture(t);
  const milestone = { kind: 'state_change', summary: 'Compaction checkpoint: active state preserved', current_state: 'CHECKPOINTED', unresolved: ['LEGACY_BLOCKER'], do_not_repeat: [], evidence_refs: [] };
  await trace.autoRecordMilestone('legacy', milestone, { sessionID: 'legacy', agent: 'build' });
  assert.deepEqual(trace.computeActiveMemory(trace.store.session('legacy')).open_blockers, []);
  await trace.note({ milestone }, host('manual'));
  assert.deepEqual(trace.computeActiveMemory(trace.store.session('manual')).open_blockers, ['LEGACY_BLOCKER']);
  await trace.note({ milestone }, { sessionID: 'manual-no-message', id: 'user-call', agent: 'build' });
  assert.deepEqual(trace.computeActiveMemory(trace.store.session('manual-no-message')).open_blockers, ['LEGACY_BLOCKER']);
  await trace.note({ milestone: { ...milestone, what_changed: 'User detail outside the generator shape' } }, { sessionID: 'manual-detail', agent: 'build' });
  assert.deepEqual(trace.computeActiveMemory(trace.store.session('manual-detail')).open_blockers, ['LEGACY_BLOCKER']);
});

test('checkpoint creation does not overwrite the verification transition source', async t => {
  const { trace } = await fixture(t);
  for (const [id, output, exit] of [['one', 'FAIL', 1], ['two', 'PASS', 0]]) {
    await trace.after({ ...host(), id, tool: 'shell', input: { command: 'npm test' }, status: 'completed', result: { output, exit } });
  }
  const transition = trace.store.session('worker').lastVerification.milestone_ref;
  assert.ok(transition);
  await trace.ensureCompactionCheckpoint('worker');
  assert.equal(trace.store.session('worker').lastVerification.milestone_ref, transition);
});

test('superseded peer handoffs stay absent beyond the normal note window and reload', async t => {
  const { trace } = await fixture(t);
  const old = await trace.note({ milestone: { kind: 'handoff', summary: 'OBSOLETE_HANDOFF', to_session: 'receiver' } }, host('sender'));
  await trace.note({ kind: 'correction', text: 'cancel handoff', supersedes: [old.ref] }, host('sender', 'cancel'));
  for (let i = 0; i < 70; i++) await trace.note({ kind: 'finding', text: `noise ${i}` }, host('sender', `noise-${i}`));
  assert.equal(trace.projection('receiver').peers.find(p => p.sessionID === 'sender').handoff, undefined);
  const reopened = await new Store(trace.store.workspace, trace.store.base).init();
  const original = trace.store;
  try {
    trace.store = reopened;
    assert.equal(trace.projection('receiver').peers.find(p => p.sessionID === 'sender').handoff, undefined);
  } finally { trace.store = original; await reopened.close(); }
});

test('a worker step success remains a worker report and does not become verified evidence', async t => {
  const { trace } = await fixture(t);
  await trace.store.record('trace.step', host('owner'), { plan_id: 'plan_fixture', version: 'v1', step: 'fix', state: 'started', sessionID: 'worker', attempt_id: 'attempt_fixture' }, { plan_id: 'plan_fixture', step: 'fix' });
  const result = await trace.stepResult({ status: 'success', summary: 'worker claims success', source_refs: [] }, host());
  assert.equal(result.status, 'success');
  const am = trace.computeActiveMemory(trace.store.session('worker'));
  assert.equal(am.current_state, 'WORKER_REPORTED_SUCCESS');
  assert.equal(am.verified_state, null);
  assert.equal(await trace.isVerifiedEvidence(result.result_ref), false);
});
