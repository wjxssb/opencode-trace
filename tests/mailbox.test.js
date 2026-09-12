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
  assert.deepEqual(prompts[0].metadata.opencode_trace_mailbox, {
    origin: 'peer-agent', sender: 's1', message_id: proposal.message_id, thread_id: proposal.thread_id,
  });
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

test('P3: structured accept/reject/counter must bind a real proposal; only addressees may decide', async t => {
  const { storeRoot } = await root(t);
  const s1 = await traceWith(storeRoot, { prompt: async () => ({ data: { id: 'i1' } }) });
  s1.store.session('s2');
  s1.store.session('s3');
  const proposal = await s1.send({ to: ['s2'], text: 'proposal text', type: 'proposal' }, hostOf('s1'));
  await assert.rejects(s1.send({ to: ['s2'], text: 'accept!', type: 'accept' }, hostOf('s1')), /requires an explicit proposal reference/);
  await assert.rejects(s1.send({ to: ['s2'], text: 'accept!', type: 'accept', proposal: 'msgx_ffffffffffffffffffffffffffffffff' }, hostOf('s1')), /does not resolve/);
  const note = await s1.send({ to: ['s2'], text: 'plain note', type: 'note' }, hostOf('s1', 'c2'));
  await assert.rejects(s1.send({ to: ['s2'], text: 'accepting', type: 'accept', proposal: note.message_id }, hostOf('s1', 'c3')), /must bind a proposal or counter/);
  // The proposer may not accept its own proposal.
  await assert.rejects(s1.send({ to: ['s2'], text: 'self-accept', type: 'accept', proposal: proposal.message_id }, hostOf('s1', 'c3b')), /Only an addressee/);
  // A third session outside the proposal's addressees may not decide either.
  const s3 = await traceWith(storeRoot, { prompt: async () => ({ data: { id: 'i3' } }) });
  await assert.rejects(s3.send({ to: ['s1'], text: 'outsider accept', type: 'accept', proposal: proposal.message_id }, hostOf('s3')), /Only an addressee/);
  // Only the addressee's accept is valid and it lands in the proposal thread.
  const s2 = await traceWith(storeRoot, { prompt: async () => ({ data: { id: 'i2' } }) });
  const accepted = await s2.send({ to: ['s1'], text: 'accepting plan A', type: 'accept', proposal: proposal.message_id }, hostOf('s2'));
  assert.equal(accepted.thread_id, proposal.thread_id);
  const thread = await s1.inbox({ thread_id: proposal.thread_id }, hostOf('s1'));
  assert.equal(thread.outbox.length + thread.inbox.length, 2, 'thread query returns exactly the thread messages');
  // Cross-thread proposal bindings are rejected.
  const other = await s1.send({ to: ['s2'], text: 'unrelated thread', type: 'proposal' }, hostOf('s1', 'c2b'));
  await assert.rejects(s2.send({ to: ['s1'], text: 'accept wrong thread', type: 'accept', proposal: other.message_id, thread_id: proposal.thread_id }, hostOf('s2')), /different thread/);
  await assert.rejects(s1.send({ to: ['s2'], text: 'x', thread_id: 'thr_ffffffffffffffffffffffffffffffff' }, hostOf('s1', 'c5')), /Unknown thread_id/);
  await assert.rejects(s1.send({ to: ['s2'], text: 'x', in_reply_to: 'msgx_ffffffffffffffffffffffffffffffff' }, hostOf('s1', 'c6')), /does not resolve/);
});

