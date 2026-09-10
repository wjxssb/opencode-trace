import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Trace } from '../src/trace.js';
import { unwrap } from '../src/util.js';

const root = async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-trace-mail-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, storeRoot: path.join(dir, 'store') };
};
const traceWith = (storeRoot, session) => {
  const ctx = { location: { directory: '/shared-workspace' }, ...(session ? { session } : {}) };
  const trace = new Trace(ctx, { storeRoot });
  return trace.ready.then(() => trace);
};
const hostOf = (sessionID, id = 'c1') => ({ sessionID, messageID: 'm1', id, agent: 'build' });

test('P3: proposal -> objection thread carries per-level evidence; sender identity is host-derived', async t => {
  const { storeRoot } = await root(t);
  const prompts = [];
  const s2prompts = [];
  const s1 = await traceWith(storeRoot, { prompt: async input => { prompts.push(input); return { data: { id: `inbox_${prompts.length}` } }; } });
  const s2 = await traceWith(storeRoot, { prompt: async input => { s2prompts.push(input); return { data: { id: `s2inbox_${s2prompts.length}` } }; } });
  s1.store.session('s2'); // recipient observed in this workspace
  // A forged from field in input is ignored: sender is the host session.
  const proposal = await s1.send({ to: ['s2'], text: 'I propose plan A for the parser fix', type: 'proposal', from: 'spoofed' }, hostOf('s1', 'p1'));
  assert.equal(proposal.message_id.startsWith('msgx_'), true);
  assert.equal(proposal.thread_id.startsWith('thr_'), true);
  assert.deepEqual(prompts.map(p => p.sessionID), ['s2']);
  assert.equal(prompts[0].delivery, 'queue');
  assert.match(prompts[0].text, /message_id=msgx_[a-f0-9]{32} thread_id=thr_[a-f0-9]{32} from=s1 type=proposal/);
  assert.ok(prompts[0].text.includes('I propose plan A'));

  // s2's context hook persists the admitted envelope: context_observed gains real evidence.
  const admitted = prompts[0].text;
  await s2.context({ sessionID: 's2', agent: 'build', messages: [{ id: 'msg_adm1', type: 'user', role: 'user', text: admitted, time: { created: 1 } }], system: [] });
  let inbox2 = await s2.inbox({}, hostOf('s2'));
  assert.equal(inbox2.inbox.length, 1);
  let levels = inbox2.inbox[0].levels;
  assert.ok(levels.persisted.startsWith('evt_'));
  assert.ok(levels.host_admitted.startsWith('evt_'), 'host_admitted backed by the delivery receipt');
  assert.ok(levels.context_observed.startsWith('evt_'), 'context_observed backed by the target session own persisted event');
  assert.equal(levels.recipient_ack, false);
  assert.equal(levels.reply_recorded, false);

  const ack = await s2.ack({ message_id: proposal.message_id }, hostOf('s2'));
  assert.ok(ack.ack_ref.startsWith('evt_'));
  assert.match(ack.note, /never means agreement/);

  const objection = await s2.send({ to: ['s1'], text: 'Objection: plan A misses the regression test', type: 'objection', in_reply_to: proposal.message_id, source_refs: [] }, hostOf('s2', 'o1'));
  assert.equal(objection.thread_id, proposal.thread_id, 'reply inherits the thread');

  const outbox1 = await s1.inbox({}, hostOf('s1'));
  const sent = outbox1.outbox.find(m => m.message_id === proposal.message_id);
  assert.equal(sent.reply_recorded, true, 'sender sees the recorded reply');
  assert.deepEqual(sent.acked_by, ['s2']);
  assert.equal(sent.deliveries[0].state, 'host_admitted');
  assert.equal(sent.deliveries[0].host_inbox_id, 'inbox_1');
  const inbox1 = await s1.inbox({}, hostOf('s1'));
  assert.equal(inbox1.inbox.length, 1, 'the objection reached s1');
  assert.equal(inbox1.inbox[0].levels.host_admitted.startsWith('evt_'), true);
});

