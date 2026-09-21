// Phase G: non-blocking capture coordinator (host side), V3 S6 port.
//
// Consumes the V3 canonical boundary: the job's identity fields arrive
// already gateway-normalized (handles resolved, finalization sets expanded), and
// the coordinator re-validates them positively as canonical refs BEFORE
// queue admission. Anything handle-shaped, token-shaped or malformed is
// rejected before a sequence number is consumed — NOTHING unresolved enters
// G. This module never imports the handle registry and never matches handle/token
// vocabulary (see the §13 dependency test); it only knows canonical refs.
//
// Host critical path: validate canonical -> allocate session sequence AT
// ENQUEUE through the durable per-session allocator -> build the
// CanonicalCaptureEnvelopeV1 in memory -> validate the envelope -> queue or
// record the exact loss -> return. Loss accounting is EXACT: an envelope
// lost to overflow or writer death has a known session_seq.
//
// Failure domain: the writer is a worker thread (src/capture-worker.js) that
// owns persistence and the derived index (single writer — the host suppresses
// its own index writes while the worker is alive). Writer death never blocks
// the host: in-flight envelopes are recorded as exact losses in a durable
// JSONL ledger OUTSIDE the queue, capture reports degraded, and a new
// generation spawns with backoff. The next writer generation drains the
// ledger into trace.capture_gap markers (reason=queue_overflow); duplicate
// markers are harmless because coverage dedupes by marker key.
//
// No silent loss: every drop path ends in either the ledger (durable,
// outside the queue) or a durable coverage marker — usually both.
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { atomic, refPattern } from './util.js';
import { buildCanonicalEnvelope, assertCanonicalEnvelope } from './canonical-envelope.js';

const MAX_QUEUE = 256;
const MAX_QUEUE_BYTES = 8 * 1024 * 1024;
const BATCH = 32;
const MAX_RESPAWNS = 5;

/**
 * Canonical-only pre-admission gate (§14). Every identity position in the
 * job must hold a full canonical evt_/blob_ ref or be absent. Handle-shaped
 * (e1), token-shaped (cb_), truncated or malformed values throw BEFORE a
 * sequence number is consumed. Payload CONTENT is never scanned (content is
 * evidence, not identity).
 */
export function assertCanonicalJob(job) {
  if (!job || typeof job !== 'object') throw new Error('capture.enqueue: job must be an object');
  if (typeof job.type !== 'string' || !job.type) throw new Error('capture.enqueue: job.type is required');
  const extra = job.extra ?? {};
  for (const f of ['source_refs', 'evidence_refs']) {
    if (extra[f] === undefined) continue;
    if (!Array.isArray(extra[f])) throw new Error(`capture.enqueue: ${f} must be an array of canonical refs`);
    for (let i = 0; i < extra[f].length; i++) {
      if (!refPattern.test(extra[f][i])) {
        throw new Error(`capture.enqueue: ${f}[${i}] ${JSON.stringify(String(extra[f][i]).slice(0, 40))} is not a canonical evt_/blob_ ref — unresolved identities never enter G`);
      }
    }
  }
  for (const f of ['caused_by', 'candidate_binding', 'claim_binding']) {
    if (extra[f] !== undefined && extra[f] !== null && !refPattern.test(extra[f])) {
      throw new Error(`capture.enqueue: ${f} ${JSON.stringify(String(extra[f]).slice(0, 40))} is not a canonical evt_/blob_ ref — unresolved identities never enter G`);
    }
  }
  for (const [i, o] of (extra.outputs ?? []).entries()) {
    if (!o || typeof o !== 'object' || !refPattern.test(o.ref)) {
      throw new Error(`capture.enqueue: outputs[${i}].ref is not a canonical blob ref — unresolved identities never enter G`);
    }
  }
  for (const [i, b] of (job.blobs ?? []).entries()) {
    if (!b || typeof b !== 'object' || !refPattern.test(b.ref)) {
      throw new Error(`capture.enqueue: blobs[${i}].ref is not a canonical blob ref — unresolved identities never enter G`);
    }
  }
  return true;
}

