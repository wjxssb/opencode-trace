import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Trace, DEEP_CHUNK_BYTES } from '../src/trace.js';
import { atomic, stable } from '../src/util.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-trace-find-'));
  const trace = new Trace({ location: { directory: dir } }, { storeRoot: path.join(dir, 'store') });
  await trace.ready;
  t.after(async () => { trace.store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, trace, store: trace.store };
}
const host = (sessionID = 's1', id = 'c1') => ({ sessionID, messageID: 'm1', id, agent: 'build' });

test('P2: clue-only retrieval over thousands of events and 70 notes, exact byte recovery without any ref', async t => {
  const { trace, dir } = await fixture(t);
  for (let i = 0; i < 70; i++) {
    await trace.note({ kind: i === 41 ? 'unresolved' : 'finding', text: i === 41 ? 'flaky XID43 report on queue' : `note ${i} routine`, source_refs: [] }, host('s1', `n${i}`));
  }
  for (let i = 0; i < 2400; i++) {
    await trace.after({ ...host('s2', `c${i}`), tool: 'read', input: { filePath: path.join(dir, `f${i}.txt`) }, status: 'completed', result: { content: [{ type: 'text', text: `routine output ${i}` }] } });
  }
  const marked = await trace.after({ ...host('s3', 'marked'), tool: 'shell', input: { command: 'run suite' }, status: 'error', result: { content: [{ type: 'text', text: 'fatal EIO writing sector on /dev/target' }] } });
  const restarted = new Trace({ location: { directory: dir } }, { storeRoot: path.join(dir, 'store') });
  t.after(() => restarted.store.close());
  await restarted.ready;
  assert.equal(restarted.store.index.size, trace.store.index.size, 'index rebuilt from authoritative events at startup');

  // No ref given: the error text alone locates the event, then expands to exact bytes.
  const byError = await restarted.find({ text: 'EIO writing sector', type: 'tool.after' });
  assert.equal(byError.results.length, 1);
  assert.equal(byError.results[0].ref, marked.ref);
  const exact = await restarted.store.expand(byError.results[0].payload_ref);
  assert.ok(exact.exact_utf8.includes('fatal EIO writing sector on /dev/target'));
  assert.equal(exact.sha256, marked.payload.sha256);

  // Path clue and a note outside the 64-item projection window.
  const byPath = await restarted.find({ path: 'f7.txt' });
  assert.equal(byPath.results.length, 1);
  assert.ok(byPath.results[0].source.filePath.endsWith('f7.txt'));
  const byNote = await restarted.find({ text: 'XID43', type: 'trace.note' });
  assert.equal(byNote.results.length, 1);
  const notePayload = await restarted.store.expand(byNote.results[0].payload_ref);
  assert.equal(JSON.parse(notePayload.exact_utf8).text, 'flaky XID43 report on queue');
  // Coverage reports what the derived index actually covers.
  assert.ok(byError.coverage.indexed_events >= 2471, 'every ingested event is indexed, not just the recent window');
  assert.equal(byError.coverage.note.includes('rebuilt'), true);
}, { timeout: 180000 });

