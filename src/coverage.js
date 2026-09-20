// Phase C: measurable coverage + honest gap evidence (V2 revision per
// supplemental directive §3A/3B/3C).
//
// Marker model: each detected loss is a durable `trace.capture_gap` event
// whose entry carries a REMAINING-RANGE SET (initially one range). A
// recovered sequence SHRINKS the covering range (splitting it when the
// recovered seq falls inside) — partial recovery never clears unrecovered
// loss. The original detected marker is never deleted; reconciliation is
// recorded as follow-up markers with `remaining` + `reconciles_seq`.
//
// Marker events may themselves occupy session sequence space (allocator):
// ingestSeq ADVANCES the watermark through them (they are durable events,
// so no later event can falsely look like a gap at their position) while
// never flagging gaps FOR them.
//
// Coverage is QUERY-SCOPED: `status(session)` reports that session's own
// unresolved ranges plus workspace-global losses (watcher/observer, session
// null) separately, so one stale peer session cannot poison absence
// semantics for unrelated sessions.
export class CoverageTracker {
  constructor(store) {
    this.store = store;
    this.markers = new Map();  // key -> marker entry (ranges set, status)
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
    const entry = { session, ranges: from_seq == null ? [] : [{ from: from_seq, to: to_seq }],
      reason, component, status: 'pending_write', observed_at: Date.now() };
    this.markers.set(k, entry);
    this.#writeMarker(entry, k, null);
    return entry;
  }