export class CaptureCoordinator {
  constructor(trace, options = {}) {
    this.trace = trace;
    this.queueCap = Number(options.captureQueueCap) > 0 ? Number(options.captureQueueCap) : MAX_QUEUE;
    this.queue = [];
    this.queueBytes = 0;
    this.inFlight = new Map();   // env_id -> envelope (posted, not yet acked)
    this.lastEnqueued = new Map(); // session -> seq (allocation-time watermark)
    this.lastPersisted = new Map(); // session -> seq (worker acks)
    this.lastIndexed = 0;
    // S7.5 telemetry (mission §7-§10): counts and sequence watermarks are
    // DISTINCT metrics. persisted/indexed count acked envelopes (the worker
    // ingests on persist, so they advance together per batch); no field is
    // named as a sequence watermark while holding a batch count.
    this.persistedEventCount = 0;
    this.indexedEventCount = 0;
    this.latencies = [];
    this.droppedTotal = 0;
    this.degraded = false;
    this.active = false;
    this.stopped = false;
    this.generation = 1;
    this.respawnAttempts = 0;
    this.respawnDelay = options.captureRespawnDelay; // test hook: deterministic respawn timing
    this.paused = false; // test hook: hold the queue without draining
    this.worker = null;
  }

  ledgerDir() { return path.join(this.trace.store.base, 'capture-ledger'); }

  async start() {
    if (this.stopped) return;
    await fs.mkdir(this.ledgerDir(), { recursive: true, mode: 0o700 });
    // Single index owner: while the writer is alive the host does not
    // write the derived index; the worker's Store owns it.
    this.trace.store.suppressDerivedWrites = true;
    this.spawnWorker();
    this.active = true;
  }

  spawnWorker() {
    // Defensive: a replaced worker that is somehow still alive (manual
    // respawn, double-spawn) must be terminated — an orphaned writer would
    // hold its Store/index handles forever (no orphan sidecar).
    const previous = this.worker;
    if (previous) { try { previous.terminate(); } catch { /* already gone */ } }
    const worker = new Worker(new URL('./capture-worker.js', import.meta.url), {
      workerData: { location: this.trace.store.workspace ?? this.trace.options?.location?.directory,
        storeRoot: this.trace.store.base, generation: this.generation, ledgerDir: this.ledgerDir() },
      // No stdio pipes: a worker terminated during init otherwise leaves
      // parent-side pipe handles behind (lingering event-loop references).
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    });
    this.worker = worker;
    worker.unref();
    // Identity-scoped wiring: after a respawn, messages/exits from a stale
    // generation must be ignored, and death must be detected regardless of
    // exit code (terminate() during worker init exits with code 0).
    const isCurrent = () => this.worker === worker && !this.stopped;
    worker.on('message', message => this.onWorkerMessage(message, isCurrent));
    worker.on('error', () => { if (isCurrent()) this.onWorkerDeath(worker); });
    worker.on('exit', () => { if (isCurrent()) this.onWorkerDeath(worker); });
  }

  onWorkerMessage(message, isCurrent) {
    if (!isCurrent()) return; // stale generation: already handled by the death path
    if (message.type === 'ack') {
      for (const id of message.ids) {
        const env = this.inFlight.get(id);
        if (env) { this.queueBytes -= env.bytes; this.inFlight.delete(id); }
      }
      for (const [session, seq] of Object.entries(message.persisted ?? {})) {
        this.lastPersisted.set(session, Math.max(this.lastPersisted.get(session) ?? 0, seq));
      }
      this.lastIndexed = message.indexed ?? this.lastIndexed;
      this.persistedEventCount += message.ids?.length ?? 0;
      this.indexedEventCount = this.persistedEventCount; // persist + index are one atomic step in the worker
      void this.lastIndexed; // legacy field superseded by the S7.5 counts; kept only to avoid breaking external readers until S8 release
      if (Number.isFinite(message.latencyMs)) {
        this.latencies.push(message.latencyMs);
        if (this.latencies.length > 64) this.latencies.shift();
      }
      this.degraded = false;
      this.respawnAttempts = 0;
      this.drain();
    } else if (message.type === 'fatal') {
      this.trace.warning('capture_writer_fatal', new Error(message.error));
      this.onWorkerDeath(this.worker);
    }
  }