test('P2: deep scan finds marker beyond the hint prefix with exact byte coordinates, resumable cursor exhausts history', async t => {
  const { trace } = await fixture(t);
  const padding = 'P'.repeat(24000);
  const buried = await trace.after({ ...host('s1', 'buried'), tool: 'read', input: { filePath: 'big.log' }, status: 'completed', result: { content: [{ type: 'text', text: `${padding}NEEDLE-at-the-end` }] } });
  // Hint prefix (8KB) does not contain the needle: index mode finds nothing.
  const hintMiss = await trace.find({ text: 'NEEDLE-at-the-end' });
  assert.equal(hintMiss.results.length, 0);
  // Deep scan reads exact blob bytes under a budget. The needle exists in two
  // authoritative blobs (the event payload envelope and the exact output text),
  // so two independently verifiable hits are expected.
  const deep = await trace.find({ text: 'NEEDLE-at-the-end', deep: true });
  assert.equal(deep.hits.length, 2);
  for (const hit of deep.hits) assert.ok(hit.byte_offset > 8192, 'needle sits beyond the indexed hint prefix');
  const outHit = deep.hits.find(h => h.blob_ref === buried.outputs[0].ref);
  assert.ok(outHit, 'the exact output text blob is among the hits');
  assert.equal(deep.coverage.deep_scan.exhausted_history, true, 'small corpus: the scan is definitive');
  // The coordinates resolve to the exact original bytes via trace_expand.
  const page = await trace.store.expand(outHit.blob_ref, outHit.byte_offset, 64);
  assert.equal(page.exact_utf8, 'NEEDLE-at-the-end');
  assert.equal(page.sha256, buried.outputs[0].sha256);
  // Small budget: the first deep page cannot finish, so a resumable cursor is
  // returned; continuing pages reach exhaustion without duplicates or gaps.
  const first = await trace.find({ text: 'NEEDLE-at-the-end', deep: true, deep_budget_bytes: 8192 });
  assert.equal(first.coverage.deep_scan.exhausted_history, false);
  assert.ok(first.next_cursor, 'budget-bounded scan returns a resumable cursor');
  const seen = first.hits.map(h => `${h.blob_ref.slice(0, 20)}:${h.byte_offset}`);
  let cursor = first.next_cursor, exhausted = false, guard = 0;
  while (cursor && guard++ < 20) {
    const page = await trace.find({ text: 'NEEDLE-at-the-end', deep: true, deep_budget_bytes: 8192, cursor });
    for (const h of page.hits) seen.push(`${h.blob_ref.slice(0, 20)}:${h.byte_offset}`);
    exhausted = page.coverage.deep_scan.exhausted_history;
    cursor = page.next_cursor;
  }
  assert.ok(exhausted, 'pagination reaches definitive exhaustion');
  assert.equal(new Set(seen).size, seen.length, 'no duplicate coordinates across pages');
  assert.equal(seen.length, 2, 'both authoritative blobs are found across pages');
  // A mismatched cursor is rejected rather than silently re-scanned.
  await assert.rejects(trace.find({ text: 'unrelated', deep: true, cursor: first.next_cursor }), /Cursor does not match/);
});

test('P2: unified relations are discoverable forward and in reverse across note, intent and advisory events', async t => {
  const { trace, store, dir } = await fixture(t);
  const evidence = await trace.after({ ...host('s1', 'ev'), tool: 'read', input: { filePath: 'doc' }, status: 'completed', result: { content: [{ type: 'text', text: 'original evidence' }] } });
  const superseded = await trace.note({ kind: 'unresolved', text: 'Question', source_refs: [evidence.ref] }, host('s1', 'q1'));
  const correction = await trace.note({ kind: 'correction', text: 'Resolved', source_refs: [evidence.ref], supersedes: [superseded.ref], depends_on: [evidence.ref] }, host('s1', 'q2'));
  const declared = await trace.intent({ summary: 'Change doc', paths: ['doc'], status: 'active', related_refs: [evidence.ref] }, host('s2'));
  await trace.before({ ...host('s3'), tool: 'edit', input: { filePath: path.join(dir, 'doc') } });
  // Forward: correction exposes source/supersedes/depends_on exactly as recorded.
  const expanded = await store.expand(correction.ref);
  for (const r of [superseded.ref, evidence.ref]) assert.ok(expanded.related_refs.includes(r), `relation ${r.slice(0, 16)} listed`);
  // The evidence event's own expansion lists its exact output bytes.
  const evidenceExpanded = await store.expand(evidence.ref);
  assert.ok(evidenceExpanded.related_refs.includes(evidence.outputs[0].ref));
  // Reverse: everything referencing the evidence event is discoverable without refs of its own.
  const reverse = await trace.find({ related: evidence.ref, limit: 100 });
  const refs = reverse.results.map(r => r.ref);
  for (const expected of [superseded.ref, correction.ref]) assert.ok(refs.includes(expected), 'notes referencing the evidence are found');
  assert.ok(reverse.results.some(r => r.type === 'trace.intent'), 'intent related_refs are indexed');
  // The advisory records the conflict between the intent and the late edit;
  // its payload source_refs are indexed and visible in both directions.
  const byIntent = await trace.find({ related: declared.ref, limit: 100 });
  const advisory = byIntent.results.find(r => r.type === 'coordination.advisory');
  assert.ok(advisory, 'advisory is discoverable from its intent relation');
  assert.ok((await store.expand(advisory.ref)).related_refs.includes(declared.ref));
});

