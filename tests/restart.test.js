import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Trace } from '../src/trace.js';

const hostOf = (sessionID, id = 'c1') => ({ sessionID, messageID: 'm1', id, agent: 'build' });
const open = (dir, session = {}) => {
  const trace = new Trace({ location: { directory: dir }, ...(session ? { session } : {}) }, { storeRoot: path.join(dir, 'store') });
  return trace.ready.then(() => trace);
};
const native = log => ({
  get: async ({ sessionID }) => ({ data: log.bindings?.get(sessionID) ?? { id: sessionID, agent: 'build', model: { providerID: 'fixture-cloud', id: 'worker' } } }),
  create: async ({ agent, model }) => { const value = { id: `ses_w_${++log.n}`, agent, model }; (log.bindings ??= new Map()).set(value.id, value); return { data: value }; },
  prompt: async ({ sessionID }) => { log.prompts.push(sessionID); if (log.submit) await log.submit(sessionID); return { data: { id: 'in' } }; },
  wait: async () => {},
  context: async () => ({ data: [{ id: 'a1', type: 'assistant', role: 'assistant', text: 'worker output', time: { created: 1, completed: 2 }, finish: 'stop' }] }),
});

// Phase 2 runs in a real OS child process: kill-free but a genuine Node
// process boundary - the child rebuilds every projection from disk alone.
const CHILD = `
import { Trace } from ${JSON.stringify(pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/trace.js')).href)};
const [ , , dir, sid, messageId, rootMessageId ] = process.argv;
const report = {};
const trace = new Trace({ location: { directory: dir } }, { storeRoot: path.join(dir, 'store') });
await trace.ready;
report.indexRebuilt = trace.store.index.size;
report.sessionsRebuilt = trace.store.sessions.has('orchestrator');
report.crashWindow = (await trace.deliveryOutcome(messageId, 'worker')).state;
const replay = await trace.stepResult({ status: 'success', summary: 'done' }, { sessionID: sid });
report.replayDeduplicated = replay.deduplicated === true;
// The crashed (never-settled) attempt is still on-time: its claims conflict.
await trace.stepResult({ status: 'success', summary: 'from the crashed turn' }, { sessionID: 'ses_crashed' });
report.conflictRejected = await trace.stepResult({ status: 'failure' }, { sessionID: 'ses_crashed' }).then(() => false, e => /Conflicting worker result/.test(e.message));
const late = await trace.stepResult({ status: 'failure', summary: 'reconsidered after the crash' }, { sessionID: sid });
report.lateClaimStored = late.late === true && late.terminal_state === 'settled';
const lateTrace = await open2('late');
const reply = await lateTrace.send({ to: ['orchestrator'], text: 'late joiner replies after a real process restart', in_reply_to: rootMessageId }, { sessionID: 'late', messageID: 'm9', id: 'c9', agent: 'build' });
report.lateReplyThread = reply.thread_id;
trace.store.close(); lateTrace.store.close();
console.log('RESTART_REPORT ' + JSON.stringify(report));
async function open2(sessionHost) {
  const t = new Trace({ location: { directory: dir }, session: { prompt: async () => ({ data: { id: 'late-in' } }) } }, { storeRoot: path.join(dir, 'store') });
  await t.ready;
  return t;
}
`;

