import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Trace } from '../src/trace.js';
import { hash, stable } from '../src/util.js';

async function fixture(t, session) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-trace-plan-'));
  const ctx = { location: { directory: dir }, ...(session ? { session } : {}) };
  const trace = new Trace(ctx, { storeRoot: path.join(dir, 'store') });
  await trace.ready;
  t.after(async () => { trace.store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, trace };
}
const host = (sessionID = 's1', id = 'c1') => ({ sessionID, messageID: 'm1', id, agent: 'build' });

// Simulated native sessions. log.submit, when set, runs inside the child turn
// and stands in for the worker calling trace_step_result.
const nativeSessions = log => ({
  create: async ({ title }) => { const id = `ses_child_${log.create.push(title)}`; log.sessions.push(id); return { data: { id } }; },
  prompt: async ({ sessionID, text, metadata }) => {
    log.prompts.push({ sessionID, text, metadata });
    if (log.failPrompt?.has(sessionID)) throw new Error('step prompt rejected');
    if (log.submit) await log.submit(sessionID);
    return { data: { id: `msg_in_${log.prompts.length}` } };
  },
  wait: async ({ sessionID }) => { log.waits.push(sessionID); },
  context: async ({ sessionID }) => ({ data: [
    { id: 'msg_u', type: 'user', role: 'user', text: log.prompts.find(p => p.sessionID === sessionID)?.text ?? '', time: { created: 1 } },
    { id: `msg_a_${sessionID}`, type: 'assistant', role: 'assistant', text: `TRACE_FIXTURE_DONE ${sessionID}`, time: { created: 2, completed: 3 }, finish: 'stop' },
  ] }),
  interrupt: async ({ sessionID }) => { log.interrupts.push(sessionID); },
  switchAgent: log.switchAgent ? async ({ sessionID, agent }) => { log.switches.push({ sessionID, agent }); } : undefined,
});

