import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Trace, RECALL_MARKER, RECALL_EVIDENCE_POLICY, RECALL_WORKFLOW, RECALL_CONTEXT_POLICY } from '../src/trace.js';
import { definitions } from '../src/tools.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-recall-semantics-'));
  const trace = new Trace({ location: { directory: dir } }, { storeRoot: path.join(dir, 'store') });
  await trace.ready;
  t.after(async () => { trace.store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return trace;
}
const parse = text => JSON.parse(text.split('\n')[2]);

// Deterministically force the degraded fallback frame: an untrimmable
// observer diagnostic keeps the render over the byte ceiling after every
// structural prune step, so recallSnapshot must emit its typed minimal frame.
// Model/session context in these fixtures is trivially small — the degradation
// is purely a Trace-side display-budget event.
async function degradedFixture(t) {
  const trace = await fixture(t);
  trace.options.recallBytes = 8192;
  trace.store.watcherState = { mode: 'watch_and_reconcile', error: 'X'.repeat(24000) };
  return trace;
}

test('T1/T7: degraded recall is source-typed, instructs recovery+continue, and can never read as session/context exhaustion', async t => {
  const trace = await degradedFixture(t);
  await trace.note({ kind: 'fact', text: 'task state survives degradation', source_refs: [] }, { sessionID: 'worker' });
  const text = trace.recall('worker');
  assert.ok(text.startsWith(RECALL_MARKER), 'degraded frame stays inside the late runtime-context carrier');
  const view = parse(text);
  assert.equal(view.recall_truncated, true);
  assert.equal(view.reason, 'trace_runtime_budget');
  assert.equal(view.implies_session_exhaustion, false);
  assert.equal(view.session_context, 'not_observable_via_trace');
  assert.match(view.recovery, /trace_status/);
  assert.match(view.recovery, /trace_find/);
  assert.match(view.recovery, /trace_expand/);
  assert.match(view.recovery, /continue/);
  // With truncation as the ONLY signal, no exhaustion claim may be emitted.
  for (const banned of ['context_exhausted', 'budget_exhausted', 'session_exhausted', 'must_stop', 'must_handoff']) {
    assert.ok(!(banned in view), banned);
  }
  assert.ok(!text.includes('context exhausted') && !text.includes('budget exhausted'));
  // The degraded frame itself must stay inside its own display budget.
  assert.ok(Buffer.byteLength(text) <= 8192);
});

test('T2: trace_status recovery path remains fully available after degradation', async t => {
  const trace = await degradedFixture(t);
  const note = await trace.note({ kind: 'fact', text: 'PRE_DEGRADATION_STATE', source_refs: [] }, { sessionID: 'worker' });
  assert.equal(parse(trace.recall('worker')).recall_truncated, true);
  // Real recovery flow: trace_status -> stored structured result -> trace_expand.
  const statusTool = definitions(trace).find(d => d.name === 'trace_status');
  const status = await statusTool.execute({}, { sessionID: 'worker' });
  const resultRef = JSON.stringify(status).match(/blob_[0-9a-f]{64}/)?.[0];
  assert.ok(resultRef, 'trace_status stores its structured result for trace_expand');
  const page = await trace.store.expand(resultRef, 0, 24000);
  assert.ok(page.exact_utf8.includes(note.ref), 'own durable state is recoverable through trace_status + trace_expand');
});

test('T3: trace_find recovery path returns the omitted note after degradation', async t => {
  const trace = await degradedFixture(t);
  const note = await trace.note({ kind: 'finding', text: 'FINDING_SURVIVES_TRUNCATION', source_refs: [] }, { sessionID: 'worker' });
  const found = await trace.find({ type: 'trace.note', session: 'worker' }, { sessionID: 'worker' });
  assert.ok(JSON.stringify(found).includes(note.ref));
});

test('T4/T15: trace_expand returns the exact omitted payload after degradation', async t => {
  const trace = await degradedFixture(t);
  const note = await trace.note({ kind: 'unresolved', text: 'BLOCKER_AND_NEXT_ACTION_INTACT', source_refs: [] }, { sessionID: 'worker' });
  const page = await trace.store.expand(note.ref, 0, 24000);
  assert.ok(page.exact_utf8.includes('BLOCKER_AND_NEXT_ACTION_INTACT'));
  assert.equal(page.hash_verified, true);
});

test('T5/T6/T8/T9: no frame fabricates host/model context or execution-budget telemetry; budget domains stay separate', async t => {
  const healthyTrace = await fixture(t);
  await healthyTrace.note({ kind: 'fact', text: 'x', source_refs: [] }, { sessionID: 'worker' });
  const healthy = parse(healthyTrace.recall('worker'));
  const degraded = parse((await degradedFixture(t)).recall('worker'));
  for (const view of [healthy, degraded]) {
    for (const banned of ['used_tokens', 'limit_tokens', 'prompt_tokens', 'max_model_len', 'remaining',
      'pressure', 'context_pressure', 'execution_budget', 'session_context_pressure',
      'compaction_required', 'context_exhausted', 'budget_exhausted', 'session_exhausted']) {
      assert.ok(!(banned in view), `${banned} must not be fabricated without host telemetry`);
    }
  }
  // The only session_context statement is the explicit not-observable marker.
  assert.equal(degraded.session_context, 'not_observable_via_trace');
  // Execution budgets (if any exist) are never reported by Trace.
  assert.ok(!('execution_budget' in degraded) && !('remaining' in degraded));
});

test('T10/T11: planned-checkpoint and user-requested handoffs remain accepted and stored verbatim', async t => {
  const trace = await degradedFixture(t);
  const planned = await trace.note({ kind: 'handoff', text: 'Planned checkpoint at campaign segment end (reason_type: planned_checkpoint; evidence_source: agent_judgment)', source_refs: [] }, { sessionID: 'worker' });
  const userStop = await trace.note({ kind: 'handoff', text: 'User asked to pause here (reason_type: user_request; evidence_source: user)', source_refs: [] }, { sessionID: 'worker' });
  assert.ok(planned.ref && userStop.ref);
  const plannedPage = await trace.store.expand(planned.ref, 0, 4096);
  assert.ok(plannedPage.exact_utf8.includes('planned_checkpoint'));
});

test('T12: truncation semantics live only in the late per-turn frame; stable guidance constants carry no truncation/exhaustion state', async t => {
  for (const constant of [RECALL_EVIDENCE_POLICY, RECALL_WORKFLOW, RECALL_CONTEXT_POLICY]) {
    assert.ok(!constant.includes('recall_truncated'), 'no volatile truncation state in static guidance');
    assert.ok(!/exhaust/i.test(constant), 'no exhaustion claims in static guidance');
  }
  const trace = await degradedFixture(t);
  assert.ok(trace.recall('worker').startsWith(RECALL_MARKER));
});

test('T13: healthy frames assign evidence handles; degraded frames assign none (V2-A handle contract preserved)', async t => {
  const trace = await fixture(t);
  await trace.store.record('tool.after', { sessionID: 'worker', callKey: 'k1' }, { tool: 'shell', status: 'completed', result: {} }, { tool: 'shell', status: 'completed', outputs: [] });
  await trace.note({ kind: 'fact', text: 'note for handle assignment', source_refs: [] }, { sessionID: 'worker' });
  const healthy = trace.recallSnapshot('worker');
  assert.ok(healthy.assignments.length > 0, 'healthy frame carries evidence handles');
  assert.ok(Array.isArray(healthy.snapshot.evidence_handles) && healthy.snapshot.evidence_handles.length === healthy.assignments.length);
  const degradedTrace = await degradedFixture(t);
  const degraded = degradedTrace.recallSnapshot('worker');
  assert.deepEqual(degraded.assignments, []);
  assert.equal(degraded.snapshot.recall_truncated, true);
});

test('Tool guidance carries the semantic contract: recall truncation recovery on trace_status; typed handoff reasons', async t => {
  const trace = await fixture(t);
  const byName = Object.fromEntries(definitions(trace).map(d => [d.name ?? d.id, d]));
  const status = JSON.stringify(byName.trace_status ?? byName['trace_status']);
  assert.match(status, /recall_truncated/);
  assert.match(status, /never model, session, or execution-budget exhaustion/);
  const note = JSON.stringify(byName.trace_note ?? byName['trace_note']);
  assert.match(note, /context_limit\|execution_budget\|planned_checkpoint\|user_request\|runtime_failure\|other/);
  assert.match(note, /host\|provider\|orchestrator\|user\|agent_judgment/);
  assert.match(note, /Trace recall truncation alone never establishes context or session exhaustion/);
});