test('P3: structured accept/reject/counter must bind a real proposal; unknown refs are rejected', async t => {
  const { storeRoot } = await root(t);
  const s1 = await traceWith(storeRoot, { prompt: async () => ({ data: { id: 'i1' } }) });
  s1.store.session('s2');
  const proposal = await s1.send({ to: ['s2'], text: 'proposal text', type: 'proposal' }, hostOf('s1'));
  await assert.rejects(s1.send({ to: ['s2'], text: 'accept!', type: 'accept' }, hostOf('s1')), /requires an explicit proposal reference/);
  await assert.rejects(s1.send({ to: ['s2'], text: 'accept!', type: 'accept', proposal: 'msgx_ffffffffffffffffffffffffffffffff' }, hostOf('s1')), /does not resolve/);
  const note = await s1.send({ to: ['s2'], text: 'plain note', type: 'note' }, hostOf('s1', 'c2'));
  await assert.rejects(s1.send({ to: ['s2'], text: 'accepting', type: 'accept', proposal: note.message_id }, hostOf('s1', 'c3')), /must bind a proposal or counter/);
  const accepted = await s1.send({ to: ['s2'], text: 'accepting plan A', type: 'accept', proposal: proposal.message_id }, hostOf('s1', 'c4'));
  assert.equal(accepted.thread_id, proposal.thread_id);
  const thread = await s1.inbox({ thread_id: proposal.thread_id }, hostOf('s1'));
  assert.equal(thread.outbox.length, 2, 'thread query returns exactly the thread messages');
  await assert.rejects(s1.send({ to: ['s2'], text: 'x', thread_id: 'thr_ffffffffffffffffffffffffffffffff' }, hostOf('s1', 'c5')), /Unknown thread_id/);
  await assert.rejects(s1.send({ to: ['s2'], text: 'x', in_reply_to: 'msgx_ffffffffffffffffffffffffffffffff' }, hostOf('s1', 'c6')), /does not resolve/);
});

test('P3: unobserved recipients, self-addressing and oversize text are rejected without persisting', async t => {
  const { storeRoot } = await root(t);
  const s1 = await traceWith(storeRoot, { prompt: async () => { throw Object.assign(new Error('host gone'), { code: 'ECONNREFUSED' }); } });
  const before = s1.store.index.size;
  await assert.rejects(s1.send({ to: ['ghost'], text: 'x' }, hostOf('s1')), /Unknown or unobserved recipient/);
  await assert.rejects(s1.send({ to: ['s1'], text: 'x' }, hostOf('s1')), /Refusing to address the sender/);
  await assert.rejects(s1.send({ to: ['s2'], text: 'x'.repeat(20000) }, hostOf('s1')), /Invalid message text or size/);
  await assert.rejects(s1.send({ to: ['s2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10'], text: 'x' }, hostOf('s1')), /1 and 8 recipients/);
  assert.equal(s1.store.index.size, before, 'nothing persisted for rejected sends');
});

test('P3: crash window - persisted without delivery is recovered by sweep; unknown states are never auto-retried', async t => {
  const { storeRoot } = await root(t);
  // Sender without a host prompt client: persist succeeds, delivery cannot run.
  const broken = await traceWith(storeRoot, {});
  broken.store.session('s2');
  const sent = await broken.send({ to: ['s2'], text: 'survives the crash' }, hostOf('s1'));
  assert.deepEqual(sent.receipts.map(r => r.state), ['unknown'], 'missing client is an uncertain receipt, not success');
  let outbox = await broken.inbox({ sweep: true }, hostOf('s1'));
  assert.equal(outbox.outbox[0].deliveries[0].state, 'missing_delivery_record');

  // A later process with a working client sweeps: exactly one delivery happens.
  let calls = 0;
  const recovered = await traceWith(storeRoot, { prompt: async input => { calls++; return { data: { id: `i${calls}` } }; } });
  outbox = await recovered.inbox({ sweep: true }, hostOf('s1'));
  assert.deepEqual(outbox.swept.delivered.map(d => d.state), ['host_admitted']);
  assert.equal(calls, 1);
  // Sweeping again is a no-op: the delivery record dedupes the retry.
  outbox = await recovered.inbox({ sweep: true }, hostOf('s1'));
  assert.deepEqual(outbox.swept.delivered, []);
  assert.equal(calls, 1);

  // A recorded uncertain admission (host may or may not have accepted) is
  // reported for manual choice on any later sweep, never auto-retried.
  const flaky = await traceWith(storeRoot, { prompt: async () => { throw Object.assign(new Error('link down'), { code: 'ECONNRESET' }); } });
  flaky.store.session('s2');
  const uncertain = await flaky.send({ to: ['s2'], text: 'sent during a network failure' }, hostOf('s1', 'u1'));
  assert.deepEqual(uncertain.receipts.map(r => r.state), ['unknown']);
  outbox = await recovered.inbox({ sweep: true }, hostOf('s1'));
  assert.deepEqual(outbox.swept.delivered, []);
  assert.deepEqual(outbox.swept.requires_manual_choice.map(m => m.message_id), [uncertain.message_id]);
  assert.match(outbox.swept.requires_manual_choice[0].reason, /manual retry required/);
  assert.equal(calls, 1, 'uncertain host admissions are never auto-retried');
});

test('P3: failed host admission is terminal and visible; delivery refusal leaves native tools intact', async t => {
  const { storeRoot } = await root(t);
  const rejector = await traceWith(storeRoot, { prompt: async () => { throw Object.assign(new Error('session busy'), { code: 'SESSION_BUSY' }); } });
  rejector.store.session('s2');
  const sent = await rejector.send({ to: ['s2'], text: 'will fail' }, hostOf('s1'));
  assert.deepEqual(sent.receipts.map(r => r.state), ['failed']);
  const outbox = await rejector.inbox({}, hostOf('s1'));
  assert.equal(outbox.outbox[0].deliveries[0].state, 'failed');
});