test('P3: non-participants cannot join an existing thread', async t => {
  const { storeRoot } = await root(t);
  const s1 = await traceWith(storeRoot, { prompt: async () => ({ data: { id: 'i1' } }) });
  const s2 = await traceWith(storeRoot, { prompt: async () => ({ data: { id: 'i2' } }) });
  s1.store.session('s2'); s1.store.session('outsider');
  const proposal = await s1.send({ to: ['s2'], text: 'private thread proposal', type: 'proposal' }, hostOf('s1'));
  const outsider = await traceWith(storeRoot, { prompt: async () => ({ data: { id: 'i9' } }) });
  await assert.rejects(outsider.send({ to: ['s1'], text: 'intrusion', thread_id: proposal.thread_id }, hostOf('outsider')), /not a participant/);
  // Participants stay able to reply.
  const reply = await s2.send({ to: ['s1'], text: 'legit reply', in_reply_to: proposal.message_id }, hostOf('s2'));
  assert.equal(reply.thread_id, proposal.thread_id);
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
  assert.equal(outbox.outbox[0].deliveries[0].state, 'missing_delivery_record', 'a retracted attempt never reached the host');

  // A later process with a working client sweeps: exactly one delivery happens.
  let calls = 0;
  const recovered = await traceWith(storeRoot, { prompt: async input => { calls++; return { data: { id: `i${calls}` } }; } });
  outbox = await recovered.inbox({ sweep: true }, hostOf('s1'));
  assert.deepEqual(outbox.swept.delivered.map(d => d.state), ['host_admitted']);
  assert.equal(calls, 1);
  // Sweeping again is a no-op: the delivery result dedupes the retry.
  outbox = await recovered.inbox({ sweep: true }, hostOf('s1'));
  assert.deepEqual(outbox.swept.delivered, []);
  assert.equal(calls, 1);

  // The real crash window: the host call succeeded but the result record was
  // never written. Recovery must reconcile from evidence or stay UNKNOWN -
  // never auto-redeliver a possibly-admitted message.
  const accepted = await recovered.store.record('trace.message', { sessionID: 's1' }, {
    message_id: 'msgx_crashwindow0000000000000000000000ff', thread_id: 'thr_crashwindow0000000000000000000000ff',
    from: 's1', recipients: ['s2'], type: 'note', in_reply_to: null, proposal: null,
    content_ref: (await recovered.store.blob('window content', 'utf8')).ref, bytes: 13, source_refs: [],
  }, { message_id: 'msgx_crashwindow0000000000000000000000ff', thread_id: 'thr_crashwindow0000000000000000000000ff', recipients: ['s2'] });
  await recovered.store.record('trace.delivery', { sessionID: 's1' }, {
    message_id: 'msgx_crashwindow0000000000000000000000ff', thread_id: 'thr_crashwindow0000000000000000000000ff',
    recipient: 's2', phase: 'attempt', state: 'attempted', method: 'prompt:queue',
  }, { message_id: 'msgx_crashwindow0000000000000000000000ff', thread_id: 'thr_crashwindow0000000000000000000000ff', recipient: 's2' });
  outbox = await recovered.inbox({ sweep: true }, hostOf('s1'));
  assert.equal(calls, 1, 'crash-window attempts are never auto-redelivered');
  assert.ok(outbox.swept.requires_manual_choice.some(m => m.message_id === 'msgx_crashwindow0000000000000000000000ff'));
  // Once the recipient's own transcript proves admission, reconciliation
  // records the evidence-backed result instead of a manual retry.
  const s2view = await traceWith(storeRoot, {});
  await s2view.context({ sessionID: 's2', agent: 'build', messages: [{ id: 'msg_cw1', type: 'user', role: 'user',
    text: '[opencode-trace mailbox] message_id=msgx_crashwindow0000000000000000000000ff thread_id=thr_crashwindow0000000000000000000000ff from=s1 type=note\nwindow content',
    time: { created: 1 } }], system: [] });
  outbox = await recovered.inbox({ sweep: true }, hostOf('s1'));
  assert.deepEqual(outbox.swept.requires_manual_choice.filter(m => m.message_id === 'msgx_crashwindow0000000000000000000000ff'), [], 'reconciled from transcript evidence');
  const reconciled = await recovered.inbox({}, hostOf('s1'));
  const cw = reconciled.outbox.find(m => m.message_id === 'msgx_crashwindow0000000000000000000000ff');
  assert.equal(cw.deliveries[0].state, 'host_admitted');
  assert.equal(cw.deliveries[0].reconciled, true);
  assert.equal(calls, 1, 'reconciliation never re-prompts the host');

  // A recorded uncertain admission (host may or may not have accepted) is
  // reported for manual choice on any later sweep, never auto-retried.
  const flaky = await traceWith(storeRoot, { prompt: async () => { throw Object.assign(new Error('link down'), { code: 'ECONNRESET' }); } });
  flaky.store.session('s2');
  const uncertain = await flaky.send({ to: ['s2'], text: 'sent during a network failure' }, hostOf('s1', 'u1'));
  assert.deepEqual(uncertain.receipts.map(r => r.state), ['unknown']);
  outbox = await recovered.inbox({ sweep: true }, hostOf('s1'));
  assert.deepEqual(outbox.swept.delivered, []);
  assert.deepEqual(outbox.swept.requires_manual_choice.map(m => m.message_id), [uncertain.message_id]);
  assert.match(outbox.swept.requires_manual_choice[0].reason, /never auto-redelivered/);
  assert.equal(calls, 1, 'uncertain host admissions are never auto-retried');
});

