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
    this.observedSequences = new Map();
    this.sequenceChecks = new Map();
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
    const write = this.store.recordGap({ sessionID: entry.session },
      this.#markerPayload(entry, k, extra),
      { session: entry.session ?? undefined }).then(event => {
        // A completed write IS detection (range-less watcher losses stay
        // 'detected' with unknown extent; only explicit reconciliation paths
        // may flip them to 'reconciled').
        entry.marker_ref = event.ref;
        if (entry.status === 'pending_write') entry.status = 'detected';
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
      // A sequence check can enqueue marker writes while the awaited batch
      // settles. Drain those descendants too before reporting a flush.
      while (this.pending.size) await Promise.allSettled([...this.pending]);
      if (!this.retryQueue.length) return;
      const batch = this.retryQueue.splice(0);
      for (const entry of batch) {
        const k = this.key(entry.session, entry.ranges[0]?.from ?? null, entry.ranges.at(-1)?.to ?? null, entry.reason);
        if (this.markers.get(k)?.status === 'detected') continue;
        await this.#writeMarker(entry, k, null).catch(() => {});
      }
      while (this.pending.size) await Promise.allSettled([...this.pending]);
    }
  }

  /**
   * Shrink the marker set for one recovered sequence. Partial recovery keeps
   * the remaining loss visible: 3..4 + recovered 3 -> remaining 4..4. Returns
   * the affected entry or null. Follow-up evidence is recorded (awaited).
   */
  async noteReconciled(session, seq, awaited = true) {
    let first = null;
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
        marker_key: k,
        reconciles_marker: entry.marker_ref ?? null, observed_at: Date.now(),
        semantics: 'reconciliation shrinks the remaining ranges; the original detected marker is preserved (forensic chronology)',
      }, { session }).then(event => { entry.last_followup_ref = event.ref; return event; }).catch(() => {});
      if (awaited) await write.catch(() => {});
      else { this.pending.add(write); write.finally(() => this.pending.delete(write)).catch(() => {}); }
      first ??= entry;
    }
    return first;
  }

  checkSequenceGap(session, from, to) {
    this.sequenceChecks.set(session, (this.sequenceChecks.get(session) ?? 0) + 1);
    // A sequence may be durably admitted while its event awaits the worker.
    // Neither asynchronous observer order nor a missing ACK proves loss.
    const check = (async () => {
      let start = null;
      for (let seq = from; seq <= to; seq++) {
        const known = this.observedSequences.get(session)?.has(seq) || await this.store.admissions?.hasSequence(session, seq);
        if (!known && !this.observedSequences.get(session)?.has(seq)) start ??= seq;
        else if (start !== null) { this.noteGap({ session, from_seq: start, to_seq: seq - 1, reason: 'capture_gap', component: 'sequence' }); start = null; }
      }
      if (start !== null) this.noteGap({ session, from_seq: start, to_seq: to, reason: 'capture_gap', component: 'sequence' });
    })().catch(error => this.store.warning('sequence_coverage', error));
    this.pending.add(check);
    check.finally(() => {
      this.pending.delete(check);
      const left = (this.sequenceChecks.get(session) ?? 1) - 1;
      if (left) this.sequenceChecks.set(session, left); else this.sequenceChecks.delete(session);
    }).catch(() => {});
  }

  /** Sequence-continuity observation for one ingested event (Phase B seq). */
  ingestSeq(session, seq, type) {
    if (seq == null || !session) return;
    if (!this.observedSequences.has(session)) this.observedSequences.set(session, new Set());
    this.observedSequences.get(session).add(seq);
    if (this.seeding) return;
    const last = this.lastSeq.get(session);
    const isMarker = type === 'trace.capture_gap';
    if (last != null) {
      if (seq > last + 1 && !isMarker) this.checkSequenceGap(session, last + 1, seq - 1);
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
            status: 'detected', marker_ref: entry.ref, observed_at: data.observed_at });
        }
      } catch { /* unreadable marker: store integrity paths report it */ }
    }
    // The index may enumerate newest first. Apply each session's durable
    // follow-ups in sequence order so an older partial record cannot undo a
    // later complete reconciliation.
    followups.sort((a, b) => (a.entry.seq ?? 0) - (b.entry.seq ?? 0)
      || (a.entry.at ?? 0) - (b.entry.at ?? 0));
    for (const { data } of followups) {
      // F3 (review advisory): a follow-up must shrink EXACTLY the marker it
      // reconciles. Match by reconciles_marker (marker event ref) first, then
      // by the recorded marker_key; unmatched/ambiguous follow-ups are
      // skipped so sibling markers with the same session+reason can never be
      // corrupted on restart. Persisted status is never rewritten here.
      let target = null;
      if (data.reconciles_marker) {
        target = [...this.markers.values()].find(m => m.marker_ref === data.reconciles_marker) ?? null;
      }
      if (!target && data.marker_key) target = this.markers.get(data.marker_key) ?? null;
      if (!target) continue;
      if (Array.isArray(data.remaining)) target.ranges = data.remaining.map(r => ({ ...r }));
      target.status = target.ranges.length ? 'partially_reconciled' : 'reconciled';
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
    const own = [...this.markers.values()].filter(m => m.session === session);
    // Workspace-global = every known loss NOT scoped to the queried session:
    // other sessions' gaps plus session-null losses (watcher/observer). An
    // unrelated session's gap never poisons THIS session's scoped status, but
    // it must stay visible separately: absence for the queried session is
    // only as trustworthy as the whole workspace's capture health.
    const external = [...this.markers.values()].filter(m => m.session !== session);
    const ownSum = summarize(own), extSum = summarize(external);
    ownSum.pending_sequence_checks = this.sequenceChecks.get(session) ?? 0;
    extSum.pending_sequence_checks = [...this.sequenceChecks].reduce((n, [sid, count]) => n + (sid === session ? 0 : count), 0);
    const ownBad = ownSum.known_gaps + ownSum.pending_writes + ownSum.pending_sequence_checks > 0;
    const extBad = extSum.known_gaps + extSum.pending_writes + extSum.pending_sequence_checks > 0;
    return {
      session, session_coverage: { status: ownBad ? 'incomplete' : 'complete', ...ownSum },
      workspace_global: { status: extBad ? 'incomplete' : 'complete', ...extSum,
        dropped_total: this.counters.dropped_total, missed_watcher_total: this.counters.missed_watcher_total },
      status: ownBad || extBad ? 'incomplete' : 'complete',
      meaning: 'session_coverage is scoped to the queried session; workspace_global covers every known loss not scoped to it (other sessions + observer losses). incomplete means absence is NOT established.',
    };
  }

  status() {
    let known = 0;
    let pending = 0;
    for (const m of this.markers.values()) {
      if (m.status === 'pending_write') pending++;
      else if (m.ranges.length || m.status === 'detected') known++;
    }
    return {
      status: known + pending + this.sequenceChecks.size > 0 ? 'incomplete' : 'complete', known_gaps: known, pending_writes: pending,
      pending_sequence_checks: [...this.sequenceChecks.values()].reduce((a, b) => a + b, 0),
      dropped_total: this.counters.dropped_total, missed_watcher_total: this.counters.missed_watcher_total,
      scoped: true,
      meaning: 'workspace-level summary; use statusFor(session)/find(session=...) for session-scoped semantics',
    };
  }
}