  onWorkerDeath(worker) {
    // Idempotent + identity-scoped: the fatal message and the exit event can
    // both fire; a replaced worker's death never touches a healthy successor.
    if (this.stopped || this.worker !== worker) return;
    this.worker = null;
    // Writer death is loss the host can SEE: every posted-but-unacked
    // envelope has an exact allocated sequence — record it in the durable
    // ledger (outside any queue) and in coverage immediately. Surviving
    // queued envelopes stay in host memory and drain to the successor.
    for (const env of this.inFlight.values()) this.recordLoss(env, 'writer_lost');
    this.inFlight.clear();
    this.degraded = true;
    try { worker.terminate(); } catch { /* already gone */ }
    if (this.respawnAttempts < MAX_RESPAWNS) {
      const base = Number(this.respawnDelay) > 0 ? Number(this.respawnDelay) : 500;
      const delay = Math.min(base * 2 ** this.respawnAttempts, 5000);
      this.respawnAttempts += 1;
      setTimeout(() => {
        if (this.stopped) return;
        this.generation += 1;
        try { this.spawnWorker(); } catch (error) { this.trace.warning('capture_respawn', error); }
      }, delay).unref();
    }
  }

  ledgerPath() { return path.join(this.ledgerDir(), `gen-${this.generation}.jsonl`); }

  /** Durable minimal loss evidence OUTSIDE the queue + live coverage. */
  async recordLoss(env, cause) {
    this.droppedTotal += 1;
    const entry = { at: env.at, generation: this.generation, cause,
      session: env.session, from: env.body?.session_seq ?? null, to: env.body?.session_seq ?? null, count: 1 };
    try { await fs.appendFile(this.ledgerPath(), `${JSON.stringify(entry)}\n`, 'utf8'); }
    catch (error) { this.trace.warning('capture_ledger', error); }
    if (entry.session && Number.isInteger(entry.from)) {
      try {
        this.trace.store.coverage.noteGap({ session: entry.session, from_seq: entry.from, to_seq: entry.to,
          reason: 'queue_overflow', component: 'capture' });
      } catch (error) { this.trace.warning('capture_marker', error); }
    }
  }

  /**
   * Enqueue one capture job: canonical pre-admission gate, then allocate the
   * session sequence (durable), build the CanonicalCaptureEnvelopeV1 in
   * memory, validate the envelope, then either queue it or record the exact
   * loss. Returns immediately after allocation — persistence happens on the
   * writer.
   */
  async enqueue(job) {
    if (this.stopped) throw new Error('capture writer stopped');
    // §14: unresolved identities never enter G — and never consume a seq.
    assertCanonicalJob(job);
    const session = job.host?.sessionID ?? null;
    const store = this.trace.store;
    let built;
    const allocation = await store.sequences.allocate(session, (seq, previous) => {
      built = buildCanonicalEnvelope({
        workspace_id: store.workspaceID, session_id: session,
        event_type: job.type, host: job.host, data: job.data, extra: job.extra ?? {},
        seq, previous_event_ref: previous,
      });
      return { ref: built.event_ref, body: built.body };
    });
    const blobs = (job.blobs ?? []).map(b => ({ ...b }));
    const bytes = built.encoded.length + blobs.reduce((n, b) => n + (Buffer.isBuffer(b.content) ? b.content.length : 0), 0);
    // The queued object IS the CanonicalCaptureEnvelopeV1 plus persistence
    // inputs (ref aliases event_ref for the worker-side primitive; bytes and
    // env_id are transport metadata). The validator ignores extra fields, so
    // the queued envelope re-validates directly.
    const envelope = {
      ...built,
      ref: built.event_ref,
      env_id: `${this.generation}-${allocation.seq}-${built.event_ref.slice(4, 12)}`,
      at: Date.now(), session, blobs, bytes,
    };
    // Defense in depth: the built envelope re-validates before admission.
    assertCanonicalEnvelope(envelope);
    if (this.queue.length >= this.queueCap || this.queueBytes + bytes > MAX_QUEUE_BYTES) {
      await this.recordLoss(envelope, 'queue_overflow');
      return { enqueued: false, ref: built.event_ref, dropped: true };
    }
    this.queue.push(envelope);
    this.queueBytes += bytes;
    this.lastEnqueued.set(session, Math.max(this.lastEnqueued.get(session) ?? 0, allocation.seq));
    this.drain();
    return { enqueued: true, ref: built.event_ref };
  }