test('P3: long-running mailbox - the newest messages stay visible and sweepable', async t => {
  const { storeRoot } = await root(t);
  const sender = await traceWith(storeRoot, {});
  sender.store.session('s2');
  const sent = [];
  for (let i = 0; i < 300; i++) sent.push((await sender.send({ to: ['s2'], text: `mailbox message ${i}` }, hostOf('s1', `m${i}`))).message_id);
  // The newest message must appear even though history is far beyond 256.
  const inbox2 = await (async () => {
    const viewer = await traceWith(storeRoot, {});
    return viewer.inbox({}, hostOf('s2'));
  })();
  const ids = inbox2.inbox.map(m => m.message_id);
  assert.ok(ids.includes(sent.at(-1)), 'newest message visible');
  assert.ok(ids.includes(sent[299 - 40]), 'recent window visible');
  assert.ok(!ids.includes(sent[2]), 'ancient messages are outside the newest window, not blocking it');
  // Sweep only ever inspects the newest 64 sent messages: the oldest
  // undelivered mail must not starve the recent one out of the window.
  let calls = 0;
  const healer = await traceWith(storeRoot, { prompt: async input => { calls++; return { data: { id: `h${calls}` } }; } });
  const swept = await healer.inbox({ sweep: true }, hostOf('s1'));
  assert.equal(calls, 64, 'bounded sweep window');
  assert.equal(swept.swept.delivered.length, 64);
  assert.ok(swept.swept.delivered.some(d => d.message_id === sent.at(-1)), 'newest undelivered mail is swept');
  assert.ok(swept.swept.delivered.every(d => sent.indexOf(d.message_id) >= 300 - 64), 'only the newest window was swept');
}, { timeout: 180000 });

test('P5.2: attempt_id pairing - an older retracted attempt cannot mask a newer crash window', async t => {
  const { storeRoot } = await root(t);
  const sender = await traceWith(storeRoot, {});
  sender.store.session('s2');
  const sent = await sender.send({ to: ['s2'], text: 'wal pairing probe' }, hostOf('s1'));
  // Attempt #1: no host client -> retracted as not_attempted.
  const outbox = await sender.inbox({ sweep: true }, hostOf('s1'));
  assert.equal(outbox.outbox[0].deliveries[0].state, 'missing_delivery_record');
  // Attempt #2: the host call succeeds and the process crashes before the
  // result record is written. Only the attempt lands.
  const healer = await traceWith(storeRoot, { prompt: async () => ({ data: { id: 'i1' } }) });
  await healer.store.record('trace.delivery', { sessionID: 's1' }, {
    message_id: sent.message_id, thread_id: sent.thread_id, recipient: 's2', attempt_id: 'attempt-second-00000000',
    phase: 'attempt', state: 'attempted', method: 'prompt:queue', inbox_id: null,
  }, { message_id: sent.message_id, thread_id: sent.thread_id, recipient: 's2' });
  const outcome = await healer.deliveryOutcome(sent.message_id, 's2');
  assert.equal(outcome.state, 'unknown_crash_window', 'the newest attempt is authoritative, not the older retraction');
  const swept = await healer.inbox({ sweep: true }, hostOf('s1'));
  assert.deepEqual(swept.swept.delivered, [], 'crash window is never auto-redelivered');
  assert.equal(swept.swept.requires_manual_choice.length, 1);
});

