// V3 S1 qualification: EvidenceGateway — the single model-facing evidence
// ingress authority. trace_note (and every ref-validating path) now routes
// through the gateway; behavior is externally equivalent (the 293-test suite
// pins parity). This file pins the gateway's own contract:
//   - resolveCitation: handle / canonical / malformed -> fail closed
//   - session/expiry/generation validation (never cross-session, never stale)
//   - normalizeEvidence moved verbatim (handles merged before store validation)
//   - refs/refsOrHint diagnostics identical (malformed: closest stored ref;
//     unknown: live handles hint) — display-only, never auto-applied
//   - registerEvidence / prepareModelView delegation
//   - durable payloads stay canonical-only
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { Trace } from '../src/trace.js';
import { EvidenceGateway } from '../src/evidence-gateway.js';
import { definitions } from '../src/tools.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-trace-gateway-'));
  const trace = new Trace({ location: { directory: dir } }, { storeRoot: path.join(dir, 'store') });
  await trace.ready;
  t.after(async () => { await trace.store.close(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); });
  return { dir, trace, store: trace.store };
}
const host = (sessionID = 's1') => ({ sessionID, messageID: 'm1', id: 'c1', agent: 'build' });

test('G-S1: gateway is the single ingress authority wired into Trace', async t => {
  const { trace } = await fixture(t);
  assert.ok(trace.gateway instanceof EvidenceGateway);
  assert.equal(trace.gateway.trace, trace);
  assert.equal(trace.gateway.handles, trace.handles);
  assert.equal(trace.gateway.store, trace.store);
});

test('G-S1: resolveCitation resolves a handle to the exact canonical ref', async t => {
  const { trace } = await fixture(t);
  await trace.after({ sessionID: 's1', messageID: 'm1', id: 'c1', agent: 'build',
    tool: 'shell', input: { command: 'gateway-evidence' }, status: 'completed', result: { output: 'ok' } });
  const { snapshot, assignments } = trace.recallSnapshot('s1');
  trace.handles.newGeneration('s1', assignments);
  const canonical = snapshot.recent.at(-1).ref;
  const r = await trace.gateway.resolveCitation('s1', 'e1');
  assert.equal(r.ref, canonical);
  assert.equal(r.via, 'handle');
  assert.equal(r.kind, 'event');
});

test('G-S1: resolveCitation validates a canonical ref against the store', async t => {
  const { trace } = await fixture(t);
  await trace.after({ sessionID: 's1', messageID: 'm1', id: 'c1', agent: 'build',
    tool: 'shell', input: { command: 'gateway-canonical' }, status: 'completed', result: { output: 'ok' } });
  const { snapshot } = trace.recallSnapshot('s1');
  const canonical = snapshot.recent.at(-1).ref;
  const r = await trace.gateway.resolveCitation('s1', canonical);
  assert.equal(r.ref, canonical);
  assert.equal(r.via, 'canonical');
  await assert.rejects(() => trace.gateway.resolveCitation('s1', `evt_${'9f'.repeat(32)}`), /not found in this workspace/);
});

test('G-S1: resolveCitation fails closed on expired, foreign and unknown handles', async t => {
  const { trace } = await fixture(t);
  await trace.after({ sessionID: 's1', messageID: 'm1', id: 'c1', agent: 'build',
    tool: 'shell', input: { command: 'expiry-check' }, status: 'completed', result: { output: 'ok' } });
  const { assignments } = trace.recallSnapshot('s1');
  trace.handles.newGeneration('s1', assignments); // s1 active: e1
  trace.handles.newGeneration('s2', []);          // s2 active: empty
  // foreign: s1's active generation owns e1; s2 may never resolve it
  assert.deepEqual(trace.gateway.validateSession('s2', 'e1'), { ok: false, reason: 'foreign_session', session_scope_violation: true });
  await assert.rejects(() => trace.gateway.resolveCitation('s2', 'e1'), /belongs to a different session/);
  // expired: rotating s1 moves the old mapping to the tombstone
  trace.handles.newGeneration('s1', []);
  await assert.rejects(() => trace.gateway.resolveCitation('s1', 'e1'), /Expired evidence handle 'e1'/);
  const expiry = trace.gateway.validateExpiry('s1', 'e1');
  assert.equal(expiry.ok, false);
  assert.equal(expiry.expired, true);
  // unknown
  await assert.rejects(() => trace.gateway.resolveCitation('s1', 'e99'), /Unknown evidence handle 'e99'/);
  // malformed identity
  await assert.rejects(() => trace.gateway.resolveCitation('s1', 'evt_short'), /Invalid source_refs/);
});

