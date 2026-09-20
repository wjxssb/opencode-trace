// Phase C: measurable coverage + honest gap evidence.
//
// Known capture loss becomes durable evidence itself: a `trace.capture_gap`
// event per distinct loss (deduped by session/range/reason), reconciled by a
// FOLLOW-UP marker when the missing sequence later arrives (the original is
// never deleted — forensic chronology is preserved). A 30-minute-class
// staleness question does not apply here; markers stay until reconciled.
//
// All marker writes are best-effort and retried on flush; if the store is
// temporarily unwritable, entries keep `status: 'pending_write'` and are
// never silently lost (mission 9.5 semantics, shared with Phase G).
export class CoverageTracker {
  constructor(store) {
    this.store = store;
    this.markers = new Map();  // key -> marker entry
    this.pending = new Set();  // in-flight marker writes
    this.retryQueue = [];      // entries whose write failed
    this.lastSeq = new Map();  // session -> max ingested session_seq
    this.seeding = true;       // recovery ingest must not flag historical jumps
    this.counters = { dropped_total: 0, missed_watcher_total: 0 };
  }

  key(session, from, to, reason) { return `${session}:${from}:${to}:${reason}`; }

  noteGap({ session = null, from_seq = null, to_seq = null, reason, component = null }) {
    to_seq = to_seq ?? from_seq;
    const k = this.key(session, from_seq, to_seq, reason);
    const existing = this.markers.get(k);
    if (existing) return existing; // dedupe in ANY status; failed writes retry via flushPending
    const entry = { session, from_seq, to_seq, reason, component, status: 'pending_write', observed_at: Date.now() };
    this.markers.set(k, entry);
    this.#writeMarker(entry, k);
    return entry;
  }

  #writeMarker(entry, k) {
    const write = this.store.record('trace.capture_gap', { sessionID: entry.session }, {
      session: entry.session, from_seq: entry.from_seq, to_seq: entry.to_seq,
      reason: entry.reason, component: entry.component, status: 'detected',
      observed_at: Date.now(),
      semantics: 'coverage evidence: known capture discontinuity. Absence of evidence inside this range is not established in either direction.',
    }, { session: entry.session ?? undefined }).then(event => {
      entry.marker_ref = event.ref;
      entry.status = 'detected';
    }).catch(() => {
      entry.status = 'pending_write';
      if (!this.retryQueue.includes(entry)) this.retryQueue.push(entry);
    });
    this.pending.add(write);
    write.finally(() => this.pending.delete(write)).catch(() => {});
    return write;
  }

  /** Retry unwritten markers (bounded); resolves when the queue settles. */
  async flushPending(attempts = 3) {
    for (let i = 0; i <= attempts; i++) {
      await Promise.allSettled([...this.pending]);   // in-flight writes settle FIRST
      if (!this.retryQueue.length) return;
      const batch = this.retryQueue.splice(0);
      for (const entry of batch) {
        const k = this.key(entry.session, entry.from_seq, entry.to_seq, entry.reason);
        if (this.markers.get(k)?.status === 'detected') continue;
        await this.#writeMarker(entry, k).catch(() => {});
      }
      await Promise.allSettled([...this.pending]);
    }
  }

  noteReconciled(session, seq) {
    for (const entry of this.markers.values()) {
      if (entry.session !== session || entry.status !== 'detected') continue;
      if (seq < (entry.from_seq ?? seq) || seq > (entry.to_seq ?? seq)) continue;
      entry.status = 'reconciled';
      const write = this.store.record('trace.capture_gap', { sessionID: session }, {
        session, from_seq: entry.from_seq, to_seq: entry.to_seq, reason: entry.reason,
        status: 'reconciled', reconciles_seq: seq, reconciles_marker: entry.marker_ref ?? null,
        observed_at: Date.now(),
        semantics: 'reconciliation preserves the original gap marker; forensic chronology kept',
      }, { session }).catch(() => {});
      this.pending.add(write);
      write.finally(() => this.pending.delete(write)).catch(() => {});
      return true;
    }
    return false;
  }

  /** Sequence-continuity observation for one ingested event. */
  ingestSeq(session, seq, type) {
    if (this.seeding || seq == null || type === 'trace.capture_gap' || !session) return;
    const last = this.lastSeq.get(session);
    if (last != null) {
      if (seq > last + 1) this.noteGap({ session, from_seq: last + 1, to_seq: seq - 1, reason: 'capture_gap', component: 'sequence' });
      else if (seq <= last) this.noteReconciled(session, seq);
    }
    if (seq > (this.lastSeq.get(session) ?? 0)) this.lastSeq.set(session, seq);
  }

  /** Seed watermarks + marker state after recovery; enables live detection. */
  async rebuild() {
    for (const entry of this.store.index.values()) {
      if (entry.seq != null && entry.sessionID) {
        if (entry.seq > (this.lastSeq.get(entry.sessionID) ?? 0)) this.lastSeq.set(entry.sessionID, entry.seq);
      }
    }
    for (const entry of this.store.findEntriesAll({ type: 'trace.capture_gap' })) {
      try {
        const data = JSON.parse((await this.store.readBlob(entry.payloadRef)).toString());
        if (data.status === 'reconciled') {
          for (const m of this.markers.values()) {
            if (m.session === data.session && m.from_seq === data.from_seq && m.to_seq === data.to_seq && m.reason === data.reason) m.status = 'reconciled';
          }
        } else {
          const k = this.key(data.session, data.from_seq, data.to_seq, data.reason);
          if (!this.markers.has(k)) this.markers.set(k, { ...data, marker_ref: entry.ref, status: data.status ?? 'detected' });
        }
      } catch { /* unreadable marker: store integrity paths report it */ }
    }
    this.seeding = false;
  }

  /** Watcher-miss markers reconcile when a full scan imports all unseen events. */
  async reconcileWatcherGaps() {
    for (const entry of this.markers.values()) {
      if (entry.reason === 'watcher_gap' && entry.status === 'detected') {
        entry.status = 'reconciled';
        try {
          const event = await this.store.record('trace.capture_gap', { sessionID: null }, {
            session: null, from_seq: entry.from_seq, to_seq: entry.to_seq, reason: entry.reason,
            status: 'reconciled', reconciles_marker: entry.marker_ref ?? null, observed_at: Date.now(),
            semantics: 'full directory scan imported all unseen events; watcher loss fully recovered (original preserved)',
          });
          entry.marker_ref = event.ref ?? entry.marker_ref;
        } catch { entry.status = 'detected'; }
      }
    }
  }

  status() {
    let known_gaps = 0, reconciled_gaps = 0, pending_writes = 0;
    for (const m of this.markers.values()) {
      if (m.status === 'reconciled') reconciled_gaps++;
      else if (m.status === 'pending_write') pending_writes++;
      else known_gaps++;
    }
    return {
      status: known_gaps > 0 || pending_writes > 0 ? 'incomplete' : 'complete',
      known_gaps, reconciled_gaps, pending_writes,
      dropped_total: this.counters.dropped_total,
      missed_watcher_total: this.counters.missed_watcher_total,
      meaning: 'complete: no known capture discontinuity. incomplete: known gaps exist — absence of a match is not established.',
    };
  }
}
