import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Trace } from '../src/trace.js';
import { Store } from '../src/store.js';
import { CaptureCoordinator } from '../src/capture.js';
import { effectiveClaimStatus } from '../src/claims.js';

test('legacy model receipts cannot regain execution authority on read', () => {
  assert.equal(effectiveClaimStatus({ claim_status: 'VERIFIED_MECHANICAL', evidence: { kind: 'check_receipt' } }), 'CLAIMED');
  assert.equal(effectiveClaimStatus({ claim_status: 'UNKNOWN', evidence: { kind: 'declaration' } }), 'UNKNOWN');
});

test('duplicate, unknown and stale acknowledgements do not inflate capture coverage', () => {
  const capture = new CaptureCoordinator({});
  capture.paused = true;
  capture.inFlight.set('a', { bytes: 100, session: 's1', body: { session_seq: 7 } });
  capture.queueBytes = 100;
  const ack = { type: 'ack', ids: ['a', 'a', 'unknown'], persisted: { s1: 900, other: 900 }, indexed: 3 };
  capture.onWorkerMessage(ack, () => false);
  assert.equal(capture.persistedEventCount, 0);
  capture.onWorkerMessage(ack, () => true);
  capture.onWorkerMessage(ack, () => true);
  assert.equal(capture.persistedEventCount, 1);
  assert.equal(capture.indexedEventCount, 1);
  assert.equal(capture.queueBytes, 0);
  assert.equal(capture.lastPersisted.get('s1'), 7);
  assert.equal(capture.lastPersisted.has('other'), false);
});

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-architecture-'));
  const trace = new Trace({ location: { directory: dir } }, { storeRoot: path.join(dir, 'store') });
  await trace.ready;
  const stores = [trace.store];
  t.after(async () => {
    for (const store of stores) await store.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });
  return { trace, async reopen() {
    await stores.at(-1).close();
    const store = await new Store(dir, path.join(dir, 'store')).init();
    stores.push(store);
    return store;
  } };
}

test('well-formed model receipt with matching CAS bytes is still an unverified claim', async t => {
  const { trace } = await fixture(t);
  const output = await trace.store.blob('model-generated assertion: every test passed');
  const receipt = {
    checkID: `chk_${'a'.repeat(32)}`, kind: 'test', status: 'passed',
    commandExitCode: 0, timedOut: false, signal: 'none',
    candidate: { commit: 'b'.repeat(64) },
    output: { ref: output.ref, sha256: output.sha256, bytes: output.bytes },
    verified: true, source: 'host',
  };
  const result = await trace.recordClaim({ subject: 'all tests passed', receipt },
    { sessionID: 'worker', messageID: 'm1', id: 'c1', agent: 'build' });
  assert.equal(result.claim.status, 'CLAIMED');
  assert.equal(result.claim.review_effect, 'none');
  const event = trace.store.findEntriesAll({ type: 'trace.claim' })[0];
  const persisted = JSON.parse(await trace.store.readBlob(event.payloadRef));
  assert.equal(persisted.claim_status, 'CLAIMED');
  assert.equal(persisted.evidence.receipt.output.sha256, output.sha256);
});

test('unknown-extent observer loss stays incomplete in aggregate and after restart', async t => {
  const f = await fixture(t);
  f.trace.store.coverage.noteGap({ reason: 'observer_drop', component: 'observer' });
  await f.trace.store.coverage.flushPending();
  assert.equal(f.trace.store.coverage.status().status, 'incomplete');
  assert.equal(f.trace.store.coverage.statusFor('worker').workspace_global.known_gaps, 1);
  const reopened = await f.reopen();
  assert.equal(reopened.coverage.status().status, 'incomplete');
  assert.equal(reopened.coverage.statusFor('worker').workspace_global.known_gaps, 1);
  await reopened.coverage.reconcileWatcherGaps();
  assert.equal(reopened.coverage.status().status, 'incomplete', 'an index scan cannot recover unobserved content');
});

test('a complete range reconciliation remains complete after replay', async t => {
  const f = await fixture(t);
  const coverage = f.trace.store.coverage;
  coverage.noteGap({ session: 'worker', from_seq: 3, to_seq: 4, reason: 'capture_gap' });
  await coverage.flushPending();
  await coverage.noteReconciled('worker', 3);
  await coverage.noteReconciled('worker', 4);
  assert.equal(coverage.statusFor('worker').session_coverage.known_gaps, 0);
  const reopened = await f.reopen();
  assert.equal(reopened.coverage.statusFor('worker').session_coverage.known_gaps, 0);
});