test('P5.2: settled-with-worker-success gates the DAG; failure and unknown block dependents', async t => {
  const log = { create: [], sessions: [], prompts: [], waits: [], interrupts: [] };
  log.submit = async sessionID => { await trace.stepResult({ status: 'success', summary: 'done' }, { sessionID }); };
  const { trace } = await fixture(t, nativeSessions(log));
  const out = await trace.plan({
    steps: [
      { id: 'alpha', text: 'TRACE_CASE=alpha inspect module' },
      { id: 'beta', text: 'TRACE_CASE=beta inspect tests' },
      { id: 'join', text: 'combine findings', depends_on: ['alpha', 'beta'] },
    ],
  }, host());
  assert.ok(out.steps.every(s => s.execution === 'settled' && s.outcome === 'worker_reported_success'), JSON.stringify(out.steps));
  const indexOf = sid => log.prompts.map(p => p.sessionID).indexOf(sid);
  const joinStep = out.steps.find(s => s.id === 'join');
  assert.ok(indexOf(joinStep.sessionID) > indexOf(out.steps.find(s => s.id === 'alpha').sessionID));
  assert.equal(log.waits.length, 3);
  const joinPrompt = log.prompts.find(p => p.sessionID === joinStep.sessionID);
  assert.match(joinPrompt.text, /trace_step_result/);
  assert.equal(joinPrompt.metadata.opencode_trace_assignment.owner_session, host().sessionID);
  assert.equal(joinPrompt.metadata.opencode_trace_assignment.dependencies.length, 2);
  assert.ok(joinPrompt.metadata.opencode_trace_assignment.dependencies.every(d => d.evidence_ref.startsWith('evt_')));
  const planRecord = JSON.parse((await trace.store.readBlob(trace.store.index.get(out.plan_ref).payloadRef)).toString());
  assert.equal(planRecord.steps.find(s => s.id === 'join').text, 'combine findings');
  assert.deepEqual(log.interrupts, []);
  // Terminal evidence: execution and outcome are separate, the worker result
  // is linked, and settled never claims success by itself.
  const stepStates = await Promise.all([...trace.store.index.values()].filter(e => e.type === 'trace.step')
    .map(async r => ({ at: r.at, ...JSON.parse((await trace.store.readBlob(r.payloadRef)).toString()) })));
  const settled = stepStates.filter(s => s.state === 'settled');
  assert.equal(settled.length, 3);
  assert.ok(settled.every(s => s.outcome === 'worker_reported_success' && s.result_ref?.startsWith('evt_')));
  const joinStarted = stepStates.find(s => s.step === 'join' && s.state === 'started');
  const alphaStarted = stepStates.find(s => s.step === 'alpha' && s.state === 'started');
  assert.ok(joinStarted.at >= alphaStarted.at);
  // DAG gating: a worker-reported failure blocks dependents; a sibling with
  // worker-reported success still runs.
  const log2 = { create: [], sessions: [], prompts: [], waits: [], interrupts: [] };
  log2.submit = async sessionID => {
    const status = sessionID === 'ses_child_1' ? 'failure' : 'success';
    await trace2.trace.stepResult({ status, summary: `reported ${status}` }, { sessionID });
  };
  const trace2 = await fixture(t, nativeSessions(log2));
  const gated = await trace2.trace.plan({ steps: [
    { id: 'root', text: 'will report failure' },
    { id: 'dependent', text: 'needs root', depends_on: ['root'] },
    { id: 'side', text: 'independent' },
  ] }, host());
  assert.equal(gated.steps.find(s => s.id === 'root').outcome, 'worker_reported_failure');
  assert.equal(gated.steps.find(s => s.id === 'dependent').execution, 'cancelled');
  assert.equal(gated.steps.find(s => s.id === 'side').outcome, 'worker_reported_success');
  // No submission at all: outcome unknown, dependents cancelled.
  const log3 = { create: [], sessions: [], prompts: [], waits: [], interrupts: [] };
  const trace3 = await fixture(t, nativeSessions(log3));
  const silent = await trace3.trace.plan({ steps: [
    { id: 'quiet', text: 'worker never submits' },
    { id: 'after', text: 'needs quiet', depends_on: ['quiet'] },
  ] }, host());
  assert.equal(silent.steps.find(s => s.id === 'quiet').outcome, 'unknown');
  assert.equal(silent.steps.find(s => s.id === 'after').execution, 'cancelled');
});

test('P5.2: settled/transport_failed are terminal on resume; retry_failed re-runs explicitly', async t => {
  const log = { create: [], sessions: [], prompts: [], waits: [], interrupts: [], failPrompt: new Set(['ses_child_1']) };
  const { trace } = await fixture(t, nativeSessions(log));
  const steps = [{ id: 'root', text: 'will fail' }, { id: 'side', text: 'independent' }];
  const out = await trace.plan({ steps }, host());
  assert.equal(out.steps.find(s => s.id === 'root').execution, 'transport_failed');
  assert.equal(log.interrupts.length, 1);
  const createsBefore = log.create.length;
  const resumed = await trace.plan({ steps }, host());
  assert.equal(resumed.steps.find(s => s.id === 'root').state, 'already_transport_failed', 'transport failure is terminal');
  assert.equal(resumed.steps.find(s => s.id === 'side').state, 'already_settled(unknown)');
  assert.equal(log.create.length, createsBefore, 'default resume executes nothing');
  log.failPrompt.clear();
  log.submit = async sessionID => { await trace.stepResult({ status: 'success' }, { sessionID }); };
  const retried = await trace.plan({ steps, retry_failed: true }, host());
  assert.equal(retried.steps.find(s => s.id === 'root').execution, 'settled');
  assert.equal(retried.steps.find(s => s.id === 'root').outcome, 'worker_reported_success');
  // retry_failed re-runs every step that lacks worker-reported success,
  // including unknown-outcome ones, with fresh evidence for both attempts.
  assert.equal(retried.steps.find(s => s.id === 'side').execution, 'settled');
  assert.equal(retried.steps.find(s => s.id === 'side').reused, false);
  assert.equal(log.create.length, createsBefore + 2, 'both non-success steps re-executed');
  await assert.rejects(trace.plan({ steps: [{ id: 'a', text: 'x', depends_on: ['b'] }, { id: 'b', text: 'y', depends_on: ['a'] }] }, host()), /cycle/i);
  await assert.rejects(trace.plan({ steps: [{ id: 'a', text: 'x', depends_on: ['ghost'] }] }, host()), /invalid dependency/i);
  await assert.rejects(trace.plan({ steps: Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, text: 'x' })) }, host()), /1-8 steps/);
});