test('P5.2: viewer-scoped inbox - other sessions traffic cannot push own mail out of view', async t => {
  const { storeRoot } = await root(t);
  const a = await traceWith(storeRoot, {});
  a.store.session('b'); a.store.session('noise1');
  const first = await a.send({ to: ['b'], text: 'the one unread message that matters' }, hostOf('s1'));
  // 120 unrelated messages between other sessions, all newer.
  const noise = await traceWith(storeRoot, {});
  noise.store.session('noise1');
  noise.store.session('noise2');
  for (let i = 0; i < 120; i++) await noise.send({ to: ['noise1'], text: `noise ${i}` }, hostOf('s2', `n${i}`));
  const b = await traceWith(storeRoot, {});
  const inbox = await b.inbox({}, hostOf('b'));
  const ids = inbox.inbox.map(m => m.message_id);
  assert.ok(ids.includes(first.message_id), 'the only mail for b is visible despite newer unrelated traffic');
  assert.equal(ids.length, 1);
});

test('P5.3: sweep drains an old backlog across repeated sweeps - the budget counts actionable mail, not raw history', async t => {
  const { storeRoot } = await root(t);
  const sender = await traceWith(storeRoot, {});
  sender.store.session('s2');
  const sent = [];
  for (let i = 0; i < 150; i++) sent.push((await sender.send({ to: ['s2'], text: `backlog ${i}` }, hostOf('s1', `b${i}`))).message_id);
  let calls = 0;
  const healer = await traceWith(storeRoot, { prompt: async input => { calls++; return { data: { id: `h${calls}` } }; } });
  let swept = await healer.inbox({ sweep: true }, hostOf('s1'));
  assert.equal(swept.swept.delivered.length, 64, 'one sweep is bounded to 64 actionable deliveries');
  assert.equal(swept.swept.actionable_budget, 64);
  // Delivered mail stops consuming the budget, so the next sweep reaches the
  // older half instead of staring at the same newest 64 forever.
  swept = await healer.inbox({ sweep: true }, hostOf('s1'));
  assert.equal(swept.swept.delivered.length, 64);
  swept = await healer.inbox({ sweep: true }, hostOf('s1'));
  assert.equal(swept.swept.delivered.length, 22, 'the remaining backlog is swept');
  assert.equal(calls, 150, 'every undelivered message was delivered exactly once across sweeps');
  const final = await healer.inbox({ sweep: true }, hostOf('s1'));
  assert.deepEqual(final.swept.delivered, []);
  assert.equal(final.swept.actionable_budget, 0, 'a drained backlog consumes no budget');
  const states = new Set((await healer.inbox({}, hostOf('s1'))).outbox.flatMap(m => m.deliveries.map(d => d.state)));
  assert.deepEqual([...states], ['host_admitted']);
  // The oldest message was reached and delivered: no starvation.
  assert.equal((await healer.deliveryOutcome(sent[0], 's2')).state, 'host_admitted', 'the oldest backlog item was delivered');
});