test('P5.3: a real child-process restart rebuilds projections - crash window, worker claims and thread membership survive', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-trace-restart-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  // ---- Phase 1: the parent process writes all evidence, then closes. ----
  const log = { n: 0, prompts: [] };
  const first = await open(dir, native(log));
  first.store.session('worker');
  first.store.session('late');
  const root0 = await first.send({ to: ['worker'], text: 'thread root', type: 'proposal' }, hostOf('orchestrator', 't0'));
  for (let i = 0; i < 300; i++) await first.send({ to: ['worker'], text: `filler ${i}`, in_reply_to: root0.message_id }, hostOf('orchestrator', `f${i}`));
  await first.send({ to: ['late'], text: 'late joiner membership evidence', in_reply_to: root0.message_id }, hostOf('orchestrator', 'lj'));
  log.submit = async sessionID => { await first.stepResult({ status: 'success', summary: 'done' }, { sessionID }); };
  const plan = await first.plan({ steps: [{ id: 'solo', text: 'worker work' }] }, hostOf('orchestrator', 'p1'));
  assert.equal(plan.steps[0].outcome, 'worker_reported_success');
  const sid = plan.steps[0].sessionID;
  const sent = await first.send({ to: ['worker'], text: 'delivered normally first' }, hostOf('orchestrator', 'm0'));
  await first.store.record('trace.delivery', { sessionID: 'orchestrator' }, {
    message_id: sent.message_id, thread_id: sent.thread_id, recipient: 'worker', attempt_id: 'attempt-crash-00000000',
    phase: 'attempt', state: 'attempted', method: 'prompt:queue', inbox_id: null,
  }, { message_id: sent.message_id, thread_id: sent.thread_id, recipient: 'worker' });
  // A started-but-never-settled attempt simulating a crashed worker turn:
  // its claims are still on-time, so conflicting ones must be rejected.
  await first.store.record('trace.step', hostOf('orchestrator', 'cr'), {
    plan_id: plan.plan_id, version: (JSON.parse((await first.store.readBlob(first.store.findEntries({ type: 'trace.step', plan: plan.plan_id }, null, 1)[0].payloadRef)).toString())).version,
    step: 'solo', state: 'started', sessionID: 'ses_crashed', attempt_id: 'attempt-crashed-000001', native: 'synthetic crashed turn',
  }, { plan_id: plan.plan_id, step: 'solo', worker: 'ses_crashed' });
  const eventsBefore = first.store.index.size;
  await first.store.close();

  // ---- Phase 2: a separate OS process rebuilds from disk alone. ----
  const childScript = path.join(dir, 'restart-child.mjs');
  await fs.writeFile(childScript, `import { pathToFileURL, fileURLToPath } from 'node:url'; import path from 'node:path';\n${CHILD}`);
  const childOut = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childScript, dir, sid, sent.message_id, root0.message_id], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => code === 0 ? resolve(out) : reject(new Error(`child exit ${code}: ${err.slice(0, 400)}`)));
  });
  const report = JSON.parse(childOut.match(/RESTART_REPORT (.+)/)[1]);
  assert.ok(report.indexRebuilt > 0 && report.indexRebuilt <= eventsBefore, `child rebuilt the index from disk (${report.indexRebuilt} events)`);
  assert.equal(report.sessionsRebuilt, true, 'session projections rebuilt from event hosts');
  assert.equal(report.crashWindow, 'unknown_crash_window', 'crash window survives the process boundary, unmasked');
  assert.equal(report.replayDeduplicated, true, 'worker claim dedupe works across processes');
  assert.equal(report.conflictRejected, true, 'conflicting claims stay rejected across processes');
  assert.equal(report.lateClaimStored, true, 'a post-restart late claim is stored as evidence without rewriting the outcome');
  assert.equal(report.lateReplyThread, root0.thread_id, 'late-joiner membership survives the process boundary');

  // ---- Phase 3: the parent reopens and verifies the child's effects. ----
  const second = await open(dir, {});
  t.after(() => second.store.close());
  const replies = second.store.findEntries({ reply_to: root0.message_id, type: 'trace.message', session: 'late' }, null, 4);
  assert.equal(replies.length, 1, 'the child-written reply is authoritative history');
  const lateRows = second.store.findEntriesAll({ type: 'trace.step.result', plan: plan.plan_id })
    .filter(row => { return true; });
  const lateClaims = [];
  for (const row of lateRows) {
    const data = JSON.parse((await second.store.readBlob(row.payloadRef)).toString());
    if (data.late === true) lateClaims.push(data);
  }
  assert.equal(lateClaims.length, 1, 'exactly one late claim event exists');
  assert.equal(lateClaims[0].status, 'failure');
  // The old settled outcome was never rewritten, but the newer crashed
  // attempt prevents presenting that older success as the plan's current state.
  const settled = await second.plan({ steps: [{ id: 'solo', text: 'worker work' }] }, hostOf('orchestrator', 'p2'));
  assert.equal(settled.steps[0].state, 'already_in_flight_unknown');
  assert.equal(settled.steps[0].sessionID, 'ses_crashed');
  const originalTerminal = JSON.parse((await second.store.expand(plan.steps[0].evidence_ref, 0, 24000)).exact_utf8);
  assert.equal(originalTerminal.outcome, 'worker_reported_success');
  assert.equal((await second.deliveryOutcome(sent.message_id, 'worker')).state, 'unknown_crash_window', 'still never auto-redelivered');
});