test('P4: unsupported host primitives are recorded honestly, never faked', async t => {
  const { trace } = await fixture(t, {});
  const out = await trace.plan({ steps: [{ id: 'solo', text: 'cannot run' }] }, host());
  assert.equal(out.steps[0].execution, 'unsupported');
  assert.match(out.note, /terminal on resume|not every step/);
  const event = JSON.parse((await trace.store.readBlob((await trace.store.readEvent(out.steps[0].evidence_ref)).payload.ref)).toString());
  assert.equal(event.state, 'unsupported');
});

test('P4: plan identity is scoped to the owning session; identical step lists never cross sessions', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-trace-planiso-'));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const storeRoot = path.join(dir, 'store');
  const log = { create: [], sessions: [], prompts: [], waits: [], interrupts: [] };
  const traces = [];
  const mk = () => {
    const trace = new Trace({ location: { directory: dir }, session: nativeSessions(log) }, { storeRoot });
    traces.push(trace);
    log.submit = async sessionID => { await traces.at(-1).stepResult({ status: 'success' }, { sessionID }); };
    return trace.ready.then(() => trace);
  };
  const t1 = await mk(); const t2 = await mk();
  t1.store.session('s1'); t1.store.session('s2');
  const steps = [{ id: 'scan', text: 'TRACE_CASE=scan identical work' }];
  const first = await t1.plan({ steps }, host('s1'));
  assert.equal(first.steps[0].outcome, 'worker_reported_success');
  const second = await t2.plan({ steps }, host('s2'));
  assert.notEqual(second.plan_id, first.plan_id, 'owner+version identity separates sessions');
  assert.equal(second.steps[0].outcome, 'worker_reported_success', 'the second owner executes fresh');
  assert.notEqual(second.steps[0].sessionID, first.steps[0].sessionID);
  const resumed = await t1.plan({ steps }, host('s1'));
  assert.match(resumed.steps[0].state, /already_settled/);
  assert.equal(log.create.length, 2, 'exactly two native executions total');
  t1.store.close(); t2.store.close();
});