test('G-S1: normalizeEvidence is byte-faithful — note via handles keeps durable canonical-only', async t => {
  const { trace } = await fixture(t);
  await trace.after({ sessionID: 's1', messageID: 'm1', id: 'c1', agent: 'build',
    tool: 'shell', input: { command: 'normalize-evidence' }, status: 'completed', result: { output: 'ok' } });
  const { snapshot } = trace.recallSnapshot('s1');
  trace.handles.newGeneration('s1', trace.recallSnapshot('s1').assignments);
  const canonical = snapshot.recent.at(-1).ref;
  const tool = definitions(trace).find(d => d.name === 'trace_note');
  const out = await tool.execute({ kind: 'fact', text: 'via gateway', source_handles: ['e1'],
    milestone: { kind: 'verification', summary: 'gateway', evidence_handles: ['e1'] } }, host());
  assert.equal(out.metadata.raw.ok, true);
  const ev = await trace.store.readEvent(out.metadata.raw.ref);
  const data = JSON.parse((await trace.store.readBlob(ev.payload.ref)).toString());
  assert.deepEqual(data.source_refs, [canonical]);
  assert.deepEqual(data.milestone.evidence_refs, [canonical]);
  assert.equal('source_handles' in data, false);
  // The correspondence metadata event was recorded additively.
  const rows = trace.store.findEntriesAll({ type: 'trace.handle_resolution' });
  assert.equal(rows.length, 1);
  const meta = JSON.parse((await trace.store.readBlob(rows[0].payloadRef)).toString());
  assert.equal(meta.tool, 'trace_note');
  assert.equal(meta.resolutions.length, 2);
});

test('G-S1: refsOrHint diagnostics survive the move (malformed: candidate name; unknown: handles hint)', async t => {
  const { trace } = await fixture(t);
  await trace.after({ sessionID: 's1', messageID: 'm1', id: 'c1', agent: 'build',
    tool: 'shell', input: { command: 'hint-check' }, status: 'completed', result: { output: 'ok' } });
  const { snapshot } = trace.recallSnapshot('s1');
  trace.handles.newGeneration('s1', trace.recallSnapshot('s1').assignments);
  const real = snapshot.recent.at(-1).ref;
  const out = await definitions(trace).find(d => d.name === 'trace_note').execute(
    { kind: 'fact', text: 'near miss', source_refs: [`${real}a`] }, host());
  assert.equal(out.metadata.raw.ok, false);
  assert.match(out.metadata.raw.error, /Closest stored ref: evt_[0-9a-f]{64}/);
  assert.ok(out.metadata.raw.error.includes(real));
  const unknown = await definitions(trace).find(d => d.name === 'trace_note').execute(
    { kind: 'fact', text: 'plausible unknown', source_refs: [`evt_${'9f'.repeat(32)}`] }, host());
  assert.match(unknown.metadata.raw.error, /Current turn evidence handles: e1/);
  // nothing persisted by either diagnostic path
  assert.equal(trace.store.findEntriesAll({ type: 'trace.note' }).length, 0);
});

test('G-S1: registerEvidence and prepareModelView delegate with the same contract', async t => {
  const { trace } = await fixture(t);
  await trace.after({ sessionID: 's1', messageID: 'm1', id: 'c1', agent: 'build',
    tool: 'shell', input: { command: 'register-check' }, status: 'completed', result: { output: 'ok' } });
  const { snapshot, assignments, text } = trace.recallSnapshot('s1');
  trace.handles.newGeneration('s1', []);
  const registered = trace.gateway.registerEvidence('s1', [snapshot.recent.at(-1).ref]);
  assert.ok(registered.some(r => /^e[0-9]+$/.test(r.handle)));
  const view = { recent: [], notes: [], unresolved: [], current_intent: null,
    active_memory: { evidence_refs: [snapshot.recent.at(-1).ref] } };
  const assigned = trace.gateway.prepareModelView(view);
  assert.ok(assigned.some(a => a.ref === snapshot.recent.at(-1).ref));
  assert.ok(Array.isArray(assignments) && typeof text === 'string');
});

// ---- S2 pinning: unified-ingress fail-closed policy (round-12 findings) ----

