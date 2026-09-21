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
