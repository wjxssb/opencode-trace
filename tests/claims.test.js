// Phase F qualification: typed provenance claims (directive §12.10 F1-F12).
// Trust hierarchy: host CheckReceipt = mechanical evidence; reviewer/model
// prose = interpretation; trace.claim events = durable provenance projection.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Trace } from '../src/trace.js';
import { Store } from '../src/store.js';
import { claimFromProse, claimFromReceipt, claimStaleness, validateReceipt, CLAIM_STATUSES } from '../src/claims.js';
import { definitions } from '../src/tools.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-trace-claim-'));
  const trace = new Trace({ location: { directory: dir } }, { storeRoot: path.join(dir, 'store') });
  await trace.ready;
  t.after(async () => { await trace.store.close(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); });
  return { dir, trace, store: trace.store };
}
const host = (sessionID = 's1') => ({ sessionID, messageID: 'm1', id: 'c1', agent: 'build' });

const COMMIT_A = 'a'.repeat(64);
const COMMIT_B = 'b'.repeat(64);
const validReceipt = (commit = COMMIT_A, commandExitCode = 0) => ({
  checkID: `chk_${'1'.repeat(32)}`,
  kind: 'test',
  status: 'passed',
  commandExitCode,
  timedOut: false,
  signal: 'none',
  candidate: { commit, branch: 'candidate/v2-bcde-wip' },
  output: { sha256: 'c'.repeat(64) },
});

test('F0: status taxonomy is exactly the five conservative statuses', () => {
  assert.deepEqual([...CLAIM_STATUSES], ['CLAIMED', 'SUPPORTED', 'VERIFIED_MECHANICAL', 'CONTRADICTED', 'UNKNOWN']);
});

test('F1: prose "tests passed" without a receipt -> CLAIMED (never mechanical)', async t => {
  const { trace } = await fixture(t);
  const { claim } = await trace.recordClaim({ subject: 'tests passed', text: 'tests passed' }, host());
  assert.equal(claim.status, 'CLAIMED');
  assert.equal(claim.evidence.kind, 'model_prose');
  assert.match(claim.meaning, /never mechanical verification/);
});

test('F2: a valid CheckReceipt binds a NARROW VERIFIED_MECHANICAL (never implementation correctness)', async t => {
  const { trace } = await fixture(t);
  const { claim } = await trace.recordClaim({ subject: 'tests passed', scope: 'test_command_completed', receipt: validReceipt() }, host());
  assert.equal(claim.status, 'VERIFIED_MECHANICAL');
  assert.equal(claim.evidence.kind, 'check_receipt');
  assert.equal(claim.evidence.receipt.commandExitCode, 0);
  assert.match(claim.meaning, /host-measured only/);
  assert.match(claim.meaning, /never implementation correctness/);
  // The durable event carries the receipt verbatim for audit.
  const rows = trace.store.findEntriesAll({ type: 'trace.claim' });
  assert.equal(rows.length, 1);
  const payload = JSON.parse(await trace.store.readBlob(rows[0].payloadRef));
  assert.equal(payload.claim_status, 'VERIFIED_MECHANICAL');
  assert.equal(payload.evidence.receipt.checkID, validReceipt().checkID);
});

test('F3: nonzero exit contradicts a pass claim (mechanical evidence wins, contradiction visible)', async t => {
  const { trace } = await fixture(t);
  const { claim } = await trace.recordClaim({ subject: 'tests passed', receipt: validReceipt(COMMIT_A, 1) }, host());
  assert.equal(claim.status, 'CONTRADICTED');
  assert.match(claim.meaning, /contradicts the claimed success/);
  const timedOut = { ...validReceipt(), timedOut: true };
  const { claim: c2 } = await trace.recordClaim({ subject: 'tests passed', receipt: timedOut }, host());
  assert.equal(c2.status, 'CONTRADICTED');
});