test('P2: cursor pagination is stable and duplicate-free until exhaustion', async t => {
  const { trace } = await fixture(t);
  const made = [];
  for (let i = 0; i < 12; i++) made.push((await trace.note({ kind: 'finding', text: `paginated ${i}`, source_refs: [] }, host('s1', `p${i}`))).ref);
  let cursor = null;
  const seen = [];
  for (let page = 0; page < 10; page++) {
    const out = await trace.find({ type: 'trace.note', limit: 5, cursor });
    for (const r of out.results) seen.push(r.ref);
    if (!out.next_cursor) break;
    cursor = out.next_cursor;
  }
  assert.equal(seen.length, 12, 'all notes retrieved across pages');
  assert.equal(new Set(seen).size, 12, 'no duplicates across pages');
  assert.deepEqual(seen.sort(), made.sort());
  // A mismatched cursor is rejected rather than silently re-scanned.
  await assert.rejects(trace.find({ type: 'trace.note', cursor: Buffer.from('{"q":"zzz","deep":false,"at":1,"ref":"x"}').toString('base64url') }), /Cursor does not match/);
});

test('P5.1: deep scan is chunk-bounded - a huge blob cannot bypass the byte budget', async t => {
  const { trace } = await fixture(t);
  // A 3 MiB output with the needle near the end; the budget is 2 MiB.
  const padding = 'Q'.repeat(3 * 1024 * 1024);
  await trace.after({ ...host('s1', 'huge'), tool: 'read', input: { filePath: 'huge.log' }, status: 'completed', result: { content: [{ type: 'text', text: `${padding}CHUNKED-NEEDLE-END` }] } });
  const page1 = await trace.find({ text: 'CHUNKED-NEEDLE-END', deep: true, deep_budget_bytes: 2 * 1024 * 1024 });
  assert.equal(page1.hits.length, 0, 'the needle sits beyond the first budget window');
  assert.ok(page1.coverage.deep_scan.scanned_bytes <= 2 * 1024 * 1024 + 262200, 'overrun is bounded by one chunk, never the whole blob');
  assert.equal(page1.coverage.deep_scan.exhausted_history, false);
  assert.ok(page1.next_cursor, 'a byte-precise resume cursor is returned');
  const page2 = await trace.find({ text: 'CHUNKED-NEEDLE-END', deep: true, deep_budget_bytes: 2 * 1024 * 1024, cursor: page1.next_cursor });
  assert.ok(page2.hits.length >= 1, 'the needle is found after resuming at the byte cursor');
  assert.ok(page2.hits[0].byte_offset > 2 * 1024 * 1024, 'the offset proves the deep position was reached');
  // Exact recovery still hash-verifies through trace_expand.
  const exact = await trace.store.expand(page2.hits[0].blob_ref, page2.hits[0].byte_offset, 64);
  assert.ok(exact.exact_utf8.startsWith('CHUNKED-NEEDLE-END'), 'exact bytes at the reported offset');
  assert.ok(page2.coverage.deep_scan.scanned_bytes <= 2 * 1024 * 1024 + 262200, 'second page stays chunk-bounded too');
});

