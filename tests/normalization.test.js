import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTraceIntentInput, TraceValidationError } from '../src/normalization.js';
import { definitions } from '../src/tools.js';
import { Trace } from '../src/trace.js';
import { present } from '../src/present.js';

test('T1: paths missing + status done -> canonical behavior (paths: [])', () => {
  const result = normalizeTraceIntentInput({
    status: 'done',
    summary: 'Stage 3 COMPLETE: deployment verified',
  });
  assert.equal(result.status, 'done');
  assert.equal(result.summary, 'Stage 3 COMPLETE: deployment verified');
  assert.deepEqual(result.paths, []);
  assert.deepEqual(result.resources, []);
  assert.equal(result.recovered, false);
  assert.equal(result.attempt, 1);
});

test('T1b: paths missing + status cancelled -> canonical behavior (paths: [])', () => {
  const result = normalizeTraceIntentInput({
    status: 'cancelled',
    summary: 'Task cancelled by user',
  });
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(result.paths, []);
});

test('T1c: paths null -> canonical behavior (paths: [])', () => {
  const result = normalizeTraceIntentInput({
    status: 'done',
    summary: 'done task',
    paths: null,
  });
  assert.deepEqual(result.paths, []);
});

test('T2: paths string -> normalized array', () => {
  const result = normalizeTraceIntentInput({
    status: 'active',
    summary: 'inspecting single file',
    paths: 'src/index.js',
  });
  assert.deepEqual(result.paths, ['src/index.js']);
});

test('T3: paths array -> unchanged and trimmed', () => {
  const result = normalizeTraceIntentInput({
    status: 'active',
    summary: 'editing files',
    paths: [' src/a.js ', 'src/b.js'],
  });
  assert.deepEqual(result.paths, ['src/a.js', 'src/b.js']);
});

test('T4: paths invalid object -> deterministic actionable error', () => {
  assert.throws(
    () => normalizeTraceIntentInput({
      status: 'active',
      summary: 'bad paths',
      paths: { file: 'foo.txt' },
    }),
    (err) => {
      assert.ok(err instanceof TraceValidationError);
      assert.match(err.message, /paths must be an array of strings, a single path string, or null\/omitted/);
      return true;
    }
  );
});

test('T4b: paths invalid number -> deterministic actionable error', () => {
  assert.throws(
    () => normalizeTraceIntentInput({
      status: 'active',
      summary: 'bad paths',
      paths: 12345,
    }),
    (err) => {
      assert.ok(err instanceof TraceValidationError);
      assert.match(err.message, /paths must be an array of strings/);
      return true;
    }
  );
});

test('T4c: paths array containing non-string -> deterministic actionable error', () => {
  assert.throws(
    () => normalizeTraceIntentInput({
      status: 'active',
      summary: 'bad elements',
      paths: ['good.js', { bad: true }],
    }),
    (err) => {
      assert.ok(err instanceof TraceValidationError);
      assert.match(err.message, /paths must contain only non-empty path strings; element at index 1/);
      return true;
    }
  );
});

test('T5: summary missing on active -> actionable error', () => {
  assert.throws(
    () => normalizeTraceIntentInput({
      status: 'active',
    }),
    (err) => {
      assert.ok(err instanceof TraceValidationError);
      assert.match(err.message, /summary is required when setting intent status to "active"/);
      return true;
    }
  );
});

test('T6: summary missing on done -> safe default summary', () => {
  const result = normalizeTraceIntentInput({
    status: 'done',
  });
  assert.equal(result.status, 'done');
  assert.equal(result.summary, 'Intent done');
  assert.deepEqual(result.paths, []);
});

test('T7: recovery tracking through Trace and present', () => {
  const presented = present('trace_intent', {
    ref: 'evt_12345',
    recovered: true,
    attempt: 2,
    previous_error: 'paths: Missing key',
    intent: {
      status: 'done',
      summary: 'Production deploy completed',
      paths: [],
      recovered: true,
      attempt: 2,
      previous_error: 'paths: Missing key',
    },
    advisories: [],
  });

  assert.match(presented.title, /Intent \(done\) · recovered ✓/);
  assert.match(presented.content, /recovered from validation failure on attempt 2/);
  assert.match(presented.content, /paths: Missing key/);
});

test('T8: End-to-end tool execution handles missing paths on done', async (t) => {
  const mockCtx = {
    location: { directory: '/tmp' },
    session: { hook: () => {} },
    tool: { hook: () => {}, transform: () => {} },
    agent: { transform: () => {} },
    event: { subscribe: async function* () {} },
  };
  const trace = new Trace(mockCtx, { storeRoot: `/tmp/trace-test-${Date.now()}` });
  await trace.ready;

  const toolDefs = definitions(trace);
  const intentTool = toolDefs.find(t => t.name === 'trace_intent');
  assert.ok(intentTool, 'trace_intent tool defined');

  const host = { sessionID: 'ses_test_worker', id: 'call_1' };

  // First call with missing paths and status done succeeds gracefully via normalization
  const res = await intentTool.execute({
    status: 'done',
    summary: 'Stage 3 COMPLETE: reproducible build bit-for-bit',
  }, host);

  assert.equal(res.metadata.title.includes('Intent (done)'), true);
  assert.equal(res.metadata.opencode_trace, true);

  trace.store.close();
});

test('T9: Failure tracking records failure and marks next successful call as recovered', async (t) => {
  const mockCtx = {
    location: { directory: '/tmp' },
    session: { hook: () => {} },
    tool: { hook: () => {}, transform: () => {} },
    agent: { transform: () => {} },
    event: { subscribe: async function* () {} },
  };
  const trace = new Trace(mockCtx, { storeRoot: `/tmp/trace-recovery-${Date.now()}` });
  await trace.ready;

  const toolDefs = definitions(trace);
  const intentTool = toolDefs.find(t => t.name === 'trace_intent');

  const host = { sessionID: 'ses_test_recovery', id: 'call_fail' };

  // 1. First call fails with invalid paths type
  const failRes = await intentTool.execute({
    status: 'active',
    summary: 'Should fail',
    paths: { bad: 'object' }
  }, host);

  assert.equal(failRes.content.includes('paths must be an array of strings'), true);

  // 2. Second call succeeds with valid paths and is automatically marked recovered
  const host2 = { sessionID: 'ses_test_recovery', id: 'call_success' };
  const succRes = await intentTool.execute({
    status: 'active',
    summary: 'Recovered call',
    paths: ['valid.txt']
  }, host2);

  assert.equal(succRes.metadata.title.includes('recovered ✓'), true);

  trace.store.close();
});
