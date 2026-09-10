import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Trace } from '../src/trace.js';

const hostOf = (sessionID, id = 'c1') => ({ sessionID, messageID: 'm1', id, agent: 'build' });
const open = (dir, session = {}) => {
  const trace = new Trace({ location: { directory: dir }, ...(session ? { session } : {}) }, { storeRoot: path.join(dir, 'store') });
  return trace.ready.then(() => trace);
};
const native = log => ({
  create: async () => ({ data: { id: `ses_w_${++log.n}` } }),
  prompt: async ({ sessionID }) => { log.prompts.push(sessionID); if (log.submit) await log.submit(sessionID); return { data: { id: 'in' } }; },
  wait: async () => {},
  context: async () => ({ data: [{ id: 'a1', type: 'assistant', role: 'assistant', text: 'worker output', time: { created: 1, completed: 2 }, finish: 'stop' }] }),
});

test('P5.2: restart rebuilds every projection - delivery crash window, worker step results and thread membership survive', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-trace-restart-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  // ---- Phase 1: one process writes all the evidence, then dies. ----
  const log = { n: 0, prompts: [] };
  const first = await open(dir, native(log));
  first.store.session('worker');
  first.store.session('late');
  // A 302-message thread whose late joiner's membership evidence is deep history.
  const root0 = await first.send({ to: ['worker'], text: 'thread root', type: 'proposal' }, hostOf('orchestrator', 't0'));
  for (let i = 0; i < 300; i++) await first.send({ to: ['worker'], text: `filler ${i}`, in_reply_to: root0.message_id }, hostOf('orchestrator', `f${i}`));
  await first.send({ to: ['late'], text: 'late joiner membership evidence', in_reply_to: root0.message_id }, hostOf('orchestrator', 'lj'));
  // A plan attempt whose worker result was already recorded before the crash.
  log.submit = async sessionID => { await first.stepResult({ status: 'success', summary: 'done' }, { sessionID }); };
  const plan = await first.plan({ steps: [{ id: 'solo', text: 'worker work' }] }, hostOf('orchestrator', 'p1'));
  assert.equal(plan.steps[0].outcome, 'worker_reported_success');
  const sid = plan.steps[0].sessionID;
  // The newest message: delivered normally, then a newer delivery attempt
  // whose result record never landed - the crash window under test.
  const sent = await first.send({ to: ['worker'], text: 'delivered normally first' }, hostOf('orchestrator', 'm0'));
  await first.store.record('trace.delivery', { sessionID: 'orchestrator' }, {
    message_id: sent.message_id, thread_id: sent.thread_id, recipient: 'worker', attempt_id: 'attempt-crash-00000000',
    phase: 'attempt', state: 'attempted', method: 'prompt:queue', inbox_id: null,
  }, { message_id: sent.message_id, thread_id: sent.thread_id, recipient: 'worker' });
  const eventsBefore = first.store.index.size;
  await first.store.close();

  // ---- Phase 2: a fresh process rebuilds index and projections from events. ----
  const second = await open(dir, { prompt: async () => { throw new Error('no delivery in phase 2'); } });
  t.after(() => second.store.close());
  await second.ready;
  assert.equal(second.store.index.size, eventsBefore, 'index rebuilt to the same size from authoritative events');
  assert.ok(second.store.sessions.has('orchestrator'), 'session projections are rebuilt from event hosts');

  // 1. The delivery crash window survives: the newest attempt (result-less)
  //    decides, the older host_admitted result must not mask it, and no
  //    automatic redelivery happens after restart.
  const outcome = await second.deliveryOutcome(sent.message_id, 'worker');
  assert.equal(outcome.state, 'unknown_crash_window', 'crash window survives restart, unmasked by the older attempt');
  let prompts = 0;
  const sweeper = await open(dir, { prompt: async () => { prompts++; return { data: { id: `s${prompts}` } }; } });
  t.after(() => sweeper.store.close());
  const swept = await sweeper.inbox({ sweep: true }, hostOf('orchestrator'));
  assert.deepEqual(swept.swept.delivered, [], 'restart never triggers auto-redelivery of a crash window');
  assert.ok(swept.swept.requires_manual_choice.some(m => m.message_id === sent.message_id));

  // 2. The worker result binding survives: identical replay dedupes to the
  //    pre-crash event, a conflicting claim is still rejected.
  const replay = await second.stepResult({ status: 'success', summary: 'done' }, { sessionID: sid });
  assert.equal(replay.deduplicated, true, 'binding resolution works from the rebuilt index');
  await assert.rejects(second.stepResult({ status: 'failure' }, { sessionID: sid }), /Conflicting worker result/);

  // 3. Thread membership survives: the late joiner stays legitimate 302
  //    messages deep, and an outsider is still refused.
  second.store.session('outsider');
  const late = await open(dir, {});
  t.after(() => late.store.close());
  const reply = await late.send({ to: ['orchestrator'], text: 'late joiner replies after restart', in_reply_to: root0.message_id }, hostOf('late'));
  assert.equal(reply.thread_id, root0.thread_id, 'late-joiner membership derived from full history after restart');
  const outsider = await open(dir, {});
  t.after(() => outsider.store.close());
  await assert.rejects(outsider.send({ to: ['orchestrator'], text: 'intrusion after restart', in_reply_to: root0.message_id }, hostOf('outsider')), /not a participant/);
});