  /** Post the next batch to the writer (single-batch window keeps order). */
  drain() {
    if (this.paused || !this.worker || this.inFlight.size > 0 || this.queue.length === 0) return;
    const batch = this.queue.splice(0, BATCH);
    for (const env of batch) this.inFlight.set(env.env_id, env);
    this.worker.postMessage({ type: 'envelopes', envelopes: batch });
  }

  /** Resolve when every enqueued envelope is persisted (tests/graceful stop). */
  async flush(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while ((this.queue.length > 0 || this.inFlight.size > 0) && Date.now() < deadline) {
      this.drain();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (this.queue.length > 0 || this.inFlight.size > 0) throw new Error('capture flush timeout');
  }

  async stop() {
    this.stopped = true;
    try { await this.flush(); } catch { /* degraded: losses already ledgered on death paths */ }
    const worker = this.worker;
    this.worker = null;
    this.active = false;
    this.trace.store.suppressDerivedWrites = false;
    if (worker) { try { await worker.terminate(); } catch { /* already gone */ } }
  }

  status() {
    const latencies = [...this.latencies].sort((a, b) => a - b);
    const pick = p => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] : null;
    // S7.5 telemetry semantics (mission §3/§7-§10): dropped_total IS the
    // authoritative physical_loss_events (every recordLoss call = one
    // physical lost envelope with a known seq). Envelope counts
    // (persisted/indexed) are DISTINCT from any sequence watermark: the
    // worker persists + ingests in one atomic step per envelope, so both
    // counters advance together per ack and index_lag_events is 0 by
    // construction after acks. Sequence watermarks are per-session maxima.
    return {
      enabled: true, active: this.active, degraded: this.degraded, generation: this.generation,
      queue_depth: this.queue.length, queue_bytes: this.queueBytes,
      oldest_queue_age: this.queue.length ? Date.now() - this.queue[0].at : 0,
      in_flight: this.inFlight.size, dropped_total: this.droppedTotal,
      physical_loss_events: this.droppedTotal,
      last_enqueued_seq: Math.max(0, ...this.lastEnqueued.values()),
      last_persisted_seq: Math.max(0, ...this.lastPersisted.values()),
      persisted_event_count: this.persistedEventCount,
      indexed_event_count: this.indexedEventCount,
      index_lag_events: this.persistedEventCount - this.indexedEventCount,
      persist_latency_ms: { p50: pick(0.5), p95: pick(0.95), last: latencies.at(-1) ?? null },
      respawn_attempts: this.respawnAttempts,
      meaning: 'non-blocking capture: physical_loss_events is the exact lost-envelope count from the enqueue-side allocator (ledger-backed); persisted/indexed_event_count are cumulative acked-envelope counts (persist and index are one atomic worker step, so index_lag_events is 0 after acks); sequence watermarks are per-session maxima; degraded means the writer died and unacknowledged envelopes were recorded as exact losses in the durable ledger; loss never blocks the host',
    };
  }
}