test('P5.3: delivery projection reads full history - old churn cannot hide the newest attempt', async t => {
  const { storeRoot } = await root(t);
  const sender = await traceWith(storeRoot, {});
  sender.store.session('s2');
  const sent = await sender.send({ to: ['s2'], text: 'long wal probe' }, hostOf('s1'));
  const recordAttempt = (attempt_id, state) => sender.store.record('trace.delivery', { sessionID: 's1' }, {
    message_id: sent.message_id, thread_id: sent.thread_id, recipient: 's2', attempt_id, phase: state === 'attempted' ? 'attempt' : 'result',
    ...(state === 'attempted' ? { state: 'attempted', method: 'prompt:queue', inbox_id: null } : { state, method: 'synthetic', inbox_id: null }),
  }, { message_id: sent.message_id, thread_id: sent.thread_id, recipient: 's2' });
  // 70 retracted attempts: the oldest-128-event window of the previous
  // implementation already ends inside this churn.
  for (let i = 0; i < 70; i++) { await recordAttempt(`attempt-old-${String(i).padStart(4, '0')}`, 'attempted'); await recordAttempt(`attempt-old-${String(i).padStart(4, '0')}`, 'not_attempted'); }
  // Attempt 71 is admitted and its result lands - beyond the old cutoff.
  const newest = 'attempt-new-0000000001';
  await recordAttempt(newest, 'attempted');
  await recordAttempt(newest, 'host_admitted');
  const admitted = await sender.deliveryOutcome(sent.message_id, 's2');
  assert.equal(admitted.state, 'host_admitted', 'the newest result decides, not the oldest window');
  // And the same history with a result-less newest attempt stays a crash window.
  const sent2 = await sender.send({ to: ['s2'], text: 'long wal probe two' }, hostOf('s1', 'c2'));
  for (let i = 0; i < 70; i++) { await sender.store.record('trace.delivery', { sessionID: 's1' }, {
    message_id: sent2.message_id, thread_id: sent2.thread_id, recipient: 's2', attempt_id: `attempt-x-${String(i).padStart(4, '0')}`,
    phase: 'attempt', state: 'attempted', method: 'prompt:queue', inbox_id: null,
  }, { message_id: sent2.message_id, thread_id: sent2.thread_id, recipient: 's2' });
    await sender.store.record('trace.delivery', { sessionID: 's1' }, {
    message_id: sent2.message_id, thread_id: sent2.thread_id, recipient: 's2', attempt_id: `attempt-x-${String(i).padStart(4, '0')}`,
    phase: 'result', state: 'host_admitted', method: 'synthetic', inbox_id: 'x',
  }, { message_id: sent2.message_id, thread_id: sent2.thread_id, recipient: 's2' }); }
  await sender.store.record('trace.delivery', { sessionID: 's1' }, {
    message_id: sent2.message_id, thread_id: sent2.thread_id, recipient: 's2', attempt_id: 'attempt-crash-0000001',
    phase: 'attempt', state: 'attempted', method: 'prompt:queue', inbox_id: null,
  }, { message_id: sent2.message_id, thread_id: sent2.thread_id, recipient: 's2' });
  const crash = await sender.deliveryOutcome(sent2.message_id, 's2');
  assert.equal(crash.state, 'unknown_crash_window', 'a result-less newest attempt is never masked by 70 completed ones');
});

test('P5.2: late thread joiners keep membership beyond any bounded window; malformed thread ids fail closed', async t => {
  const { storeRoot } = await root(t);
  const a = await traceWith(storeRoot, { prompt: async () => ({ data: { id: 'i1' } }) });
  a.store.session('b'); a.store.session('c');
  const root0 = await a.send({ to: ['b'], text: 'thread start', type: 'proposal' }, hostOf('s1'));
  // 300 thread messages between the root and the late join.
  for (let i = 0; i < 300; i++) await a.send({ to: ['b'], text: `filler ${i}`, in_reply_to: root0.message_id }, hostOf('s1', `f${i}`));
  // c becomes a thread participant only at message 301 (addressed there).
  await a.send({ to: ['c'], text: 'bringing c into the thread', in_reply_to: root0.message_id }, hostOf('s1', 'late'));
  const c = await traceWith(storeRoot, { prompt: async () => ({ data: { id: 'ic' } }) });
  c.store.session('a');
  const reply = await c.send({ to: ['a'], text: 'late joiner replies', in_reply_to: root0.message_id }, hostOf('c'));
  assert.equal(reply.thread_id, root0.thread_id, 'late joiner keeps membership from the full thread history');
  // Malformed thread ids fail closed instead of silently opening a new thread.
  await assert.rejects(a.send({ to: ['b'], text: 'typo thread', thread_id: 'thr_typo' }, hostOf('s1', 't1')), /Invalid thread_id/);
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
