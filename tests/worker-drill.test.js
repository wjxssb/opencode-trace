import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Trace } from '../src/trace.js';
import { definitions } from '../src/tools.js';
import { hash } from '../src/util.js';

const host = (sessionID = 'worker', id = 'call') => ({ sessionID, messageID: 'turn', id, agent: 'build' });
async function fixture(t, session = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-worker-drill-'));
  const trace = new Trace({ location: { directory }, session }, { storeRoot: path.join(directory, 'store') });
  await trace.ready;
  t.after(async () => { await trace.store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { trace, directory };
}
async function raw(tool, input, identity = host()) {
  const response = await tool.execute(input, identity);
  assert.equal(response.metadata.raw.ok, true, response.content);
  assert.equal(response.metadata.raw.raw_omitted, undefined, 'fixture result fits direct metadata');
  return response.metadata.raw;
}

test('worker role drill: all twelve tools support evidence, correction, coordination and dependent verification', async t => {
  const prompts = [], traceHolder = {};
  const bindings = new Map();
  const session = {
    get: async ({ sessionID }) => ({ data: bindings.get(sessionID) ?? { id: sessionID, agent: 'build', model: { providerID: 'fixture-cloud', id: 'worker', variant: 'low' } } }),
    create: async ({ agent, model }) => { const value = { id: `child-${prompts.filter(p => p.metadata?.opencode_trace_assignment).length + 1}`, agent, model }; bindings.set(value.id, value); return { data: value }; },
    prompt: async request => {
      prompts.push(request);
      if (request.metadata?.opencode_trace_assignment) {
        const assignment = request.metadata.opencode_trace_assignment;
        // Act as the assigned worker: inspect the immutable plan and every
        // dependency outcome before submitting our own evidence-bound result.
        const plan = await raw(traceHolder.tools.trace_expand, { ref: assignment.plan_ref, limit: 24000 }, host(request.sessionID));
        assert.match(plan.exact_utf8, /parser|regression/);
        for (const dependency of assignment.dependencies) {
          const outcome = await raw(traceHolder.tools.trace_expand, { ref: dependency.evidence_ref, limit: 24000 }, host(request.sessionID));
          const record = JSON.parse(outcome.exact_utf8);
          assert.equal(record.outcome, 'worker_reported_success');
          assert.ok(record.result_ref, 'the dependency contains exact worker-report retrieval');
        }
        await raw(traceHolder.tools.trace_step_result, { status: 'success', summary: `Checked ${assignment.step} against fixture evidence`, source_refs: [traceHolder.evidence] }, host(request.sessionID));
      }
      return { data: { id: `inbox-${prompts.length}` } };
    },
    wait: async () => {},
    context: async () => ({ data: [] }),
  };
  const { trace, directory } = await fixture(t, session);
  const tools = Object.fromEntries(definitions(trace).map(tool => [tool.name, tool]));
  traceHolder.tools = tools;
  trace.store.session('reviewer');
  const original = await trace.after({ ...host(), tool: 'read', input: { filePath: 'parser.js' }, status: 'completed', result: { content: [{ type: 'text', text: 'Parser rejects zero; fixture failing test verifies it.' }] } });
  traceHolder.evidence = original.ref;
  await raw(tools.trace_intent, { summary: 'Fix parser handling of zero; preserve null rejection', paths: ['parser.js'], status: 'active' });
  const mistaken = await raw(tools.trace_note, { kind: 'unresolved', text: 'Zero may already be supported', source_refs: [original.ref] });
  const correction = await raw(tools.trace_note, { kind: 'correction', text: 'Fixture proves zero is rejected; add a regression before changing parser', source_refs: [original.ref], supersedes: [mistaken.ref] });
  const state = await raw(tools.trace_status, {});
  assert.equal(state.unresolved.length, 0);
  assert.ok(state.notes.some(n => n.ref === correction.ref));
  const found = await raw(tools.trace_find, { related: original.ref, type: 'trace.note' });
  assert.deepEqual(new Set(found.results.map(r => r.ref)), new Set([mistaken.ref, correction.ref]));
  const source = await raw(tools.trace_expand, { ref: original.ref, metadata_only: true });
  const exact = await raw(tools.trace_expand, { ref: source.text_blobs[0].ref });
  assert.equal(exact.exact_utf8, 'Parser rejects zero; fixture failing test verifies it.');
  assert.equal(hash(Buffer.from(exact.exact_base64, 'base64')), exact.sha256);
  const sent = await raw(tools.trace_send, { to: ['reviewer'], type: 'evidence', text: 'Review the zero regression; null rejection is a constraint.', source_refs: [correction.ref] });
  const admitted = prompts.find(p => p.sessionID === 'reviewer');
  await trace.observeMessages('reviewer', [{ id: 'reviewer-input', role: 'user', text: admitted.text, metadata: admitted.metadata }]);
  const inbox = await raw(tools.trace_inbox, {}, host('reviewer'));
  assert.equal(inbox.inbox[0].message_id, sent.message_id);
  assert.deepEqual(inbox.inbox[0].source_refs, [correction.ref]);
  assert.ok(inbox.inbox[0].levels.context_observed);
  const ack = await raw(tools.trace_ack, { message_id: sent.message_id }, host('reviewer'));
  assert.equal((await raw(tools.trace_ack, { message_id: sent.message_id }, host('reviewer', 'again'))).ack_ref, ack.ack_ref);
  const plan = await raw(tools.trace_plan, { steps: [
    { id: 'regression', text: 'Inspect parser regression and report evidence' },
    { id: 'verify', text: 'Verify parser constraints against the regression report', depends_on: ['regression'] },
  ] });
  assert.ok(plan.steps.every(step => step.outcome === 'worker_reported_success'));
  await raw(tools.trace_intent, { summary: 'Fixture exercise finished; production correctness still requires real changes and review', paths: ['parser.js'], status: 'done', related_refs: [plan.plan_ref] });
  const intentSnapshot = JSON.parse(await fs.readFile(path.join(trace.store.root, 'intents', `${hash('worker')}.json`), 'utf8'));
  assert.equal(intentSnapshot.sessionID, 'worker');
  assert.equal(intentSnapshot.workspaceID, hash(directory));
  assert.ok(Number.isFinite(intentSnapshot.at));
  assert.deepEqual(new Set(Object.keys(tools)), new Set(['trace_note', 'trace_expand', 'trace_find', 'trace_send', 'trace_inbox', 'trace_ack', 'trace_step_result', 'trace_plan', 'trace_intent', 'trace_claim', 'trace_claim_receipt', 'trace_status']));
});

test('deep-search pages retain every nearby and mixed-case occurrence; corruption is a coverage gap', async t => {
  const { trace } = await fixture(t);
  await assert.rejects(trace.find({ session: 123 }), /Search filters must be strings/);
  await assert.rejects(trace.find({ text: 'x'.repeat(257) }), /at most 256/);
  const event = await trace.after({ ...host(), tool: 'read', input: { filePath: 'log' }, status: 'completed', result: { content: [{ type: 'text', text: 'needle NEEDLE needle NEEDLE needle' }] } });
  const seen = [];
  let cursor;
  for (let page = 0; page < 30; page++) {
    const result = await trace.find({ text: 'NEEDLE', deep: true, limit: 1, cursor });
    assert.ok(result.hits.length <= 1);
    seen.push(...result.hits.filter(hit => hit.blob_ref === event.outputs[0].ref));
    cursor = result.next_cursor;
    if (!cursor) { assert.equal(result.coverage.deep_scan.complete, true); break; }
  }
  assert.equal(cursor, null, 'finite pagination terminates');
  assert.deepEqual(seen.map(hit => hit.byte_offset), [0, 7, 14, 21, 28]);
  const digest = event.outputs[0].ref.slice(5);
  await fs.unlink(path.join(trace.store.root, 'blobs', digest.slice(0, 2), digest));
  const failed = await trace.find({ text: 'ABSENT', deep: true });
  assert.equal(failed.coverage.deep_scan.exhausted_history, true);
  assert.equal(failed.coverage.deep_scan.complete, false);
  assert.ok(failed.coverage.deep_scan.failed_blobs.includes(event.outputs[0].ref));
});

test('mail mention or copied envelope never proves admission; native origin and role must match', async t => {
  const { trace } = await fixture(t);
  trace.store.session('reviewer');
  const sent = await trace.send({ to: ['reviewer'], text: 'Evidence for parser review' }, host());
  const mail = (await trace.resolveMail(sent.message_id)).data;
  await trace.store.record('trace.delivery', host(), { message_id: sent.message_id, thread_id: sent.thread_id, recipient: 'reviewer', attempt_id: 'crash', phase: 'attempt', state: 'attempted' }, { message_id: sent.message_id, thread_id: sent.thread_id, recipient: 'reviewer' });
  const metadata = { opencode_trace_mailbox: { origin: 'peer-agent', sender: 'worker', message_id: sent.message_id, thread_id: sent.thread_id } };
  await trace.observeMessages('reviewer', [
    { id: 'assistant-mention', role: 'assistant', finish: 'stop', text: `I have not received ${sent.message_id}`, metadata },
    { id: 'copied-envelope', role: 'user', text: trace.mailEnvelope(mail, 'Evidence for parser review') },
    { id: 'wrong-origin', role: 'user', text: sent.message_id, metadata: { opencode_trace_mailbox: { ...metadata.opencode_trace_mailbox, sender: 'someone-else' } } },
  ]);
  let inbox = await trace.inbox({}, host('reviewer'));
  assert.equal(inbox.inbox[0].levels.context_observed, null);
  assert.equal(inbox.inbox[0].delivery_state, 'unknown_crash_window');
  await trace.observeMessages('reviewer', [{ id: 'real-origin', role: 'user', text: trace.mailEnvelope(mail, 'Evidence for parser review'), metadata }]);
  inbox = await trace.inbox({}, host('reviewer'));
  assert.ok(inbox.inbox[0].levels.context_observed);
  assert.equal(inbox.inbox[0].delivery_state, 'host_admitted');
});

test('inbox has lossless viewer-bound pages and reports fresh sweep results', async t => {
  const { trace } = await fixture(t);
  trace.store.session('reviewer');
  const sent = [];
  for (let i = 0; i < 100; i++) sent.push((await trace.send({ to: ['reviewer'], text: `Evidence ${i}` }, host('worker', `send-${i}`))).message_id);
  const first = await trace.inbox({ limit: 13 }, host('reviewer'));
  assert.equal(first.coverage.matching_messages, 100);
  assert.equal(first.coverage.remaining_older, 87);
  await assert.rejects(trace.inbox({ cursor: first.next_cursor, limit: 13 }, host('worker')), /does not match/);
  await assert.rejects(trace.inbox({ thread_id: 'typo' }, host('reviewer')), /Invalid thread/);
  let cursor, collected = [];
  do {
    const page = await trace.inbox({ limit: 13, cursor }, host('reviewer'));
    collected.push(...page.inbox.map(item => item.message_id));
    cursor = page.next_cursor;
  } while (cursor);
  assert.deepEqual(new Set(collected), new Set(sent));
  assert.equal(collected.length, 100);
  trace.ctx.session.prompt = async () => ({ data: { id: 'admitted' } });
  const swept = await trace.inbox({ sweep: true }, host('worker'));
  assert.equal(swept.swept.delivered.length, 64);
  for (const delivery of swept.swept.delivered) assert.equal(swept.outbox.find(item => item.message_id === delivery.message_id).deliveries[0].state, 'host_admitted');
});

test('uncertain deliveries do not starve an older never-attempted message', async t => {
  const { trace } = await fixture(t);
  trace.store.session('reviewer');
  const old = await trace.send({ to: ['reviewer'], text: 'Old safely retryable work evidence' }, host());
  trace.ctx.session.prompt = async () => { throw Object.assign(new Error('network uncertain'), { code: 'ETIMEDOUT' }); };
  for (let i = 0; i < 65; i++) await trace.send({ to: ['reviewer'], text: `Uncertain ${i}` }, host('worker', `uncertain-${i}`));
  let calls = 0;
  trace.ctx.session.prompt = async () => { calls++; return { data: { id: 'new' } }; };
  const result = await trace.inbox({ sweep: true }, host());
  assert.equal(calls, 1);
  assert.equal(result.swept.delivered[0].message_id, old.message_id);
  assert.equal(result.swept.requires_manual_choice.length, 64);
  assert.equal(result.swept.manual_choices_omitted, 1);
});

test('status exposes note omissions and exact history lookup; recall excludes peer prose', async t => {
  const { trace } = await fixture(t);
  for (let i = 0; i < 70; i++) await trace.note({ kind: 'unresolved', text: `Open issue ${i}`, source_refs: [] }, host('worker', `note-${i}`));
  await trace.intent({ summary: 'Peer checks docs', paths: ['README.md'], status: 'active' }, host('reviewer'));
  const status = await raw(definitions(trace).find(tool => tool.name === 'trace_status'), {});
  assert.deepEqual([status.coverage.notes_historical, status.coverage.notes_retained, status.coverage.unresolved_shown], [70, 64, 8]);
  assert.equal(status.coverage.notes_complete, false);
  assert.deepEqual(status.coverage.retrieve, { tool: 'trace_find', arguments: { type: 'trace.note', session: 'worker' } });
  assert.equal(status.peers[0].intent.summary, 'Peer checks docs');
  assert.ok(!trace.recall('worker').includes('Peer checks docs'));
});

test('watcher exhaustion preserves durable storage and explicit reconcile-only recovery', async t => {
  const { trace, directory } = await fixture(t);
  const warnings = [];
  const reader = await new Store(directory, path.join(directory, 'store'), (where, error) => warnings.push([where, error.code]), {
    watch() { throw Object.assign(new Error('inotify exhausted'), { code: 'ENOSPC' }); },
  }).init();
  t.after(() => reader.close());
  assert.deepEqual(reader.watcherState, { mode: 'reconcile_only', error: 'ENOSPC' });
  const saved = await trace.note({ kind: 'finding', text: 'Durable even with no watcher', source_refs: [] }, host());
  const catchUp = await reader.reconcile();
  assert.equal(catchUp.scan_complete, true);
  assert.ok(reader.index.has(saved.ref));
  assert.equal(JSON.parse((await reader.expand(saved.ref)).exact_utf8).text, 'Durable even with no watcher');
  assert.deepEqual(warnings, [['watch_unavailable', 'ENOSPC']]);
  const written = await reader.record('fixture.reconcile_write', host(), { durable: true });
  assert.ok(written.ref);
});

test('peer status distinguishes superseded claims while retaining their correction and history paths', async t => {
  const { trace } = await fixture(t);
  const old = await trace.note({ kind: 'finding', text: 'Worker claims retry timing is correct', source_refs: [] }, host('worker', 'old'));
  const correction = await trace.note({ kind: 'correction', text: 'The delayed retry assertion failed; the earlier claim is withdrawn', source_refs: [], supersedes: [old.ref] }, host('worker', 'correction'));
  const status = await raw(definitions(trace).find(tool => tool.name === 'trace_status'), {}, host('reviewer'));
  const peer = status.peers.find(item => item.sessionID === 'worker');
  assert.deepEqual(peer.note_refs, [correction.ref], 'the old finding is not advertised as an unsuperseded peer note');
  assert.match(peer.note_refs_scope, /retained note window/);
  assert.deepEqual(peer.note_history.superseded_refs, [old.ref]);
  assert.deepEqual(peer.note_history.supersession_links, [{ ref: correction.ref, supersedes: [old.ref] }]);
  assert.deepEqual([peer.note_history.retained_count, peer.note_history.unsuperseded_retained_count, peer.note_history.superseded_retained_count], [2, 1, 1]);
  const history = await raw(definitions(trace).find(tool => tool.name === peer.note_history.retrieve.tool), peer.note_history.retrieve.arguments, host('reviewer'));
  assert.deepEqual(new Set(history.results.map(item => item.ref)), new Set([old.ref, correction.ref]), 'both immutable claims remain discoverable');
  assert.equal(JSON.parse((await trace.store.expand(old.ref)).exact_utf8).text, 'Worker claims retry timing is correct');
});