test('P5.2: deep cursor stores the consumed prefix - no byte range falls between two pages', async t => {
  const { trace } = await fixture(t);
  const NEEDLE = 'GAPNEEDLE2097152';
  // Probe: the payload embeds the content text after a fixed JSON prefix.
  // Measure that prefix so the main event places the payload-blob needle
  // exactly inside the forbidden gap [logical consumed, old physical cursor).
  const probe = await trace.after({ ...host('s1', 'prb1'), tool: 'read', input: { filePath: 'prb.log' }, status: 'completed', result: { content: [{ type: 'text', text: `PREFIXPROBE-TOP${'Z'.repeat(5000)}` }] } });
  const locate = async (ref, needleText) => {
    const needle = Buffer.from(needleText, 'utf8');
    let pos = 0, carry = Buffer.alloc(0), carryStart = 0;
    for (;;) {
      const { chunk, read } = await trace.store.readBlobRange(ref, pos, 262144);
      if (read <= 0) return -1;
      const window = Buffer.concat([carry, chunk.subarray(0, read)]);
      const at = window.indexOf(needle);
      if (at >= 0) return carryStart + at;
      carryStart = pos + read - (needle.length - 1);
      carry = window.subarray(window.length - (needle.length - 1));
      pos += read;
    }
  };
  const prefix = await locate(probe.payload.ref, 'PREFIXPROBE-TOP');
  assert.ok(prefix > 0 && prefix < 4096, `payload prefix measured (${prefix})`);
  // The needle lands at exactly 2097200 in the payload blob: inside the gap
  // [2097152, 2097272) that a cursor storing physical read bytes would skip.
  const textOffset = 2097200 - prefix;
  const giant = 'X'.repeat(textOffset) + NEEDLE + 'Y'.repeat(200000);
  const main = await trace.after({ ...host('s1', 'gap1'), tool: 'read', input: { filePath: 'gap.log' }, status: 'completed', result: { content: [{ type: 'text', text: giant }] } });
  const payloadOffset = await locate(main.payload.ref, NEEDLE);
  const budget = 2 * 1024 * 1024;
  assert.equal(payloadOffset, 2097200, 'payload needle sits exactly at the boundary regression point');
  assert.ok(payloadOffset >= budget && payloadOffset + NEEDLE.length <= budget + DEEP_CHUNK_BYTES, 'needle inside the consumed/physical gap region');
  const page1 = await trace.find({ text: NEEDLE, deep: true, deep_budget_bytes: budget });
  assert.equal(page1.hits.length, 0, 'page 1 legitimately misses: the needle starts past the last full window');
  const decoded = JSON.parse(Buffer.from(page1.next_cursor, 'base64url').toString('utf8'));
  assert.equal(decoded.skip[0].bytes, budget, 'the cursor stores the CONSUMED prefix, not physical read bytes');
  const page2 = await trace.find({ text: NEEDLE, deep: true, deep_budget_bytes: budget, cursor: page1.next_cursor });
  const payloadHit = page2.hits.find(h => h.blob_ref === main.payload.ref);
  const outputHit = page2.hits.find(h => h.blob_ref === main.outputs[0].ref);
  assert.ok(payloadHit, 'the gap-resident needle is found on page 2');
  assert.ok(outputHit, 'the same needle in the exact output blob is found too');
  assert.equal(payloadHit.byte_offset, 2097200, 'exact byte offset');
  assert.equal(outputHit.byte_offset, textOffset, 'the raw text blob has no JSON prefix');
  for (const hit of [payloadHit, outputHit]) {
    const exact = await trace.store.expand(hit.blob_ref, hit.byte_offset, NEEDLE.length);
    assert.equal(exact.exact_utf8, NEEDLE);
    assert.equal(exact.sha256, hit.blob_ref === main.payload.ref ? main.payload.sha256 : main.outputs[0].sha256, 'full blob hash verified');
  }
}, { timeout: 120000 });