test('P4: step agent binding must reference a real host agent and binds via native switching', async t => {
  const log = { create: [], sessions: [], prompts: [], waits: [], interrupts: [], switches: [] };
  const current = { trace: null };
  log.submit = async sessionID => { await current.trace.stepResult({ status: 'success' }, { sessionID }); };
  const session = { ...nativeSessions(log), switchAgent: async ({ sessionID, agent }) => { log.switches.push({ sessionID, agent }); } };
  const { trace } = await fixture(t, session);
  current.trace = trace;
  await assert.rejects(trace.plan({ steps: [{ id: 'a', text: 'x', agent: 'reviewer' }] }, host()), /No agents snapshot/);
  await trace.store.record('agents.snapshot', {}, [{ id: 'build', name: 'Build' }, { id: 'reviewer', name: 'Reviewer' }]);
  await assert.rejects(trace.plan({ steps: [{ id: 'a', text: 'x', agent: 'invented-role' }] }, host()), /unknown host agent/);
  const out = await trace.plan({ steps: [{ id: 'review', text: 'TRACE_CASE=review check the diff', agent: 'reviewer' }] }, host());
  assert.equal(out.steps[0].execution, 'settled');
  assert.deepEqual(log.switches, [{ sessionID: out.steps[0].sessionID, agent: 'reviewer' }]);
  const stepStates = await Promise.all([...trace.store.index.values()].filter(e => e.type === 'trace.step')
    .map(async r => JSON.parse((await trace.store.readBlob(r.payloadRef)).toString())));
  assert.ok(stepStates.some(s => s.state === 'started' && s.agent === 'reviewer'), 'agent binding recorded on the step evidence');
  assert.ok(stepStates.some(s => s.state === 'settled' && s.agent === 'reviewer'));
  // Without native agent switching the step is recorded honestly as unsupported.
  const limited = await fixture(t, nativeSessions({ create: [], sessions: [], prompts: [], waits: [], interrupts: [] }));
  await limited.trace.store.record('agents.snapshot', {}, [{ id: 'reviewer' }]);
  const honest = await limited.trace.plan({ steps: [{ id: 'r', text: 'x', agent: 'reviewer' }] }, host());
  assert.equal(honest.steps[0].execution, 'unsupported');
});

test('P5.2: create/agent-binding failures are journaled with phase and child session, and cleaned up', async t => {
  const log = { create: [], sessions: [], prompts: [], waits: [], interrupts: [], switches: [], failSwitch: true };
  const session = { create: async ({ title }) => { const id = `ses_child_${log.create.push(title)}`; log.sessions.push(id); return { data: { id } }; },
    switchAgent: async ({ sessionID, agent }) => { if (log.failSwitch) throw new Error('agent profile vanished'); log.switches.push({ sessionID, agent }); },
    prompt: async () => { throw new Error('must not be reached'); },
    wait: async () => {}, context: async () => ({ data: [] }), interrupt: async ({ sessionID }) => { log.interrupts.push(sessionID); } };
  const { trace } = await fixture(t, session);
  await trace.store.record('agents.snapshot', {}, [{ id: 'reviewer' }]);
  const out = await trace.plan({ steps: [{ id: 'bound', text: 'needs a role', agent: 'reviewer' }, { id: 'after', text: 'needs bound', depends_on: ['bound'] }] }, host());
  const failed = out.steps.find(s => s.id === 'bound');
  assert.equal(failed.execution, 'failed');
  assert.equal(failed.phase, 'bind_agent');
  assert.ok(failed.sessionID?.startsWith('ses_child_'), 'orphan child session recorded in the journal');
  assert.equal(out.steps.find(s => s.id === 'after').execution, 'cancelled');
  assert.deepEqual(log.interrupts, [failed.sessionID], 'best-effort cleanup of the orphan child');
  assert.deepEqual(log.prompts, [], 'prompt never ran after a bind failure');
  assert.ok(failed.attempt_id, 'even a pre-start failure journal belongs to a recorded attempt');
});

