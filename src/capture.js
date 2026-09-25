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
// The host assigns an occurrence before asynchronous delivery. Admission
// fsyncs source CAS and an intent fixing sequence/ref; the worker receives
// only that admitted envelope. Memory overflow spills the same event, and
// lost ACKs/worker death replay it without allocating another identity.
// Accepted intents survive host restart. A host failure before admission is
// outside that guarantee and must never be called exactly-once delivery.
// Historical loss ledgers remain readable; they are not used to label an
// unacknowledged but possibly committed new event as physically lost.
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { atomic, refPattern } from './util.js';
import { assertCanonicalEnvelope } from './canonical-envelope.js';

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

  // ---- P2-A: workspace-global G owner lease (campaign 2026-09-21) --------
  // Two compatible V3 G writers must never both own one workspace. The
  // lease is a small JSON file carrying enough identity to distinguish
  // owners: pid, process start identity (boot id + /proc/<pid>/stat
  // starttime — PID reuse is detected by the start identity, never trusted
  // by PID alone), release identity, workspace ID, generation, acquisition
  // time and a renewal heartbeat. Acquisition is exclusive-create. A stale
  // lease is stolen ONLY after proven owner death (pid absent, or a
  // /proc start-identity mismatch) — never by age alone (mission §25). If
  // acquisition fails, this process does NOT run a writer: no second
  // SQLite writer, no derived-write suppression, and enqueue losses go to
  // the durable ledger (visible, never silent). HONEST LIMITATION (mission
  // §26): a legacy plugin version predating the lease does not honor it —
  // exclusion of legacy writers is impossible; the lease carries the
  // owner's release identity so coexistence with a legacy writer is
  // detectable in status instead of invisible.
  leasePath() { return path.join(this.trace.store.root, 'owner-lease.json'); }

  async #processStartIdentity() {
    // Robust /proc/self/stat parsing: comm may contain spaces/parens, so
    // starttime (field 22) is read AFTER the last ')'. Field indices after
    // comm (1-based): state=1, ppid=2, ... starttime=22 → array index 19.
    const identity = { pid: process.pid, boot_id: null, starttime: null, release: process.env.OPENCODE_RELEASE ?? null };
    try {
      const raw = await fs.readFile('/proc/self/stat', 'utf8');
      const after = raw.slice(raw.lastIndexOf(')') + 2);
      const fields = after.split(' ');
      identity.starttime = fields[19];
    } catch { /* best-effort; steal checks tolerate null identity by refusing to steal */ }
    try { identity.boot_id = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(); } catch { identity.boot_id = null; }
    return identity;
  }

  /** Proven owner liveness: /proc/<pid> present AND its /proc starttime AND
   *  boot id match the lease — PID reuse and machine reboot both fail this. */
  async #ownerAlive(lease) {
    if (!lease || typeof lease !== 'object' || !Number.isInteger(lease.pid) || lease.pid <= 0) return null;
    if (!lease.starttime || !lease.boot_id) return null;
    try {
      const raw = await fs.readFile(`/proc/${lease.pid}/stat`, 'utf8');
      const after = raw.slice(raw.lastIndexOf(')') + 2);
      const startTicks = after.split(' ')[19];
      const bootId = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
      return startTicks === lease.starttime && bootId === lease.boot_id;
    } catch (error) { return error.code === 'ENOENT' ? false : null; }
  }

  async #readLease() {
    try { return JSON.parse(await fs.readFile(this.leasePath(), 'utf8')); }
    catch { return null; }
  }

  async acquireOwnership() {
    return this.trace.store.sequences.withLock('_capture-owner', () => this.acquireOwnershipLocked());
  }

  async acquireOwnershipLocked() {
    const leasePath = this.leasePath();
    const identity = await this.#processStartIdentity();
    const payload = { ...identity, workspaceID: this.trace.store.workspaceID,
      generation: this.generation, acquired_at: new Date().toISOString(), heartbeat_at: Date.now() };
    try {
      await fs.writeFile(leasePath, JSON.stringify(payload), { flag: 'wx', mode: 0o600 });
      this.ownership = true; this.ownershipReason = null;
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') { this.ownership = false; this.ownershipReason = `lease-write-${error?.code ?? 'error'}`; return false; }
    }
    const existing = await this.#readLease();
    const alive = await this.#ownerAlive(existing);
    if (alive === null) { this.ownership = false; this.ownershipReason = 'owner-identity-unknown'; return false; }
    // Idempotent re-acquire: OUR OWN live lease (same pid + start identity)
    // is not a conflict — e.g. start() called twice in one process.
    if (existing && existing.pid === process.pid
      && await this.#ownerAlive({ ...existing, pid: existing.pid })) {
      this.ownership = true; this.ownershipReason = null;
      return true;
    }
    if (existing && await this.#ownerAlive(existing)) {
      this.ownership = false;
      this.ownershipReason = (existing.release ?? '') === (payload.release ?? '')
        ? 'owner-lease-held'
        : 'owner-lease-held-legacy-writer-not-lease-aware-incompatible';
      return false;
    }
    // Stale lease: archive for audit, then take ownership exclusively.
    try { await fs.rename(leasePath, `${leasePath}.stale-${Date.now()}`); } catch { /* fall through */ }
    try {
      const fresh = { ...payload, generation: (existing?.generation ?? 0) + 1 };
      await fs.writeFile(leasePath, JSON.stringify(fresh), { flag: 'wx', mode: 0o600 });
      this.generation = fresh.generation;
      this.ownership = true; this.ownershipReason = 'stale-lease-recovered';
      return true;
    } catch (error) {
      this.ownership = false; this.ownershipReason = `owner-lease-race-${error?.code ?? 'error'}`;
      return false;
    }
  }

  renewOwnership() {
    if (this.ownership !== true) return;
    this.trace.store.sequences.withLock('_capture-owner', async () => {
      const text = await fs.readFile(this.leasePath(), 'utf8');
      const lease = JSON.parse(text);
      if (lease.pid !== process.pid) return; // lost the lease; do not renew foreign files
      lease.heartbeat_at = Date.now(); lease.generation = this.generation;
      return atomic(this.leasePath(), JSON.stringify(lease));
    }).catch(() => { /* lease lost; death/stop paths own recovery */ });
  }

  async releaseOwnership() {
    if (this.leaseTimer) { clearInterval(this.leaseTimer); this.leaseTimer = null; }
    if (this.ownership !== true) { this.ownership = null; return; }
    try {
      await this.trace.store.sequences.withLock('_capture-owner', async () => {
        const lease = await this.#readLease();
        if (lease && lease.pid === process.pid) await fs.rm(this.leasePath(), { force: true });
      });
    } catch { /* release best-effort; stale lease is stealable by design */ }
    this.ownership = null; this.ownershipReason = null;
  }

  async start() {
    if (this.stopped) return;
    await fs.mkdir(this.ledgerDir(), { recursive: true, mode: 0o700 });
    // P2-A workspace-global owner lease: acquire BEFORE any writer or index
    // ownership side effect. A non-owner process never spawns a worker and
    // never suppresses host derived writes (mission §24: no second SQLite
    // writer; enqueue losses ledger visibly).
    const owned = await this.acquireOwnership();
    if (!owned) { this.active = false; return; }
    // Single index owner: while the writer is alive the host does not
    // write the derived index; the worker's Store owns it.
    this.trace.store.suppressDerivedWrites = true;
    // Renewal heartbeat: keeps the lease fresh; steal requires proven
    // owner death (pid/start identity), never heartbeat age alone.
    this.leaseTimer = setInterval(() => { try { this.renewOwnership(); } catch { /* best-effort */ } }, 15000);
    if (this.leaseTimer.unref) this.leaseTimer.unref();
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
      if (message.storageTiming) this.workerStorageTiming = message.storageTiming;
      if (message.indexState) this.workerIndexState = message.indexState;
      let acknowledged = 0;
      for (const id of Array.isArray(message.ids) ? message.ids : []) {
        const env = this.inFlight.get(id);
        if (!env) continue;
        this.queueBytes -= env.bytes;
        this.inFlight.delete(id);
        acknowledged++;
        const session = env.session ?? '_';
        const seq = env.body?.session_seq;
        if (Number.isSafeInteger(seq) && seq >= 0)
          this.lastPersisted.set(session, Math.max(this.lastPersisted.get(session) ?? 0, seq));
      }
      // An ACK is evidence only for this generation's known in-flight
      // envelopes. Replayed/unknown IDs and advertised maxima are not new work.
      if (acknowledged === 0) return;
      this.lastIndexed = acknowledged;
      this.persistedEventCount += acknowledged;
      this.indexedEventCount = this.persistedEventCount; // worker in-memory ingestion acknowledged; SQLite is separate
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
    // Lack of ACK does not establish loss: immutable events may already have
    // committed. Retry the same admitted envelopes; the journal also survives
    // death of this host. Never allocate new identities on worker retry.
    this.queue.unshift(...this.inFlight.values());
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

  /** Durably admit once per occurrence, then dispatch its fixed envelope. */
  async enqueue(job) {
    if (this.stopped || this.stopping) throw new Error('capture writer stopped');
    // §14: unresolved identities never enter G — and never consume a seq.
    assertCanonicalJob(job);
    // P2-A: a non-owner process must not enqueue into its own (unowned)
    // writer path. The envelope is still built+validated so the durable
    // ledger records the loss with its exact identity; the next owner's
    // drain turns it into trace.capture_gap markers (visible, never silent).
    if (this.ownership === false) return { enqueued: false, dropped: true, ownership: false, reason: this.ownershipReason ?? 'owner-unavailable' };
    const session = job.host?.sessionID ?? null;
    const store = this.trace.store;
    const { envelope: built, replayed } = await store.admissions.admit(job, job.occurrence);
    const bytes = Buffer.byteLength(built.encoded);
    // The queued object IS the CanonicalCaptureEnvelopeV1 plus persistence
    // inputs (ref aliases event_ref for the worker-side primitive; bytes and
    // env_id are transport metadata). The validator ignores extra fields, so
    // the queued envelope re-validates directly.
    const envelope = {
      ...built,
      ref: built.event_ref,
      env_id: built.event_ref,
      session, bytes,
    };
    // Defense in depth: the built envelope re-validates before admission.
    assertCanonicalEnvelope(envelope);
    if (replayed && (this.inFlight.has(envelope.env_id) || this.queue.some(env => env.env_id === envelope.env_id)))
      return { enqueued: true, ref: built.event_ref, replayed: true };
    if (replayed && await store.exists(built.event_ref))
      return { enqueued: false, ref: built.event_ref, replayed: true, persisted: true };
    if (this.queue.length >= this.queueCap || this.queueBytes + bytes > MAX_QUEUE_BYTES) {
      // Admission is durable even when the memory queue is full. Complete the
      // same event directly, with host index writes suppressed when the worker
      // owns it. The outer observer budget remains fail-open for native work.
      await store.persistEnvelope(envelope);
      return { enqueued: false, ref: built.event_ref, spilled: true, persisted: true };
    }
    this.queue.push(envelope);
    this.queueBytes += bytes;
    this.lastEnqueued.set(session, Math.max(this.lastEnqueued.get(session) ?? 0, built.session_seq));
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
    this.stopping = true;
    try { await this.flush(); } catch { /* accepted intents remain recoverable on restart */ }
    this.stopped = true;
    const worker = this.worker;
    this.worker = null;
    this.active = false;
    this.trace.store.suppressDerivedWrites = false;
    if (worker) {
      const exited = await new Promise(resolve => {
        let settled = false;
        const finish = value => { if (settled) return; settled = true; clearTimeout(timer); worker.off('exit', onExit); resolve(value); };
        const onExit = () => finish(true);
        const timer = setTimeout(() => finish(false), 2000);
        worker.once('exit', onExit);
        try { worker.postMessage({ type: 'shutdown' }); } catch { finish(false); }
      });
      if (!exited) { try { await worker.terminate(); } catch { /* already gone */ } }
    }
    // P2-A: release the workspace owner lease (id-checked; stale leases are
    // stealable by design, so a failed release never wedges the workspace).
    await this.releaseOwnership();
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
      owner: this.ownership, ownership_reason: this.ownershipReason ?? null,
      queue_depth: this.queue.length, queue_bytes: this.queueBytes,
      oldest_queue_age: this.queue.length ? Date.now() - this.queue[0].at : 0,
      in_flight: this.inFlight.size, dropped_total: this.droppedTotal,
      physical_loss_events: this.droppedTotal,
      last_enqueued_seq: Math.max(0, ...this.lastEnqueued.values()),
      last_persisted_seq: Math.max(0, ...this.lastPersisted.values()),
      persisted_event_count: this.persistedEventCount,
      indexed_event_count: this.indexedEventCount,
      index_lag_events: this.persistedEventCount - this.indexedEventCount,
      persist_latency_ms: { p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), last: latencies.at(-1) ?? null },
      worker_storage: this.workerStorageTiming ?? null,
      worker_index: this.workerIndexState ?? null,
      respawn_attempts: this.respawnAttempts,
      meaning: 'Durable admission fixes occurrence identity before worker dispatch. Memory overflow and missing ACKs do not prove physical loss. Persisted/indexed counts track acknowledged envelopes and worker in-memory ingestion, not an atomic SQLite commit; durable index state is reported separately. Historical loss-ledger counters exclude recoverable admitted work. Native work remains fail-open before admission.',
    };
  }
}