test('P5.3: explicit source/binding/result relations and plan/step/worker/attempt addressing are index-discoverable', async t => {
  const { trace } = await fixture(t);
  const evidence = await trace.after({ ...host('s1', 'ev'), tool: 'read', input: { filePath: 'doc' }, status: 'completed', result: { content: [{ type: 'text', text: 'parser regression evidence' }] } });
  trace.store.session('s2');
  // Original evidence -> proposal message (explicit source_refs).
  const mail = await trace.send({ to: ['s2'], text: 'findings attached for verification', type: 'proposal', source_refs: [evidence.ref] }, host('s1', 'm1'));
  const mailEventRef = trace.store.findEntries({ type: 'trace.message', message: mail.message_id }, null, 1)[0].ref;
  // Synthetic plan attempt: started binding -> worker result -> settled step.
  const planId = `plan_${'a'.repeat(24)}`, attemptId = 'attempt-p53-00000001';
  const started = await trace.store.record('trace.step', host('s1', 'st'), {
    plan_id: planId, version: 1, step: 'verify', state: 'started', sessionID: 's2', attempt_id: attemptId, native: 'synthetic fixture',
  }, { plan_id: planId, step: 'verify', worker: 's2' });
  const workerResult = await trace.store.record('trace.step.result', { sessionID: 's2' }, {
    plan_id: planId, version: 1, step: 'verify', attempt_id: attemptId, worker_session: 's2', binding_ref: started.ref,
    status: 'success', summary: 'verified against the recorded message evidence', source_refs: [mailEventRef], by: 's2',
  }, { plan_id: planId, step: 'verify' });
  const settled = await trace.store.record('trace.step', host('s1', 'se'), {
    plan_id: planId, version: 1, step: 'verify', state: 'settled', outcome: 'worker_reported_success', sessionID: 's2', attempt_id: attemptId,
    result_ref: workerResult.ref, worker_source_refs: [mailEventRef],
  }, { plan_id: planId, step: 'verify' });
  // The worker replies in the thread (message-id relation).
  const reply = await trace.store.record('trace.message', { sessionID: 's2' }, {
    message_id: `msgx_${'b'.repeat(32)}`, thread_id: mail.thread_id, from: 's2', recipients: ['s1'], type: 'note',
    in_reply_to: mail.message_id, proposal: null, content_ref: (await trace.store.blob('acknowledged', 'utf8')).ref, bytes: 11, source_refs: [],
  }, { message_id: `msgx_${'b'.repeat(32)}`, thread_id: mail.thread_id, recipients: ['s1'], reply_to: mail.message_id });
  const types = async f => (await trace.find({ ...f, limit: 100 })).results.map(r => r.type);
  // Forward chain: evidence -> message -> worker result -> settled step.
  assert.ok((await types({ related: evidence.ref })).includes('trace.message'), 'message citing the evidence is discoverable');
  const fromMail = await types({ related: mailEventRef });
  assert.ok(fromMail.includes('trace.step.result'), 'worker result citing the message is discoverable');
  assert.ok(fromMail.includes('trace.message'), 'the thread reply resolves through the message-id relation');
  assert.deepEqual((await types({ related: workerResult.ref })).filter(x => x === 'trace.step'), ['trace.step'], 'settled step links back to its worker result');
  // Convenience views carry the same explicit relations.
  const expandedResult = await trace.store.expand(workerResult.ref);
  for (const r of [started.ref, mailEventRef]) assert.ok(expandedResult.related_refs.includes(r), `result expansion lists binding/source ${r.slice(0, 12)}`);
  const expandedSettled = await trace.store.expand(settled.ref);
  assert.ok(expandedSettled.related_refs.includes(workerResult.ref), 'settled expansion lists result_ref');
  const expandedMail = await trace.store.expand(mailEventRef);
  assert.ok(expandedMail.related_refs.includes(evidence.ref), 'message expansion lists its source refs');
  const expandedReply = await trace.store.expand(reply.ref);
  assert.ok(expandedReply.related_refs.includes(mailEventRef), 'reply expansion resolves in_reply_to to the parent event ref');
  // Structured addressing without any text clue.
  assert.deepEqual(await types({ plan: planId, step: 'verify' }), ['trace.step', 'trace.step.result', 'trace.step']);
  assert.deepEqual(await types({ worker: 's2', attempt_id: attemptId }), ['trace.step', 'trace.step.result', 'trace.step']);
  assert.deepEqual(await types({ attempt_id: attemptId, type: 'trace.step.result' }), ['trace.step.result']);
});

test('P5.2: a needle straddling a chunk boundary is found exactly once per blob', async t => {
  const { trace } = await fixture(t);
  const BOUNDARY = 'BOUNDARY-NEEDLE';
  const padded = 'A'.repeat(262130) + BOUNDARY + 'B'.repeat(1000);
  const made = await trace.after({ ...host('s1', 'edge'), tool: 'read', input: { filePath: 'edge.log' }, status: 'completed', result: { content: [{ type: 'text', text: padded }] } });
  const deep = await trace.find({ text: BOUNDARY, deep: true });
  const outHits = deep.hits.filter(h => h.blob_ref === made.outputs[0].ref);
  assert.equal(outHits.length, 1, 'overlap windows must not duplicate or drop a boundary-straddling match');
  assert.equal(outHits[0].byte_offset, 262130);
  const exact = await trace.store.expand(outHits[0].blob_ref, outHits[0].byte_offset, BOUNDARY.length);
  assert.equal(exact.exact_utf8, BOUNDARY);
  assert.equal(exact.sha256, made.outputs[0].sha256);
});

test('P2: index distinguishes no-result from catch-up; store failure degrades find without blocking tools', async t => {
  const { trace } = await fixture(t);
  const none = await trace.find({ text: 'never-recorded-clue' });
  assert.equal(none.results.length, 0);
  assert.ok(none.coverage.indexed_events >= 0);
  assert.equal(none.next_cursor, null);
  // Broken store: find fails loudly, native tool path stays unaffected.
  await fs.writeFile(path.join(trace.store.root, 'state', 'x'), 'ok');
  const broken = new Trace({ location: { directory: '/dev/null/nonexistent' } }, { storeRoot: '/dev/null/not-a-dir' });
  t.after(() => broken.store.close?.());
  await assert.rejects(broken.find({ text: 'x' }));
});