test('P5.2: worker results are per-attempt - replays dedupe, conflicts are rejected, identity is binding-derived', async t => {
  const log = { create: [], sessions: [], prompts: [], waits: [], interrupts: [] };
  const { trace } = await fixture(t, nativeSessions(log));
  let firstRef = null;
  log.submit = async sessionID => {
    // Forged plan/step fields must be ignored: identity comes from the binding.
    firstRef = (await trace.stepResult({ status: 'success', summary: 'done', plan_id: 'plan_forge', step: 'forged' }, { sessionID })).result_ref;
    log.dedup = await trace.stepResult({ status: 'success', summary: 'done' }, { sessionID });
    log.conflict = await trace.stepResult({ status: 'failure', summary: 'changed mind' }, { sessionID }).catch(e => e);
  };
  const out = await trace.plan({ steps: [{ id: 'solo', text: 'worker submits once' }] }, host());
  const step = out.steps[0];
  assert.equal(step.execution, 'settled');
  assert.equal(step.outcome, 'worker_reported_success', 'the first recorded claim decides the outcome');
  assert.ok(step.attempt_id, 'the step carries a fresh attempt id');
  assert.equal(log.dedup.deduplicated, true, 'identical replay is deduplicated');
  assert.equal(log.dedup.result_ref, firstRef, 'dedupe returns the original event, not a copy');
  assert.ok(log.conflict instanceof Error, 'a conflicting second claim is rejected');
  assert.match(log.conflict.message, /Conflicting worker result/);
  assert.match(log.conflict.message, /'success'/, 'the rejection names the standing first claim');
  // Exactly one immutable result event exists: no silent overwrite.
  const resultRows = trace.store.findEntries({ type: 'trace.step.result' }, null, 8);
  assert.equal(resultRows.length, 1);
  const result = JSON.parse((await trace.store.readBlob(resultRows[0].payloadRef)).toString());
  assert.equal(result.plan_id, out.plan_id, 'forged plan_id input was ignored');
  assert.equal(result.step, 'solo', 'forged step input was ignored');
  assert.equal(result.worker_session, step.sessionID);
  const stepRows = trace.store.findEntries({ type: 'trace.step' }, null, 16);
  let started = null;
  for (const row of stepRows) {
    const data = JSON.parse((await trace.store.readBlob(row.payloadRef)).toString());
    if (data.state === 'started') { started = { data, ref: row.ref }; break; }
  }
  assert.equal(result.attempt_id, started.data.attempt_id, 'the result pairs to the exact attempt');
  assert.equal(result.binding_ref, started.ref);
  // An unbound session cannot submit a result at all.
  await assert.rejects(trace.stepResult({ status: 'success' }, { sessionID: 'ses_ghost' }), /not bound to any plan step/);
});

test('P5.3: replay comparison covers the full structured claim including source_refs', async t => {
  const log = { create: [], sessions: [], prompts: [], waits: [], interrupts: [] };
  const { trace } = await fixture(t, nativeSessions(log));
  const evidenceA = (await trace.after({ ...host(), tool: 'read', input: { filePath: 'a.log' }, status: 'completed', result: { content: [{ type: 'text', text: 'evidence A' }] } })).ref;
  const evidenceB = (await trace.after({ ...host(), tool: 'read', input: { filePath: 'b.log' }, status: 'completed', result: { content: [{ type: 'text', text: 'evidence B' }] } })).ref;
  let conflict = null, second = null;
  log.submit = async sessionID => {
    await trace.stepResult({ status: 'success', summary: 'done', source_refs: [evidenceA] }, { sessionID });
    // Same status+summary but different evidence: NOT an identical replay.
    second = await trace.stepResult({ status: 'success', summary: 'done', source_refs: [evidenceB] }, { sessionID }).catch(e => e);
    conflict = await trace.stepResult({ status: 'failure', summary: 'done', source_refs: [evidenceA] }, { sessionID }).catch(e => e);
  };
  const out = await trace.plan({ steps: [{ id: 'solo', text: 'evidence-aware replay' }] }, host());
  assert.equal(out.steps[0].outcome, 'worker_reported_success');
  assert.ok(second instanceof Error, 'same claim text with different source_refs is a conflict, not a replay');
  assert.match(second.message, /Conflicting worker result/);
  assert.ok(conflict instanceof Error);
  const rows = trace.store.findEntries({ type: 'trace.step.result' }, null, 8);
  assert.equal(rows.length, 1, 'no divergent claim was persisted');
  const data = JSON.parse((await trace.store.readBlob(rows[0].payloadRef)).toString());
  assert.deepEqual(data.source_refs, [evidenceA], 'the first recorded evidence stands');
});

