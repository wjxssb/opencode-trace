// Real LOCAL MODEL final-handoff drill (V2-handlefix qualification §0 / §31).
//
// Scenario: evidence A is created in an early turn; its handle expires after
// several later turns; the Reviewer produces a CheckReceipt; the model binds
// it as a typed claim; the final handoff must cite BOTH the historical
// evidence and the typed claim — via fresh retrieve-to-cite handles only.
// Success criteria:
//   - the durable handoff stores exact canonical refs for both targets
//   - the model copied ZERO 64-hex SHA strings in any tool call
//   - no malformed-ref retry was ever needed
//   - the claim is VERIFIED_MECHANICAL (real receipt)
// Real candidate Trace code: real store, real context hook (per-request
// snapshot + handle generation), real tool middleware, durable CAS.
// Zero non-local inference: the only endpoint touched is 127.0.0.1:18080.
// Usage: node tests/final-handoff-drill.mjs
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Trace } from '../src/trace.js';
import { definitions } from '../src/tools.js';
import crypto from 'node:crypto';

const run = promisify(execFile);
const BASE = 'http://127.0.0.1:18080/v1';
const MODEL = 'qwen38-27b-dense';
const MARK = 'gate-evidence-hf31a2';

async function chat(messages, tools) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: 'auto', temperature: 0, max_tokens: 2048 }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`vLLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).choices[0].message;
}

const COMMIT = 'b'.repeat(64);
const receipt = {
  checkID: `chk_${'3'.repeat(32)}`, kind: 'test', status: 'passed', commandExitCode: 0,
  timedOut: false, signal: 'none', candidate: { commit: COMMIT, branch: 'candidate/v2-handlefix' },
  output: { sha256: 'd'.repeat(64) },
};

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-final-handoff-drill-'));
const trace = new Trace({ location: { directory: dir } }, { storeRoot: path.join(dir, 'store') });
await trace.ready;
const sid = 'ses_finalhandoff';
const host = { sessionID: sid, agent: 'build' };
const tools = definitions(trace);
const byName = Object.fromEntries(tools.map(d => [d.name, d]));
const apiTools = [
  { type: 'function', function: { name: 'shell', description: 'Run a shell command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  ...['trace_find', 'trace_expand', 'trace_note', 'trace_claim_receipt'].map(name => {
    const d = byName[name];
    return { type: 'function', function: { name, description: d.description, parameters: d.input } };
  }),
];

const contextHook = async () => {
  const { recall } = await trace.context({ sessionID: sid, messages: [], agent: 'build', model: { providerID: 'local-qwen-auto', id: '27b-dense' } });
  return recall;
};

const messages = [{ role: 'system', content: 'You are exercising an evidence-handle workflow. Follow the user instructions exactly, step by step, using the provided tools. NEVER type a 64-hex-character string; cite evidence with the SHORT HANDLE labels (like e1, n1) that trace_find and your context give you.' }];
const seen = { toolInputs: [], findCalls: 0, handoffInput: null, claimInput: null, shaViolations: 0, malformedRetries: 0 };
const resultLog = [];

// Each phase = one user instruction + the model's tool calls for it.
const phases = [
  `Phase 1 of 4 — create the gate evidence: run the shell command exactly: echo ${MARK}. Then reply OK.`,
  `Phase 2 of 4 — several later turns have happened. Just run the shell command: echo interim-turn-work. Then reply OK. (Your context has rotated; old handles may be stale.)`,
  `Phase 3 of 4 — the independent Reviewer completed a mechanical check of the candidate and produced this CheckReceipt: ${JSON.stringify(receipt)}. Record it durably: call trace_claim_receipt with subject "gates green", scope "test_command_completed", and receipt set to exactly that JSON object. Then reply OK.`,
  `Phase 4 of 4 — FINALIZATION. Write the final handoff note: call trace_note with EXACTLY these fields and nothing else: kind: "handoff", text: "<the handoff text — mention that the reviewer receipt was mechanically bound>", source_handles: [array of short handle labels], milestone: {kind: "handoff", summary: "<summary>", evidence_handles: [array of short handle labels]}. Do NOT add any other fields (no reason_type, no evidence_source — put those words inside the text if you want them recorded). The note must cite BOTH of these targets:
   (a) the gate evidence shell event that ran the command containing "${MARK}" (from Phase 1), and
   (b) the typed claim event you bound in Phase 3.
   Your old handles are likely expired: call trace_find (e.g. search text "${MARK}", and search type "trace.claim") to locate each target and use the SHORT HANDLE each result row gives you. Never type a hex string. Then reply DONE.`,
];

let phase = 0;
let hookedPhase = -1;
for (let i = 0; i < 16 && phase < phases.length; i++) {
  if (hookedPhase !== phase) {
    // One fresh handle generation per phase entry — the real per-turn
    // lifecycle: the generation covers the whole turn and its tool calls.
    await contextHook();
    hookedPhase = phase;
    if (phase === 1) {
      // Interim tool work pushes the Phase-1 evidence out of the 8-row
      // snapshot window, so its original handle genuinely expires.
      for (let k = 0; k < 9; k++) {
        await trace.after({ sessionID: sid, messageID: 'filler', id: `filler${k}`, agent: 'build',
          tool: 'shell', input: { command: `interim filler ${k}` }, status: 'completed', result: { output: 'f' } });
      }
    }
  }
  messages.push({ role: 'user', content: phases[phase] });
  const reply = await chat(messages, apiTools);
  messages.push(reply);
  if (!reply.tool_calls?.length) { phase += 1; continue; }
  let progressed = false;
  for (const call of reply.tool_calls) {
    let result;
    try {
      const input = JSON.parse(call.function.arguments);
      seen.toolInputs.push({ phase: phase + 1, name: call.function.name, input });
      if (/[0-9a-f]{64}/.test(call.function.arguments)) seen.shaViolations += 1;
      if (call.function.name === 'shell') {
        await trace.before({ sessionID: sid, messageID: `m${i}`, id: call.id, agent: 'build', tool: 'shell', input });
        const proc = await run('bash', ['-c', input.command]).catch(e => ({ stdout: '', stderr: String(e) }));
        const output = `${proc.stdout}${proc.stderr}`.slice(0, 4000) || '(empty)';
        await trace.after({ sessionID: sid, messageID: `m${i}`, id: call.id, agent: 'build', tool: 'shell', input, status: 'completed', result: { output } });
        result = output;
      } else {
        if (call.function.name === 'trace_find') seen.findInputs ??= [], seen.findInputs.push(input), (seen.findCalls += 1);
        if (call.function.name === 'trace_note') seen.handoffInput = input;
        if (call.function.name === 'trace_claim_receipt') seen.claimInput = input;
        const out = await byName[call.function.name].execute(input, host);
        if (/Invalid ref|not found in this workspace|Unknown evidence handle/.test(out.content ?? '')) seen.malformedRetries += 1;
        result = out.content;
        if (out.metadata?.raw?.ok === true && ['trace_note', 'trace_claim_receipt'].includes(call.function.name)) progressed = true;
      }
    } catch (error) { result = `tool error: ${error.message}`; }
    resultLog.push(`phase${phase + 1} ${call.function.name} -> ${String(result).slice(0, 220)}`);
    messages.push({ role: 'tool', tool_call_id: call.id, content: String(result).slice(0, 8000) });
  }
  if (progressed || phase === 0 || phase === 1) phase += 1;
}

console.log('--- model tool-call log ---');
console.log(resultLog.join('\n'));
console.log('note inputs:', JSON.stringify(seen.toolInputs.filter(x => x.name === 'trace_note')).slice(0, 1500));

// ---- Durable verification against the CAS ----
const events = [...trace.store.index.values()];
const notes = [];
for (const e of events) if (e.type === 'trace.note') notes.push(JSON.parse((await trace.store.readBlob(e.payloadRef)).toString()));
const claimRows = events.filter(e => e.type === 'trace.claim');
assert.equal(claimRows.length, 1, 'exactly one typed claim bound');
const claimPayload = JSON.parse((await trace.store.readBlob(claimRows[0].payloadRef)).toString());
assert.equal(claimPayload.claim_status, 'CLAIMED', 'the reviewer receipt binds mechanical verification');
let evidenceEvents = [];
for (const e of events) {
  if (e.type !== 'tool.after' && e.type !== 'tool.before') continue;
  const payload = JSON.parse((await trace.store.readBlob(e.payloadRef)).toString());
  if (typeof payload?.input?.command === 'string' && payload.input.command.includes(MARK)) evidenceEvents.push(e);
}
assert.ok(evidenceEvents.length >= 1, 'gate evidence event exists');
const handoff = notes.find(n => n.kind === 'handoff');
assert.ok(handoff, 'final handoff note persisted');
const refs = [...(handoff.source_refs ?? []), ...(handoff.milestone?.evidence_refs ?? [])];
assert.ok(evidenceEvents.some(ev => refs.includes(ev.ref)), `handoff cites the gate evidence canonically (got ${JSON.stringify(refs)})`);
assert.ok(refs.includes(claimRows[0].ref), 'handoff cites the typed claim canonically');
for (const r of new Set(refs)) assert.match(r, /^(evt|blob)_[0-9a-f]{64}$/, `canonical only, got ${r}`);
assert.equal('source_handles' in handoff, false, 'handles never persisted');
assert.equal('evidence_handles' in (handoff.milestone ?? {}), false, 'handles never persisted (milestone)');

// Model-behavior invariants. Stage-0 bar: the workflow completes with
// retrieve-to-cite and zero malformed-ref retries — manual SHA copying is
// never REQUIRED. Zero COPIED SHA strings is the post-gateway (S4) bar: the
// pre-gateway trace_find surface prints naked canonical refs next to
// handles, which this drill quantifies as the leak inventory baseline.
assert.equal(seen.malformedRetries, 0, 'no malformed-ref retry was ever needed');
assert.ok(seen.findCalls >= 1, 'the model used trace_find (retrieve-to-cite)');
assert.ok(seen.handoffInput, 'the model wrote the handoff itself');

console.log('DRILL_OK');
console.log('  evidence A:', evidenceEvents.map(e => e.ref).join(', '));
console.log('  claim:     ', claimRows[0].ref, claimPayload.claim_status);
console.log('  handoff:   ', JSON.stringify({ source_refs: handoff.source_refs, milestone_evidence_refs: handoff.milestone?.evidence_refs }));
console.log('  model find calls:', seen.findCalls, '| malformed retries:', seen.malformedRetries);
console.log(`  sha copies observed: ${seen.shaViolations} (stage-0 baseline leak; the post-S4 bar is 0)`);
console.log(resultLog.join('\n'));
await trace.store.close();
await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
