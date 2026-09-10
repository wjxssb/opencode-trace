import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Trace } from '../src/trace.js';

async function fixture(t, session) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-trace-plan-'));
  const ctx = { location: { directory: dir }, ...(session ? { session } : {}) };
  const trace = new Trace(ctx, { storeRoot: path.join(dir, 'store') });
  await trace.ready;
  t.after(async () => { trace.store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, trace };
}
const host = (sessionID = 's1', id = 'c1') => ({ sessionID, messageID: 'm1', id, agent: 'build' });

const nativeSessions = log => ({
  create: async ({ title }) => { const id = `ses_child_${log.create.push(title)}`; log.sessions.push(id); return { data: { id } }; },
  prompt: async ({ sessionID, text }) => { log.prompts.push({ sessionID, text }); if (log.failPrompt?.has(sessionID)) throw new Error('step prompt rejected'); return { data: { id: `msg_in_${log.prompts.length}` } }; },
  wait: async ({ sessionID }) => { log.waits.push(sessionID); },
  context: async ({ sessionID }) => ({ data: [
    { id: 'msg_u', type: 'user', role: 'user', text: log.prompts.find(p => p.sessionID === sessionID)?.text ?? '', time: { created: 1 } },
    { id: `msg_a_${sessionID}`, type: 'assistant', role: 'assistant', text: `TRACE_FIXTURE_DONE ${sessionID}`, time: { created: 2, completed: 3 }, finish: 'stop' },
  ] }),
  interrupt: async ({ sessionID }) => { log.interrupts.push(sessionID); },
});

test('P4: fan-out waves, serial dependency and collected terminal evidence', async t => {
  const log = { create: [], sessions: [], prompts: [], waits: [], interrupts: [] };
  const { trace } = await fixture(t, nativeSessions(log));
  const out = await trace.plan({
    steps: [
      { id: 'alpha', text: 'TRACE_CASE=alpha inspect module' },
      { id: 'beta', text: 'TRACE_CASE=beta inspect tests' },
      { id: 'join', text: 'combine findings', depends_on: ['alpha', 'beta'] },
      { id: 'final', text: 'write summary', depends_on: ['join'] },
    ],
  }, host());
  assert.equal(out.steps.filter(s => s.state === 'succeeded').length, 4);
  assert.ok(out.steps.every(s => s.sessionID?.startsWith('ses_child_')));
  // alpha and beta fan out before join; join strictly after both; final last.
  const started = log.prompts.map(p => p.sessionID);
  const indexOf = sid => started.indexOf(sid);
  const joinStep = out.steps.find(s => s.id === 'join'), alpha = out.steps.find(s => s.id === 'alpha'), beta = out.steps.find(s => s.id === 'beta');
  const finalStep = out.steps.find(s => s.id === 'final');
  assert.ok(indexOf(joinStep.sessionID) > indexOf(alpha.sessionID) && indexOf(joinStep.sessionID) > indexOf(beta.sessionID));
  assert.ok(indexOf(finalStep.sessionID) > indexOf(joinStep.sessionID));
  assert.equal(log.waits.length, 4, 'every step waited for native idle');
  assert.deepEqual(log.interrupts, []);
  // Terminal evidence recorded per step with exact binding.
  for (const step of out.steps) {
    const event = JSON.parse((await trace.store.readBlob((await trace.store.readEvent(step.evidence_ref)).payload.ref)).toString());
    assert.equal(event.state, 'succeeded');
    assert.equal(event.sessionID, step.sessionID);
    assert.match(event.evidence.output_preview, /TRACE_FIXTURE_DONE/);
    assert.ok(event.evidence.last_message_id);
  }
  // Recorded plan and step events are retrievable without refs.
  const found = await trace.find({ plan: out.plan_id, type: 'trace.step' });
  assert.equal(found.results.length >= 8, true, 'started+succeeded events for four steps are indexed');
});

test('P4: resume never re-executes recorded terminal states', async t => {
  const log = { create: [], sessions: [], prompts: [], waits: [], interrupts: [] };
  const { trace } = await fixture(t, nativeSessions(log));
  const steps = [{ id: 'only', text: 'do the thing once' }];
  const first = await trace.plan({ steps }, host());
  assert.equal(first.steps[0].state, 'succeeded');
  const creates = log.create.length;
  const second = await trace.plan({ steps }, host());
  assert.equal(second.steps[0].state, 'already_succeeded');
  assert.equal(second.steps[0].reused, true);
  assert.equal(second.steps[0].sessionID, first.steps[0].sessionID, 'reuses the original native binding');
  assert.equal(log.create.length, creates, 'no native session re-created');
  // A changed plan is a new version and re-runs.
  const third = await trace.plan({ steps: [{ id: 'only', text: 'do the thing differently' }] }, host());
  assert.equal(third.steps[0].state, 'succeeded');
  assert.notEqual(third.plan_id, first.plan_id);
  assert.equal(log.create.length, creates + 1);
});