test('F4: forged stdout / fake receipt JSON cannot verify', async t => {
  const { trace } = await fixture(t);
  // Prose that LOOKS like a receipt is still prose -> CLAIMED.
  const fake = JSON.stringify({ checkID: `chk_${'f'.repeat(32)}`, kind: 'test', status: 'passed', commandExitCode: 0, timedOut: false, signal: 'none', candidate: { commit: COMMIT_A }, output: { sha256: 'd'.repeat(64) } });
  const { claim } = await trace.recordClaim({ subject: 'tests passed', text: `verification: ${fake}` }, host());
  assert.equal(claim.status, 'CLAIMED');
  // The binding API is structurally strict: malformed receipts reject.
  assert.throws(() => validateReceipt('tests passed'), TypeError);
  assert.throws(() => validateReceipt({ checkID: 'nope', kind: 'test', status: 'passed', commandExitCode: 0, timedOut: false, signal: 'none', candidate: { commit: COMMIT_A }, output: { sha256: 'd'.repeat(64) } }), TypeError);
  assert.throws(() => claimFromReceipt({ subject: 'x', receipt: null }), TypeError);
  assert.throws(() => claimFromReceipt({ subject: 'x', receipt: { ...validReceipt(), candidate: { commit: 'short' } } }), TypeError);
});

test('F5: a candidate-A receipt stays historical for A and cannot justify candidate B', async t => {
  const { trace } = await fixture(t);
  const { claim } = await trace.recordClaim({ subject: 'tests passed', receipt: validReceipt(COMMIT_A) }, host());
  assert.equal(claim.status, 'VERIFIED_MECHANICAL');
  const stale = claimStaleness(claim, { commit: COMMIT_B });
  assert.equal(stale.stale, true, 'candidate changed: receipt is stale for B');
  assert.equal(stale.applies_to.commit, COMMIT_A, 'the receipt remains bound to candidate A');
  // Same candidate: not stale. Persisted status is never rewritten either way.
  assert.equal(claimStaleness(claim, { commit: COMMIT_A }).stale, false);
  assert.equal(claim.status, 'VERIFIED_MECHANICAL');
});

