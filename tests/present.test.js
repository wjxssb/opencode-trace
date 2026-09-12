// P1 presentation-layer tests: mechanical formatting of trace tool results.
// Contract under test (Phase 0 spike): content = human Markdown + fenced
// machine block; title = one-liner; metadata.raw size-bounded; every
// formatter is defensive and never throws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { present, boundedRaw } from '../src/present.js';
import { definitions } from '../src/tools.js';

const fakeTrace = {
  ready: Promise.resolve(),
  warning: () => {},
  store: { workspace: '/w' },
  note: async (input) => {
    if (!['fact', 'finding', 'decision', 'unresolved', 'handoff', 'correction'].includes(input.kind)) {
      throw new Error('Invalid note schema or size');
    }
    return { ref: 'evt_fake_note', note: { kind: input.kind, text: input.text, source_refs: [], supersedes: [], depends_on: [] } };
  },
};

test('present: trace_intent renders status, summary, advisories and never loses the ref', () => {
  const value = {
    ok: true, ref: 'evt_intent1',
    intent: { summary: 'Migrate codex-web to dragonforge', status: 'active', paths: ['/a', '/b'], resources: [], related_refs: [] },
    advisories: [{ ref: 'evt_adv1', peer: 'ses_peer', paths: ['/a'], resources: [], observation: {} }],
    execution_effect: 'none',
  };
  const { title, content } = present('trace_intent', value);
  assert.match(title, /Intent \(active\)/);
  assert.match(content, /Migrate codex-web to dragonforge/);
  assert.match(content, /ses_peer/);
  assert.match(content, /advisory only, never blocking/);
  assert.match(content, /evt_intent1/);
  // machine parity: full JSON is fenced so the model keeps the exact data
  assert.match(content, /```json/);
  assert.match(content, /"execution_effect": "none"/);
});

test('present: trace_find index mode lists entries, cursor and records phrase', () => {
  const value = {
    ok: true, mode: 'index', query: { text: 'parser' },
    results: [{ ref: 'evt_r1', type: 'tool.after', tool: 'edit', status: 'completed', at: 1789190000000, hit: { field: 'hint', snippet: 'parser fix applied' } }],
    next_cursor: 'eyJxIjoxfQ', coverage: { indexed_events: 42 },
  };
  const { title, content } = present('trace_find', value);
  assert.match(title, /Found 1 record/);
  assert.match(content, /evt_r1/);
  assert.match(content, /parser fix applied/);
  assert.match(content, /eyJxIjoxfQ/);
  assert.match(content, /42/);
});

test('present: trace_find deep mode lists hits with byte offsets', () => {
  const value = {
    ok: true, mode: 'deep', query: { text: 'needle' },
    hits: [{ event_ref: 'evt_e1', blob_ref: 'blob_b1', byte_offset: 4096, snippet: 'the needle here' }],
    coverage: { indexed_events: 7 },
  };
  const { title, content } = present('trace_find', value);
  assert.match(title, /Deep scan: 1 hit/);
  assert.match(content, /4096/);
  assert.match(content, /blob_b1/);
});

test('present: trace_expand keeps payload byte-exact in the fence and compatibility phrases', () => {
  const payload = 'line one\nline "quoted" \u20ac\n';
  const value = {
    ok: true, ref: 'evt_x1', payload_ref: 'blob_p1', sha256: 'a'.repeat(64), hash_verified: true,
    metadata_only: false, offset: 2048, limit: 2048, returned_bytes: 2048, total_bytes: 10240,
    next_offset: 4096, metadata: { type: 'tool.after' }, source: null, related_refs: ['evt_rel1'],
    text_blobs: [{ ref: 'blob_t1', bytes: 96 }],
    exact_utf8: payload, exact_base64: Buffer.from(payload).toString('base64'),
    encoding: 'utf8; base64 preserves page-boundary bytes',
  };
  const { title, content } = present('trace_expand', value);
  assert.match(title, /2048\/10240 bytes · SHA-256 verified/);
  assert.match(content, /2048\/10240 bytes/);            // reviewer adapter phrase
  assert.match(content, /hash_verified: true/);          // reviewer adapter phrase
  assert.match(content, /evt_rel1/);
  // the base64 page must appear VERBATIM inside the fence (byte-exact recovery)
  assert.ok(content.includes(Buffer.from(payload).toString('base64')));
  assert.ok(content.includes('"exact_utf8"'));
});

test('present: trace_send shows receipts and evidence-level language', () => {
  const value = {
    ok: true, message_id: 'msgx_1', thread_id: 'thr_1', message_ref: 'evt_m1',
    receipts: [{ recipient: 'ses_b', state: 'host_admitted', delivery_ref: 'evt_d1', attempt_id: 'att_1' }],
    evidence_levels: 'persisted always; host_admitted per delivery receipt',
  };
  const { title, content } = present('trace_send', value);
  assert.match(title, /msgx_1 persisted · 1\/1 admitted/);
  assert.match(content, /ses_b/);
  assert.match(content, /host_admitted/);
  assert.match(content, /never means? agreement/);
});

test('present: trace_inbox renders evidence levels per message', () => {
  const value = {
    ok: true, viewer: 'ses_a',
    inbox: [{ message_id: 'msgx_2', thread_id: 'thr_1', type: 'proposal', from: 'ses_b', note: 'levels note',
      levels: { persisted: 'evt_p1', host_admitted: 'evt_d2', context_observed: null, recipient_ack: false, reply_recorded: false } }],
    outbox: [{ message_id: 'msgx_1', type: 'proposal', deliveries: [{ recipient: 'ses_b', state: 'host_admitted' }], reply_recorded: true }],
  };
  const { title, content } = present('trace_inbox', value);
  assert.match(title, /Inbox: 1 inbound · 1 outbound/);
  assert.match(content, /msgx_2/);
  assert.match(content, /recipient_ack=no/);
  assert.match(content, /ses_b=host_admitted/);
});

test('present: trace_status summarizes memory, peers and degradation', () => {
  const value = {
    ok: true, schema: 1, workspace: '/w', sessionID: 'ses_a',
    current_intent: { summary: 'ship the parser fix', status: 'active', paths: [], resources: [] },
    intent_conflicts: [], observation: {}, unresolved: [{ ref: 'evt_u1', kind: 'unresolved' }],
    notes: [{ ref: 'evt_n1', kind: 'decision' }], compact: null, recent: [],
    advisories: [], peers: [{ sessionID: 'ses_b', agent: 'build', status: 'session.execution.started', intent: { status: 'active', summary: 'peer work' } }],
    peer_total: 45, peer_next_offset: 8, coordination: 'Advisories never block execution.',
    store: '/store', errors: 1, observer: { dropped_observations: 0 },
  };
  const { title, content } = present('trace_status', value);
  assert.match(title, /1 notes · 1 unresolved · 1 peers shown · intent active/);
  assert.match(content, /ship the parser fix/);
  assert.match(content, /evt_u1/);
  assert.match(content, /peer work/);
  assert.match(content, /next offset: 8/);
  assert.match(content, /degradation/);
});

test('present: trace_plan counts worker-reported success and carries semantics', () => {
  const value = {
    ok: true, plan_id: 'plan_ab', version: 1, plan_ref: 'evt_plan',
    steps: [
      { id: 'scan', execution: 'settled', outcome: 'worker_reported_success', sessionID: 'ses_c1', evidence_ref: 'evt_s1' },
      { id: 'join', execution: 'failed', outcome: null, phase: 'prompt', evidence_ref: 'evt_s2' },
    ],
    semantics: 'execution settled means the child turn finished',
  };
  const { title, content } = present('trace_plan', value);
  assert.match(title, /1\/2 steps worker-reported success/);
  assert.match(content, /worker_reported_success/);
  assert.match(content, /failed@?|failed/);
  assert.match(content, /evt_plan/);
});

test('present: ok:false renders a failure document with the error', () => {
  const { title, content } = present('trace_note', { ok: false, error: 'Invalid note schema or size', native_execution: 'unaffected' });
  assert.match(title, /trace_note failed/);
  assert.match(content, /Invalid note schema or size/);
  assert.match(content, /native execution is unaffected/);
});

test('present: generic fallback fences unknown or malformed values and never throws', () => {
  assert.doesNotThrow(() => present('trace_note', undefined));
  assert.doesNotThrow(() => present('trace_note', { ok: true, note: new Date(NaN) }));
  const { content } = present('unknown_tool', { hello: true });
  assert.match(content, /```json/);
  assert.match(content, /"hello": true/);
});