test('P4: failed step cancels dependents; validation rejects cycles and bad shapes', async t => {
  const log = { create: [], sessions: [], prompts: [], waits: [], interrupts: [], failPrompt: new Set(['ses_child_1']) };
  const { trace } = await fixture(t, nativeSessions(log));
  const steps = [
    { id: 'root', text: 'will fail' },
    { id: 'child', text: 'depends on root', depends_on: ['root'] },
    { id: 'side', text: 'independent survives' },
  ];
  const out = await trace.plan({ steps }, host());
  assert.equal(out.steps.find(s => s.id === 'root').state, 'failed');
  assert.equal(out.steps.find(s => s.id === 'child').state, 'cancelled');
  assert.equal(out.steps.find(s => s.id === 'side').state, 'succeeded');
  assert.equal(log.interrupts.length, 1, 'failed step interrupted natively');
  assert.match(out.note, /terminal on resume/);
  // Failure is terminal on resume: a failed step may have had side effects,
  // so an identical re-invocation must not re-execute it.
  const createsBefore = log.create.length;
  const defaultRetry = await trace.plan({ steps }, host());
  assert.equal(defaultRetry.steps.find(s => s.id === 'root').state, 'already_failed', 'failed steps are terminal');
  assert.equal(defaultRetry.steps.find(s => s.id === 'side').state, 'already_succeeded', 'succeeded steps never re-run');
  assert.equal(log.create.length, createsBefore, 'nothing re-executed by default');
  // Explicit retry_failed opts in to a fresh attempt with a new binding.
  log.failPrompt.clear();
  const retry = await trace.plan({ steps, retry_failed: true }, host());
  assert.equal(retry.steps.find(s => s.id === 'root').state, 'succeeded', 'explicit retry re-runs failed steps');
  assert.equal(retry.steps.find(s => s.id === 'side').state, 'already_succeeded', 'succeeded steps still never re-run');
  assert.equal(log.create.length, createsBefore + 1, 'exactly the failed step re-executed');
  await assert.rejects(trace.plan({ steps: [{ id: 'a', text: 'x', depends_on: ['b'] }, { id: 'b', text: 'y', depends_on: ['a'] }] }, host()), /cycle/i);
  await assert.rejects(trace.plan({ steps: [{ id: 'a', text: 'x', depends_on: ['ghost'] }] }, host()), /invalid dependency/i);
  await assert.rejects(trace.plan({ steps: Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, text: 'x' })) }, host()), /1-8 steps/);
});

test('P4: plan identity is scoped to the owning session; identical step lists never cross sessions', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-trace-planiso-'));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const storeRoot = path.join(dir, 'store');
  const log = { create: [], sessions: [], prompts: [], waits: [], interrupts: [] };
  const mk = () => { const trace = new Trace({ location: { directory: dir }, session: nativeSessions(log) }, { storeRoot }); return trace.ready.then(() => trace); };
  const t1 = await mk(); const t2 = await mk();
  t1.store.session('s1'); t1.store.session('s2');
  const steps = [{ id: 'scan', text: 'TRACE_CASE=scan identical work' }];
  const first = await t1.plan({ steps }, host('s1'));
  assert.equal(first.steps[0].state, 'succeeded');
  const second = await t2.plan({ steps }, host('s2'));
  assert.notEqual(second.plan_id, first.plan_id, 'owner+version identity separates sessions');
  assert.equal(second.steps[0].state, 'succeeded', 'the second owner executes fresh');
  assert.notEqual(second.steps[0].sessionID, first.steps[0].sessionID);
  // Same owner still resumes instead of re-executing.
  const resumed = await t1.plan({ steps }, host('s1'));
  assert.equal(resumed.steps[0].state, 'already_succeeded');
  assert.equal(log.create.length, 2, 'exactly two native executions total');
  t1.store.close(); t2.store.close();
});

test('P4: step agent binding must reference a real host agent and binds via native switching', async t => {
  const log = { create: [], sessions: [], prompts: [], waits: [], interrupts: [], switches: [] };
  const session = { ...nativeSessions(log), switchAgent: async ({ sessionID, agent }) => { log.switches.push({ sessionID, agent }); } };
  const { trace } = await fixture(t, session);
  // No snapshot yet: role strings cannot be trusted without host evidence.
  await assert.rejects(trace.plan({ steps: [{ id: 'a', text: 'x', agent: 'reviewer' }] }, host()), /No agents snapshot/);
  await trace.store.record('agents.snapshot', {}, [{ id: 'build', name: 'Build' }, { id: 'reviewer', name: 'Reviewer' }]);
  await assert.rejects(trace.plan({ steps: [{ id: 'a', text: 'x', agent: 'invented-role' }] }, host()), /unknown host agent/);
  const out = await trace.plan({ steps: [{ id: 'review', text: 'TRACE_CASE=review check the diff', agent: 'reviewer' }] }, host());
  assert.equal(out.steps[0].state, 'succeeded');
  assert.deepEqual(log.switches, [{ sessionID: out.steps[0].sessionID, agent: 'reviewer' }]);
  const stepStates = await Promise.all([...trace.store.index.values()].filter(e => e.type === 'trace.step')
    .map(async r => JSON.parse((await trace.store.readBlob(r.payloadRef)).toString())));
  assert.ok(stepStates.some(s => s.state === 'started' && s.agent === 'reviewer'), 'agent binding recorded on the step evidence');
  // Without native agent switching the step is recorded honestly as unsupported.
  const limited = await fixture(t, nativeSessions({ create: [], sessions: [], prompts: [], waits: [], interrupts: [] }));
  await limited.trace.store.record('agents.snapshot', {}, [{ id: 'reviewer' }]);
  const honest = await limited.trace.plan({ steps: [{ id: 'r', text: 'x', agent: 'reviewer' }] }, host());
  assert.equal(honest.steps[0].state, 'unsupported');
});

test('P4: unsupported host primitives are recorded honestly, never faked', async t => {
  const { trace } = await fixture(t, {});
  const out = await trace.plan({ steps: [{ id: 'solo', text: 'cannot run' }] }, host());
  assert.equal(out.steps[0].state, 'unsupported');
  assert.match(out.note, /dependents were cancelled|not every step succeeded/);
  const event = JSON.parse((await trace.store.readBlob((await trace.store.readEvent(out.steps[0].evidence_ref)).payload.ref)).toString());
  assert.equal(event.state, 'unsupported');
});