test('F6: restart preserves typed claims (durable CAS events)', async t => {
  const { trace, dir } = await fixture(t);
  const { ref } = await trace.recordClaim({ subject: 'tests passed', scope: 'test_command_completed', receipt: validReceipt() }, host());
  trace.store.close();
  const store2 = await new Store(path.join(dir), path.join(dir, 'store')).init();
  try {
    const rows = store2.findEntriesAll({ type: 'trace.claim' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ref, ref);
    const payload = JSON.parse(await store2.readBlob(rows[0].payloadRef));
    assert.equal(payload.claim_status, 'VERIFIED_MECHANICAL');
    assert.equal(payload.evidence.receipt.candidate.commit, COMMIT_A);
  } finally { store2.close(); }
});

test('F7: durable canonical evidence refs (raw output as CAS blob, hash-verified)', async t => {
  const { trace } = await fixture(t);
  const output = 'AUTHORITATIVE_RC=0\n# tests 259\n# pass 258\n';
  const stored = await trace.store.blob(output, 'utf8');
  const receipt = { ...validReceipt(), output: { sha256: stored.sha256, ref: stored.ref, bytes: stored.bytes } };
  const { claim } = await trace.recordClaim({ subject: 'tests passed', receipt }, host());
  assert.equal(claim.evidence.receipt.output.ref, stored.ref);
  // The canonical blob resolves and hash-verifies independently of the claim.
  const back = await trace.store.readBlob(stored.ref);
  assert.equal(back.toString('utf8'), output);
});

test('F8: claim status and capture coverage are independent dimensions', async t => {
  const { trace, store } = await fixture(t);
  // Create real capture loss so coverage is honestly incomplete.
  await store.record('probe.a', { sessionID: 's1' }, { i: 1 });
  const payload = await store.blob({ craft: true });
  const full = { schema: 1, workspaceID: store.workspaceID, type: 'probe.craft', host: { sessionID: 's1' }, payload: { ref: payload.ref, bytes: payload.bytes, encoding: 'json', sha256: payload.sha256 }, event_schema: 2, session_seq: 9 };
  const { atomic, hash, stable } = await import('../src/util.js');
  const event = { ...full, ref: `evt_${hash(stable(full))}`, at: Date.now() };
  await atomic(path.join(store.root, 'events', `${event.ref}.json`), stable(event), true);
  await store.ingest(event);
  await store.coverage.flushPending();
  assert.equal(store.coverage.statusFor('s1').session_coverage.status, 'incomplete');
  // A mechanical claim is still mechanical while capture coverage is incomplete.
  const { claim } = await trace.recordClaim({ subject: 'tests passed', receipt: validReceipt() }, host());
  assert.equal(claim.status, 'VERIFIED_MECHANICAL');
  const rows = store.findEntriesAll({ type: 'trace.claim' });
  const payload2 = JSON.parse(await store.readBlob(rows[0].payloadRef));
  assert.equal(payload2.capture_coverage.session_coverage.status, 'incomplete', 'incomplete capture coverage stays visible on the claim');
  assert.equal(payload2.claim_status, 'VERIFIED_MECHANICAL', 'mechanical status independent of coverage');
});

test('F9+F10: claims never approve reviews, never clear obligations, never override needs_context', async t => {
  const { trace } = await fixture(t);
  const { claim } = await trace.recordClaim({ subject: 'tests passed', receipt: validReceipt() }, host());
  assert.equal(claim.review_effect, 'none');
  assert.match(claim.semantics, /never approve reviews or clear review obligations/);
  // The durable payload carries the same no-effect marker.
  const rows = trace.store.findEntriesAll({ type: 'trace.claim' });
  const payload = JSON.parse(await trace.store.readBlob(rows[0].payloadRef));
  assert.equal(payload.review_effect, 'none');
});

test('F11: the read surface distinguishes model assertions from mechanical facts', async t => {
  const { trace } = await fixture(t);
  const prose = await trace.recordClaim({ subject: 'tests passed', text: 'tests passed' }, host());
  const mech = await trace.recordClaim({ subject: 'tests passed', receipt: validReceipt() }, host());
  assert.notEqual(prose.claim.status, mech.claim.status);
  assert.match(prose.claim.meaning, /declaration/);
  assert.match(mech.claim.meaning, /host-measured only/);
  // Tool path exposes the same distinction with the required receipt fields.
  const tool = definitions(trace).find(d => d.name === 'trace_claim');
  const out = await tool.execute({ subject: 'search works', text: 'search works, I saw hits' }, host());
  assert.equal(out.metadata.raw.claim.status, 'CLAIMED');
});

test('F12: superseding a claim preserves the full superseded evidence history', async t => {
  const { trace } = await fixture(t);
  const first = await trace.recordClaim({ subject: 'tests passed', text: 'looked green to me' }, host());
  const second = await trace.recordClaim({
    subject: 'tests passed', scope: 'test_command_completed',
    receipt: validReceipt(), supersedes: [first.ref],
  }, host());
  assert.deepEqual(second.claim.supersedes, [first.ref]);
  // BOTH claims remain readable: history is additive, never rewritten.
  const rows = trace.store.findEntriesAll({ type: 'trace.claim' });
  assert.equal(rows.length, 2);
  const payloads = [];
  for (const r of rows) payloads.push(JSON.parse(await trace.store.readBlob(r.payloadRef)));
  assert.ok(payloads.some(p => p.claim_status === 'CLAIMED'), 'superseded prose claim still retrievable');
  assert.ok(payloads.some(p => p.claim_status === 'VERIFIED_MECHANICAL'), 'superseding receipt claim retrievable');
});

test('F-tool: trace_claim_receipt rejects malformed receipts through the tool surface', async t => {
  const { trace } = await fixture(t);
  const tool = definitions(trace).find(d => d.name === 'trace_claim_receipt');
  const out = await tool.execute({ subject: 'tests passed', receipt: { checkID: 'bogus' } }, host());
  assert.equal(out.metadata.raw.ok, false, 'malformed receipt is rejected, never downgraded to CLAIMED-as-verified');
  assert.equal(trace.store.findEntriesAll({ type: 'trace.claim' }).length, 0, 'no claim event is persisted for a rejected binding');
});