test('P5.3: a late worker claim after a terminal attempt is stored as evidence, never rewriting the outcome', async t => {
  const log = { create: [], sessions: [], prompts: [], waits: [], interrupts: [] };
  const { trace } = await fixture(t, nativeSessions(log));
  let sid = null;
  log.submit = async session => { sid = session; await trace.stepResult({ status: 'success', summary: 'on time' }, { sessionID: session }); };
  const steps = [{ id: 'solo', text: 'worker submits during the turn' }];
  await trace.plan({ steps }, host());
  // The step is settled with worker-reported success; a much later claim on
  // the SAME attempt must not overwrite anything.
  const late = await trace.stepResult({ status: 'failure', summary: 'changed my mind later' }, { sessionID: sid });
  assert.equal(late.late, true, 'the late claim is stored, flagged late');
  assert.ok(late.result_ref.startsWith('evt_'));
  assert.equal(late.terminal_state, 'settled');
  // Identical late replay dedupes to the late event.
  const replay = await trace.stepResult({ status: 'failure', summary: 'changed my mind later' }, { sessionID: sid });
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.result_ref, late.result_ref);
  // The recorded step outcome is untouched and resume still reuses it.
  const resumed = await trace.plan({ steps }, host());
  assert.equal(resumed.steps[0].state, 'already_settled(worker_reported_success)');
  assert.equal(log.create.length, 1, 'no re-execution happened');
  const stepRows = trace.store.findEntries({ type: 'trace.step' }, null, 16);
  const settledPayloads = [];
  for (const row of stepRows) {
    const data = JSON.parse((await trace.store.readBlob(row.payloadRef)).toString());
    if (data.state === 'settled') settledPayloads.push(data);
  }
  assert.equal(settledPayloads.length, 1);
  assert.equal(settledPayloads[0].outcome, 'worker_reported_success', 'the recorded outcome never changed');
});

test('P5.3: plan resume reads full step history - a late success beyond the old 256-event window wins', async t => {
  const log = { create: [], sessions: [], prompts: [], waits: [], interrupts: [] };
  const { trace } = await fixture(t, nativeSessions(log));
  const steps = [{ id: 'solo', text: 'already done long ago' }];
  const version = hash(stable(steps));
  const planId = `plan_${hash(stable([host().sessionID, version])).slice(0, 24)}`;
  // Synthetic long history for one step: 140 failed attempts (280 events),
  // then a final success. The oldest-256 window of the previous resume logic
  // ended inside the failures and never saw the success.
  for (let i = 0; i < 140; i++) {
    const attempt = `attempt-old-${String(i).padStart(4, '0')}`;
    await trace.store.record('trace.step', host(), { plan_id: planId, version, step: 'solo', state: 'started', sessionID: `ses_old_${i}`, attempt_id: attempt }, { plan_id: planId, step: 'solo', worker: `ses_old_${i}` });
    await trace.store.record('trace.step', host(), { plan_id: planId, version, step: 'solo', state: 'settled', outcome: 'worker_reported_failure', sessionID: `ses_old_${i}`, attempt_id: attempt }, { plan_id: planId, step: 'solo' });
  }
  await trace.store.record('trace.step', host(), { plan_id: planId, version, step: 'solo', state: 'started', sessionID: 'ses_final', attempt_id: 'attempt-final-0000001' }, { plan_id: planId, step: 'solo', worker: 'ses_final' });
  await trace.store.record('trace.step', host(), { plan_id: planId, version, step: 'solo', state: 'settled', outcome: 'worker_reported_success', sessionID: 'ses_final', attempt_id: 'attempt-final-0000001' }, { plan_id: planId, step: 'solo' });
  const out = await trace.plan({ steps }, host());
  assert.equal(out.steps[0].reused, true, 'resume reuses recorded evidence');
  assert.equal(out.steps[0].execution, 'settled');
  assert.equal(out.steps[0].outcome, 'worker_reported_success', 'the newest terminal event decides, not the oldest window');
  assert.equal(log.create.length, 0, 'no session was created: the success was not hidden by old failures');
  assert.equal(out.steps[0].sessionID, 'ses_final');
});
