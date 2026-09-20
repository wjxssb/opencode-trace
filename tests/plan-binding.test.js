import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Trace } from '../src/trace.js';
import { hash, stable } from '../src/util.js';

const owner = { sessionID: 'owner', agent: 'build', messageID: 'turn', id: 'plan-call' };
const cloud = { providerID: 'fixture-cloud', id: 'worker-model', variant: 'low' };
const local = { providerID: 'fixture-local', id: 'occupied-model', variant: 'thinking' };
const steps = [{ id: 'inspect', text: 'Inspect the fixture without side effects' }];
async function fixture(t, options = {}) {
  const directory = options.directory ?? await fs.mkdtemp(path.join(os.tmpdir(), 'trace-plan-binding-'));
  const records = new Map(), calls = { create: [], prompt: [], interrupted: [] };
  const session = {
    get: async ({ sessionID }) => ({ data: sessionID === 'owner'
      ? { id: sessionID, agent: 'build', ...(!options.missingOwnerModel ? { model: cloud } : {}) }
      : records.get(sessionID) }),
    create: async input => {
      calls.create.push(input);
      // Matches the pinned host: absent selections use a global default,
      // which intentionally differs from the owner's cloud model here.
      const value = { id: `child-${calls.create.length}`, agent: input.agent ?? 'default-agent', model: options.ignoreModel ? local : input.model ?? local };
      records.set(value.id, value); return { data: value };
    },
    switchAgent: async ({ sessionID, agent }) => { records.get(sessionID).agent = agent; },
    prompt: async input => { calls.prompt.push(input); if (options.prompt) await options.prompt(input); return { data: { id: 'admitted' } }; },
    wait: async () => { if (options.wait) await options.wait(); },
    context: async () => ({ data: [] }),
    interrupt: async ({ sessionID }) => { calls.interrupted.push(sessionID); },
  };
  const trace = new Trace({ location: { directory }, session }, { storeRoot: path.join(directory, 'store') });
  await trace.ready;
  t.after(async () => { await trace.store.close(); if (!options.directory) await fs.rm(directory, { recursive: true, force: true }); });
  return { trace, directory, calls };
}

test('plan creation inherits and verifies owner model, variant and agent instead of native defaults', async t => {
  const { trace, calls } = await fixture(t);
  const result = await trace.plan({ steps }, owner);
  assert.deepEqual(calls.create[0].model, cloud);
  assert.equal(calls.create[0].agent, 'build');
  assert.equal(result.steps[0].binding.verified, true);
  assert.deepEqual(result.steps[0].binding.actual, { agent: 'build', model: cloud });
  assert.equal(result.steps[0].outcome, 'unknown', 'binding verification is not task success');
});

test('explicit step profile keeps its agent and selected model with snapshot provenance', async t => {
  const { trace, calls } = await fixture(t);
  const profileModel = { providerID: 'fixture-cloud', id: 'review-model', variant: 'high' };
  const snapshot = await trace.store.record('agents.snapshot', {}, [{ id: 'reviewer', model: profileModel }]);
  const result = await trace.plan({ steps: [{ ...steps[0], agent: 'reviewer' }] }, owner);
  assert.equal(calls.create[0].agent, 'reviewer');
  assert.deepEqual(calls.create[0].model, profileModel);
  assert.equal(result.steps[0].binding.model_source, 'explicit_agent_profile');
  assert.equal(result.steps[0].binding.profile_ref, snapshot.ref);
  assert.equal(result.steps[0].binding.verified, true);
});

test('missing owner selection is unsupported; host context hook can supply the effective model', async t => {
  const { trace, calls } = await fixture(t, { missingOwnerModel: true });
  const unknown = await trace.plan({ steps }, owner);
  assert.equal(unknown.steps[0].execution, 'unsupported');
  assert.equal(calls.create.length, 0);
  await trace.context({ sessionID: 'owner', agent: 'build', model: cloud, messages: [], system: [] });
  const retry = await trace.plan({ steps, retry_failed: true }, owner);
  assert.deepEqual(calls.create[0].model, cloud);
  assert.equal(retry.steps[0].binding.model_source, 'owner_context_hook');
});

test('native model mismatch stops before prompt and preserves failed binding evidence', async t => {
  const { trace, calls } = await fixture(t, { ignoreModel: true });
  const result = await trace.plan({ steps }, owner);
  assert.equal(result.steps[0].execution, 'failed');
  assert.equal(result.steps[0].phase, 'verify_binding');
  assert.equal(result.steps[0].binding.verified, false);
  assert.deepEqual(result.steps[0].binding.actual.model, local);
  assert.equal(calls.prompt.length, 0);
  assert.deepEqual(calls.interrupted, ['child-1']);
});

test('concurrent same-owner plans across instances admit one execution and do not interrupt it', async t => {
  let release, reached;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { reached = resolve; });
  const first = await fixture(t, { wait: async () => { reached(); await waiting; } });
  const second = await fixture(t, { directory: first.directory });
  const running = first.trace.plan({ steps }, owner);
  await started;
  const collision = await second.trace.plan({ steps, retry_failed: true }, owner);
  assert.equal(collision.admission, 'in_flight_unknown');
  assert.equal(second.calls.create.length, 0);
  assert.equal(second.calls.interrupted.length, 0);
  assert.ok(collision.plan_ref);
  release();
  const settled = await running;
  assert.equal(settled.steps[0].execution, 'settled');
  const replay = await second.trace.plan({ steps }, owner);
  assert.equal(replay.steps[0].reused, true);
  assert.equal(second.calls.create.length, 0);
});

test('recorded started attempt without terminal evidence never replays even with retry_failed', async t => {
  const { trace, calls } = await fixture(t);
  const version = hash(stable(steps)), plan_id = `plan_${hash(stable(['owner', version])).slice(0, 24)}`;
  const started = await trace.store.record('trace.step', owner, { plan_id, version, step: 'inspect', sessionID: 'existing-child', attempt_id: 'interrupted-attempt', state: 'started' }, { plan_id, step: 'inspect', worker: 'existing-child' });
  const result = await trace.plan({ steps, retry_failed: true }, owner);
  assert.equal(result.steps[0].execution, 'in_flight_unknown');
  assert.equal(result.steps[0].sessionID, 'existing-child');
  assert.equal(result.steps[0].evidence_ref, started.ref);
  assert.equal(calls.create.length, 0);
});
