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
  const out = await trace.plan({ steps: [
    { id: 'root', text: 'will fail' },
    { id: 'child', text: 'depends on root', depends_on: ['root'] },
    { id: 'side', text: 'independent survives' },
  ] }, host());
  assert.equal(out.steps.find(s => s.id === 'root').state, 'failed');
  assert.equal(out.steps.find(s => s.id === 'child').state, 'cancelled');
  assert.equal(out.steps.find(s => s.id === 'side').state, 'succeeded');
  assert.equal(log.interrupts.length, 1, 'failed step interrupted natively');
  assert.match(out.note, /dependents were cancelled/);
  // Failure recovery: the failed step re-runs on a new invocation.
  log.failPrompt.clear();
  const retry = await trace.plan({ steps: out.steps ? [
    { id: 'root', text: 'will fail' },
    { id: 'child', text: 'depends on root', depends_on: ['root'] },
    { id: 'side', text: 'independent survives' },
  ] : [] }, host());
  assert.equal(retry.steps.find(s => s.id === 'root').state, 'succeeded', 'failed steps re-run');
  assert.equal(retry.steps.find(s => s.id === 'side').state, 'already_succeeded', 'succeeded steps never re-run');
  await assert.rejects(trace.plan({ steps: [{ id: 'a', text: 'x', depends_on: ['b'] }, { id: 'b', text: 'y', depends_on: ['a'] }] }, host()), /cycle/i);
  await assert.rejects(trace.plan({ steps: [{ id: 'a', text: 'x', depends_on: ['ghost'] }] }, host()), /invalid dependency/i);
  await assert.rejects(trace.plan({ steps: Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, text: 'x' })) }, host()), /1-8 steps/);
});

test('P4: unsupported host primitives are recorded honestly, never faked', async t => {
  const { trace } = await fixture(t, {});
  const out = await trace.plan({ steps: [{ id: 'solo', text: 'cannot run' }] }, host());
  assert.equal(out.steps[0].state, 'unsupported');
  assert.match(out.note, /dependents were cancelled|not every step succeeded/);
  const event = JSON.parse((await trace.store.readBlob((await trace.store.readEvent(out.steps[0].evidence_ref)).payload.ref)).toString());
  assert.equal(event.state, 'unsupported');
});