test('boundedRaw: omits oversized raw with an explicit marker, keeps small raw verbatim', () => {
  const small = { ok: true, ref: 'evt_1' };
  assert.deepEqual(boundedRaw(small, JSON.stringify(small)), small);
  const big = { ok: true, blob: 'x'.repeat(20000) };
  const raw = boundedRaw(big, JSON.stringify(big), 4096);
  assert.equal(raw.raw_omitted, true);
  assert.equal(raw.serialized_bytes, JSON.stringify(big).length);
});

test('tools: definitions wire the presentation layer end-to-end', async () => {
  const [noteTool] = definitions(fakeTrace);
  assert.equal(noteTool.name, 'trace_note');
  const res = await noteTool.execute({ kind: 'finding', text: 'wired', source_refs: [] }, { sessionID: 'ses_t', id: 'call_1' });
  assert.equal(res.metadata.opencode_trace, true);
  assert.equal(res.metadata.raw.ok, true);
  assert.match(res.title, /Note saved \(finding\)/);
  assert.match(res.content, /### Note saved/);
  assert.equal(typeof res.content, 'string');
  assert.equal(res.output, res.content);
});

test('tools: execution failure returns the presented failure document, not a throw', async () => {
  const tools = definitions(fakeTrace);
  const noteTool = tools.find(t => t.name === 'trace_note');
  const res = await noteTool.execute({ kind: 'bogus', text: 'x', source_refs: [] }, { sessionID: 'ses_t', id: 'call_2' });
  assert.equal(res.metadata.raw.ok, false, 'boundedRaw omits raw only on size; failure payload stays');
  assert.match(res.title, /trace_note failed/);
  assert.match(res.content, /error/);
});


test('presentation preserves oversized structured results and counts UTF-8 bytes', () => {
  const value = { ok: true, results: [{ ref: 'evt_a', evidence: '中文'.repeat(10000) }], next_cursor: 'cursor-tail', coverage: { complete: false, reason: 'budget' } };
  const shown = present('trace_find', value);
  const machine = shown.content.slice(shown.content.lastIndexOf('```json\n') + 8, -4);
  assert.deepEqual(JSON.parse(machine), value);
  const json = JSON.stringify({ text: '中'.repeat(3000) });
  const raw = boundedRaw({}, json, 4096);
  assert.equal(raw.raw_omitted, true);
  assert.equal(raw.serialized_bytes, Buffer.byteLength(json));
});


test('oversized native result is durably addressable before host truncation', async t => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { Store } = await import('../src/store.js');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-present-store-'));
  const store = await new Store(directory, path.join(directory, 'store')).init();
  t.after(async () => { store.close(); await fs.rm(directory, {recursive:true,force:true}); });
  const value = { results: [{ ref: 'evt_fixture', detail: '中文'.repeat(30000) }], coverage: { complete: false }, next_cursor: 'exact-next-cursor' };
  const tool = definitions({ ready: Promise.resolve(), warning() {}, store, find: async () => value }).find(t=>t.name==='trace_find');
  const result = await tool.execute({}, {sessionID:'ses_test'});
  assert.ok(Buffer.byteLength(result.content)<24000);
  assert.equal(result.metadata.raw.raw_omitted,true);
  assert.match(result.content,/exact-next-cursor/);
  const json = await store.readBlob(result.metadata.result_ref);
  assert.deepEqual(JSON.parse(json), {ok:true,...value});
});