  #markerPayload(entry, k, extra) {
    return { session: entry.session, reason: entry.reason, component: entry.component,
      status: 'detected', ranges: entry.ranges.map(r => ({ ...r })),
      unresolved_count: entry.ranges.reduce((n, r) => n + (r.to - r.from + 1), 0),
      observed_at: Date.now(), marker_key: k,
      semantics: 'coverage evidence: known capture discontinuity as remaining ranges; partial recovery shrinks ranges; originals never rewritten',
      ...(extra ?? {}) };
  }

  #writeMarker(entry, k, extra) {
    const write = this.store.record('trace.capture_gap', { sessionID: entry.session },
      this.#markerPayload(entry, k, extra),
      { session: entry.session ?? undefined }).then(event => {
        entry.marker_ref = event.ref;
        if (entry.status === 'pending_write') entry.status = entry.ranges.length ? 'detected' : 'reconciled';
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
        const k = this.key(entry.session, entry.ranges[0]?.from ?? null, entry.ranges.at(-1)?.to ?? null, entry.reason);
        if (this.markers.get(k)?.status === 'detected') continue;
        await this.#writeMarker(entry, k, null).catch(() => {});
      }
      await Promise.allSettled([...this.pending]);
    }
  }

  /**
   * Shrink the marker set for one recovered sequence. Partial recovery keeps
   * the remaining loss visible: 3..4 + recovered 3 -> remaining 4..4. Returns
   * the affected entry or null. Follow-up evidence is recorded (awaited).
   */
  async noteReconciled(session, seq, awaited = true) {
    for (const [k, entry] of this.markers) {
      if (entry.session !== session || !entry.ranges.length) continue;
      const idx = entry.ranges.findIndex(r => seq >= r.from && seq <= r.to);
      if (idx < 0) continue;
      const range = entry.ranges[idx];
      const before = { ...range };
      if (seq === range.from && seq === range.to) entry.ranges.splice(idx, 1);
      else if (seq === range.from) range.from = seq + 1;
      else if (seq === range.to) range.to = seq - 1;
      else entry.ranges.splice(idx, 1, { from: range.from, to: seq - 1 }, { from: seq + 1, to: range.to });
      entry.status = entry.ranges.length ? 'partially_reconciled' : 'reconciled';
      const reconciledAll = entry.status === 'reconciled';
      const write = this.store.record('trace.capture_gap', { sessionID: session }, {
        session, reason: entry.reason, component: entry.component,
        status: reconciledAll ? 'reconciled' : 'partially_reconciled',
        reconciles_seq: seq, recovered_range: before, remaining: entry.ranges.map(r => ({ ...r })),
        reconciles_marker: entry.marker_ref ?? null, observed_at: Date.now(),
        semantics: 'reconciliation shrinks the remaining ranges; the original detected marker is preserved (forensic chronology)',
      }, { session }).then(event => { entry.last_followup_ref = event.ref; return event; }).catch(() => {});
      if (awaited) await write.catch(() => {});
      else { this.pending.add(write); write.finally(() => this.pending.delete(write)).catch(() => {}); }
      return entry;
    }
    return null;
  }

  /** Sequence-continuity observation for one ingested event (Phase B seq). */
  ingestSeq(session, seq, type) {
    if (this.seeding || seq == null || !session) return;
    const last = this.lastSeq.get(session);
    const isMarker = type === 'trace.capture_gap';
    if (last != null) {
      if (seq > last + 1 && !isMarker) this.noteGap({ session, from_seq: last + 1, to_seq: seq - 1, reason: 'capture_gap', component: 'sequence' });
      else if (seq <= last && !isMarker) this.noteReconciled(session, seq, false);
    }
    // Markers are durable events: the watermark advances THROUGH them, so the
    // next ordinary event (marker_seq + 1) can never be misread as missing.
    if (seq > (this.lastSeq.get(session) ?? 0)) this.lastSeq.set(session, seq);
  }

  /** Seed watermarks + marker state after recovery; enables live detection. */
  async rebuild() {
    for (const entry of this.store.index.values()) {
      if (entry.seq != null && entry.sessionID) {
        if (entry.seq > (this.lastSeq.get(entry.sessionID) ?? 0)) this.lastSeq.set(entry.sessionID, entry.seq);
      }
    }
    const followups = [];
    for (const entry of this.store.findEntriesAll({ type: 'trace.capture_gap' })) {
      try {
        const data = JSON.parse((await this.store.readBlob(entry.payloadRef)).toString());
        const k = this.key(data.session, data.ranges?.[0]?.from ?? data.from_seq ?? null,
          data.ranges?.at(-1)?.to ?? data.to_seq ?? null, data.reason);
        if (data.status === 'reconciled' || data.status === 'partially_reconciled') { followups.push({ data, entry }); continue; }
        if (!this.markers.has(k)) {
          const ranges = Array.isArray(data.ranges) && data.ranges.length
            ? data.ranges.map(r => ({ ...r }))
            : (data.from_seq != null ? [{ from: data.from_seq, to: data.to_seq ?? data.from_seq }] : []);
          this.markers.set(k, { session: data.session, ranges, reason: data.reason, component: data.component,
            status: ranges.length ? 'detected' : 'reconciled', marker_ref: entry.ref, observed_at: data.observed_at });
        }
      } catch { /* unreadable marker: store integrity paths report it */ }
    }
    for (const { data } of followups) {
      for (const m of this.markers.values()) {
        if (m.session !== data.session || m.reason !== data.reason) continue;
        if ((data.remaining ?? []).length) m.ranges = data.remaining.map(r => ({ ...r }));
        m.status = m.ranges.length ? 'partially_reconciled' : 'reconciled';
      }
    }
    this.seeding = false;
  }

  /** Watcher-miss markers (range-less) reconcile when a full scan imports all unseen events. */
  async reconcileWatcherGaps() {
    for (const [k, entry] of this.markers) {
      if (entry.reason !== 'watcher_gap' || entry.status === 'reconciled' || entry.ranges.length) continue;
      entry.status = 'reconciled';
      try {
        const event = await this.store.record('trace.capture_gap', { sessionID: null }, {
          session: null, reason: entry.reason, component: entry.component, status: 'reconciled',
          ranges: [], reconciles_marker: entry.marker_ref ?? null, observed_at: Date.now(),
          semantics: 'full directory scan imported all unseen events; watcher loss fully recovered (original preserved)',
        });
        entry.last_followup_ref = event.ref ?? null;
      } catch { entry.status = 'detected'; }
    }
  }

  /** Scoped coverage: one session's own losses + workspace-global losses. */
  statusFor(session) {
    const summarize = list => {
      let known_gaps = 0, pending = 0, partial = 0, unresolved_seqs = 0;
      for (const m of list) {
        const unresolved = m.ranges.reduce((n, r) => n + (r.to - r.from + 1), 0);
        if (m.status === 'pending_write') pending++;
        else if (m.ranges.length) { known_gaps++; unresolved_seqs += unresolved; if (m.status === 'partially_reconciled') partial++; }
        else if (m.status === 'detected') { known_gaps++; unresolved_seqs += 0; } // unknown-range loss (watcher)
      }
      return { known_gaps, pending_writes: pending, partially_reconciled: partial, unresolved_seqs };
    };
    const own = summarize([...this.markers.values()].filter(m => m.session === session));
    const global = summarize([...this.markers.values()].filter(m => m.session == null));
    const sessionStatus = own.known_gaps + own.pending_writes > 0 ? 'incomplete' : 'complete';
    const workspaceStatus = own.known_gaps + own.pending_writes + global.known_gaps + global.pending_writes > 0 ? 'incomplete' : 'complete';
    return {
      session, session_coverage: { status: sessionStatus, ...own },
      workspace_global: { status: global.known_gaps + global.pending_writes > 0 ? 'incomplete' : 'complete', ...global,
        dropped_total: this.counters.dropped_total, missed_watcher_total: this.counters.missed_watcher_total },
      status: workspaceStatus,
      meaning: 'session_coverage is scoped to the queried session; workspace_global covers cross-session losses. incomplete means absence is NOT established.',
    };
  }

  status() {
    const scoped = this.statusFor(null);
    let known = 0;
    for (const m of this.markers.values()) if (m.ranges.length || m.status === 'pending_write') known++;
    return {
      status: known > 0 ? 'incomplete' : 'complete', known_gaps: known,
      dropped_total: this.counters.dropped_total, missed_watcher_total: this.counters.missed_watcher_total,
      scoped: true,
      meaning: 'workspace-level summary; use statusFor(session)/find(session=...) for session-scoped semantics',
    };
  }
}