test('G-S2: invalid claim supersedes fail closed — the silent filter-drop is gone', async t => {
  const { trace } = await fixture(t);
  await trace.after({ sessionID: 's1', messageID: 'm1', id: 'c1', agent: 'build',
    tool: 'shell', input: { command: 'claim-supersedes-check' }, status: 'completed', result: { output: 'ok' } });
  await assert.rejects(() => trace.recordClaim({ subject: 'x', text: 'x', supersedes: ['garbage'] }, host()),
    /Invalid supersedes\[0\]/, 'structurally invalid supersedes must throw, not be silently dropped');
  await assert.rejects(() => trace.recordClaim({ subject: 'x', text: 'x', supersedes: [`evt_${'9f'.repeat(32)}`] }, host()),
    /Unknown supersedes\[0\].*not found in this workspace/, 'well-formed but nonexistent supersedes also fail closed');
  assert.equal(trace.store.findEntriesAll({ type: 'trace.claim' }).length, 0, 'nothing persisted by rejected claim paths');
  const first = await trace.recordClaim({ subject: 'first', text: 'first' }, host());
  const second = await trace.recordClaim({ subject: 'second', text: 'second', supersedes: [first.ref] }, host());
  assert.deepEqual(second.claim.supersedes, [first.ref], 'valid canonical supersedes still accepted');
  assert.equal(trace.store.findEntriesAll({ type: 'trace.claim' }).length, 2);
});

test('G-S2: invalid prose refs fail closed', async t => {
  const { trace } = await fixture(t);
  await assert.rejects(() => trace.recordClaim({ subject: 'x', text: 'x', refs: ['not-a-ref'] }, host()),
    /Invalid source_refs\[0\]/);
  assert.equal(trace.store.findEntriesAll({ type: 'trace.claim' }).length, 0);
});

test('G-S2: receipt.output.ref resolves through the gateway with an actionable diagnostic', async t => {
  const { trace } = await fixture(t);
  const receipt = { checkID: `chk_${'1'.repeat(32)}`, kind: 'test', status: 'passed', commandExitCode: 0,
    timedOut: false, signal: 'none', candidate: { commit: 'a'.repeat(64) },
    output: { sha256: 'c'.repeat(64), ref: `blob_${'e'.repeat(64)}` } };
  await assert.rejects(() => trace.recordClaim({ subject: 'x', receipt }, host()),
    /Unknown receipt\.output\.ref.*not found in this workspace/, 'no raw ENOENT — gateway diagnostic');
  assert.equal(trace.store.findEntriesAll({ type: 'trace.claim' }).length, 0);
});

test('G-S2: find ref filters validate structurally without requiring existence', async t => {
  const { trace } = await fixture(t);
  await assert.rejects(() => trace.find({ ref: 'garbage' }, host()), /Invalid ref filter/);
  await assert.rejects(() => trace.find({ related: 'garbage' }, host()), /Invalid ref filter/);
  const out = await trace.find({ ref: `evt_${'9f'.repeat(32)}` }, host());
  assert.deepEqual(out.results ?? [], [], 'filters are not citations: a valid-but-unseen ref matches nothing, no throw');
});

test('G-S2: anti-bypass — the tool middleware routes through the gateway (single ingress)', async t => {
  const { trace } = await fixture(t);
  await trace.after({ sessionID: 's1', messageID: 'm1', id: 'c1', agent: 'build',
    tool: 'shell', input: { command: 'topology-check' }, status: 'completed', result: { output: 'ok' } });
  const { assignments } = trace.recallSnapshot('s1');
  trace.handles.newGeneration('s1', assignments);
  const original = trace.gateway.normalizeEvidence.bind(trace.gateway);
  trace.gateway.normalizeEvidence = async () => { throw new Error('GATEWAY_BYPASS_DETECTED'); };
  try {
    // The tool surface reports tool-layer failures as degraded outputs
    // (ok:false + error text) rather than rejections; accept both shapes.
    let sawFailure = false, sawMessage = '';
    try {
      const out = await definitions(trace).find(d => d.name === 'trace_note').execute(
        { kind: 'fact', text: 'must route through the gateway', source_handles: ['e1'] }, host());
      sawMessage = String(out?.metadata?.raw?.error ?? out?.content ?? '');
      sawFailure = out?.metadata?.raw?.ok === false || /GATEWAY_BYPASS_DETECTED/.test(sawMessage);
    } catch (error) {
      sawFailure = true;
      sawMessage = String(error?.message ?? error);
    }
    assert.ok(sawFailure && /GATEWAY_BYPASS_DETECTED/.test(sawMessage),
      `handle fields must resolve through the gateway, not a bypass copy (got: ${sawMessage.slice(0, 120)})`);
  } finally {
    trace.gateway.normalizeEvidence = original;
  }
  const out = await definitions(trace).find(d => d.name === 'trace_note').execute(
    { kind: 'fact', text: 'routes through gateway', source_handles: ['e1'] }, host());
  assert.equal(out.metadata.raw.ok, true, 'with the gateway restored the note resolves normally');
});

// S3: bindClaim was deleted — the claim ingress is Trace.recordClaim, which
// validates every riding ref through the gateway (unified S2 ingress); a
// second claim entry point would only invite divergence. Claim-as-n#
// presentation is the write-return registration in the tool layer.
