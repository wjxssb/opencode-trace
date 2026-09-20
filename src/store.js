import * as fs from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { atomic, canonical, hash, stable, refPattern } from './util.js';
import { SequenceAllocator } from './sequence.js';

const keep = (items, item, limit) => [...items.filter(x => x.ref !== item.ref), item].sort((a, b) => a.at - b.at || a.ref.localeCompare(b.ref)).slice(-limit);

// Payload prefixes are read only to extract bounded search hints for the
// derived index. The hint read never replaces the authoritative expand path,
// which always returns hash-verified bytes from the blob store.
const HINT_READ_BYTES = 8192, HINT_MAX_STRINGS = 8, HINT_STRING_CAP = 200;

function collectStrings(value, out) {
  if (out.length >= HINT_MAX_STRINGS) return;
  if (typeof value === 'string') { if (value.trim()) out.push(value.length > HINT_STRING_CAP ? value.slice(0, HINT_STRING_CAP) : value); }
  else if (Array.isArray(value)) { for (const v of value) { collectStrings(v, out); if (out.length >= HINT_MAX_STRINGS) return; } }
  else if (value && typeof value === 'object') { for (const v of Object.values(value)) { collectStrings(v, out); if (out.length >= HINT_MAX_STRINGS) return; } }
}

// Filesystem errors carry absolute paths in message/path. Surface the ref and
// the error code only, so tool output never leaks store layout. The code is
// preserved because record() relies on ENOENT to detect a first write.
function ioError(label, ref, error) {
  const code = error?.code ?? 'IO_ERROR';
  const notFound = code === 'ENOENT';
  const clean = new Error(notFound ? `${label} not found ${ref}` : `${label} unreadable ${ref}: ${code}`);
  clean.code = code;
  return clean;
}

export class Store {
  constructor(workspace, root = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode-trace'), warning = () => {}, options = {}) {
    this.workspace = workspace; this.base = root; this.warning = warning;
    this.sessions = new Map(); this.seen = new Set(); this.watchJobs = new Set();
    this.watchRefs = new Set(); this.maxWatchJobs = 16; this.missedWatchEvents = 0;
    this.watchFactory = options.watch ?? watch;
    this.watcherState = { mode: 'initializing', error: null };
    // Completed tool calls, rebuilt from every ingested tool.after event.
    // Terminal evidence must not depend on the bounded pending display window:
    // a late out-of-order tool.before (watch overflow, reconcile batch order)
    // must never reopen a finished call. callKeys are 64-hex digests, not
    // outputs, so the in-memory set stays small for realistic sessions.
    this.terminalCalls = new Set();
    // Derived, rebuildable search index over every ingested event. Purely
    // in-memory: rebuilt from authoritative events during startup recovery,
    // so deleting it loses nothing. Entries are bounded (~1KB each) via
    // capped string hints; exact bytes always live in the blob store.
    this.index = new Map();
    // Phase B: durable per-session sequence allocator + replay guard
    // (causality-free body hash -> ref) so duplicate delivery/retry never
    // consumes a sequence number within this process.
    this.sequences = null;
    this.replayGuard = new Map();
  }
  async init() {
    this.workspace = await canonical(this.workspace);
    this.workspaceID = hash(this.workspace);
    this.root = path.join(this.base, 'workspaces', this.workspaceID);
    for (const d of ['events', 'blobs', 'sessions', 'recall', 'intents', 'state', 'sequence']) await fs.mkdir(path.join(this.root, d), { recursive: true, mode: 0o700 });
    this.sequences = new SequenceAllocator(path.join(this.root, 'sequence'));
    // Watch before recovery to cover concurrent writers during the one startup scan.
    const watcherFailed = error => {
      this.watcher?.close(); this.watcher = null;
      this.watcherState = { mode: 'reconcile_only', error: String(error?.code ?? error?.name ?? 'watch_error') };
      this.warning('watch_unavailable', error);
    };
    try {
    this.watcher = this.watchFactory(path.join(this.root, 'events'), (_event, filename) => {
      if (!/^evt_[a-f0-9]{64}\.json$/.test(filename ?? '')) return;
      const ref = filename.slice(0, -5);
      if (this.seen.has(ref) || this.watchRefs.has(ref)) return;
      if (this.watchJobs.size >= this.maxWatchJobs) { this.missedWatchEvents++; return; }
      this.watchRefs.add(ref);
      const job = this.readEvent(ref).then(e => this.ingest(e)).catch(e => this.warning('watch', e));
      this.watchJobs.add(job); job.finally(() => { this.watchJobs.delete(job); this.watchRefs.delete(ref); });
    });
    this.watcher.unref();
    this.watcher.on('error', watcherFailed);
    this.watcherState = { mode: 'watch_and_reconcile', error: null };
    } catch (error) { watcherFailed(error); }
    const names = (await fs.readdir(path.join(this.root, 'events'))).filter(x => /^evt_[a-f0-9]{64}\.json$/.test(x));
    const recovered = [];
    for (const name of names) {
      try { recovered.push(await this.readEvent(name.slice(0, -5))); }
      catch (error) { this.warning('recovery', error); }
    }
    recovered.sort((a, b) => a.at - b.at || a.ref.localeCompare(b.ref));
    for (const event of recovered) {
      try { await this.ingest(event); }
      catch (error) { this.warning('recovery', error); }
    }
    await atomic(path.join(this.root, 'state', 'schema.json'), stable({ schema: 1, workspace: this.workspace, workspaceID: this.workspaceID }));
    return this;
  }
  close() {
    this.closed = true; this.watcher?.close();
    const directory = this.reconcileDirectory; this.reconcileDirectory = null;
    return directory?.close().catch(() => {});
  }
  async flush() { await Promise.allSettled([...this.watchJobs]); }
  async ingest(event) {
    let hostCreated = event.compact?.host_created_at;
    // Older immutable events lack the chronology field. Recover it from the
    // verified native compaction payload, without rewriting the event.
    if (event.type === 'compaction' && hostCreated === undefined) {
      const row = JSON.parse((await this.readBlob(event.payload.ref)).toString());
      hostCreated = Number.isFinite(row.time?.created) ? row.time.created : null;
    }
    this.reduce(event, hostCreated);
    await this.indexEvent(event);
  }
  // Bounded payload peek for search hints. Reads at most HINT_READ_BYTES of
  // the payload file, never the whole blob, and never serves content.
  async readPayloadHints(event) {
    try {
      const digest = event.payload?.ref?.slice(5);
      if (!/^[a-f0-9]{64}$/.test(digest ?? '')) return [];
      const handle = await fs.open(path.join(this.root, 'blobs', digest.slice(0, 2), digest), 'r');
      try {
        const chunk = Buffer.alloc(Math.min(HINT_READ_BYTES, event.payload.bytes ?? HINT_READ_BYTES));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, 0);
        const raw = chunk.subarray(0, bytesRead).toString('utf8');
        try { const parsed = JSON.parse(raw); const out = []; collectStrings(parsed, out); return out; }
        catch { const out = raw.match(/"([^"\\]{4,120})"/g) ?? []; return out.slice(0, HINT_MAX_STRINGS).map(s => s.slice(1, -1)); }
      } finally { await handle.close(); }
    } catch (error) { this.warning('index_hints', error); return []; }
  }
  async indexEvent(event) {
    const rels = [...new Set([
      ...(event.note?.source_refs ?? []), ...(event.note?.supersedes ?? []), ...(event.note?.depends_on ?? []),
      ...(event.intent?.related_refs ?? []), ...(event.compact?.refs ?? []),
    ].flat().filter(r => typeof r === 'string' && refPattern.test(r)))];
    const payloadHints = await this.readPayloadHints(event);
    // Explicit structured relations and attempt addressing for mailbox and
    // plan events. These keep their structured data in the payload; small
    // payloads are read once here so the derived index can serve relation
    // queries. Only explicit refs are indexed - never parsed meaning.
    let attempt = null, stepWorker = null;
    const structured = { 'trace.message': ['source_refs'], 'trace.step': ['result_ref', 'worker_source_refs', 'attempt_id'], 'trace.step.result': ['source_refs', 'binding_ref', 'attempt_id'] }[event.type];
    if (structured && (event.payload?.bytes ?? 0) <= 65536) {
      try {
        const data = JSON.parse((await this.readBlob(event.payload.ref)).toString());
        for (const key of structured) {
          const v = data?.[key];
          if (typeof v === 'string' && refPattern.test(v)) rels.push(v);
          if (Array.isArray(v)) for (const r of v) if (typeof r === 'string' && refPattern.test(r)) rels.push(r);
        }
        attempt = typeof data?.attempt_id === 'string' ? data.attempt_id : null;
        if (event.type === 'trace.step.result') stepWorker = typeof data?.worker_session === 'string' ? data.worker_session : null;
        if (event.type === 'trace.step') stepWorker = typeof data?.sessionID === 'string' ? data.sessionID : null;
      } catch (error) { this.warning(`index_${event.type}`, error); }
    }
    if (event.type === 'coordination.advisory' && (event.payload?.bytes ?? 0) <= 65536) {
      // Advisory source relations live in the payload data of these small events.
      try {
        const data = JSON.parse((await this.readBlob(event.payload.ref)).toString());
        for (const r of data?.source_refs ?? []) if (refPattern.test(r)) rels.push(r);
      } catch (error) { this.warning('index_advisory', error); }
    }
    const entry = {
      ref: event.ref, at: event.at ?? 0, type: event.type,
      sessionID: event.host?.sessionID ?? null, messageID: event.host?.messageID ?? null, agent: event.host?.agent ?? null,
      tool: event.tool ?? null, status: event.status ?? null, callKey: event.callKey ?? null,
      callID: event.callID ?? null,
      thread: typeof event.thread_id === 'string' ? event.thread_id : null,
      mailID: typeof event.message_id === 'string' ? event.message_id : null,
      plan: typeof event.plan_id === 'string' ? event.plan_id : null,
      step: typeof event.step === 'string' ? event.step : null,
      worker: typeof event.worker === 'string' ? event.worker : stepWorker,
      attempt,
      recipients: Array.isArray(event.recipients) ? event.recipients.filter(r => typeof r === 'string') : null,
      recipient: typeof event.recipient === 'string' ? event.recipient : null,
      replyTo: typeof event.reply_to === 'string' ? event.reply_to : null,
      proposal: typeof event.proposal === 'string' ? event.proposal : null,
      paths: Array.isArray(event.paths) ? event.paths : null,
      source: event.source && Object.keys(event.source).length ? event.source : null,
      payloadRef: event.payload?.ref ?? null, bytes: event.payload?.bytes ?? 0,
      outputs: (event.outputs ?? []).map(o => ({ ref: o.ref, bytes: o.bytes ?? null })).filter(o => typeof o.ref === 'string'),
      seq: event.session_seq ?? null, previous: event.previous_event_ref ?? null,
      causedBy: event.caused_by ?? null, parent: event.parent_event_ref ?? null,
      rels: [...new Set(rels)], hints: payloadHints,
    };
    this.index.set(event.ref, entry);
  }
  matchesFilters(entry, f) {
    if (f.type && !(Array.isArray(f.type) ? f.type.includes(entry.type) : entry.type === f.type)) return false;
    if (f.session && entry.sessionID !== f.session) return false;
    if (f.agent && entry.agent !== f.agent) return false;
    if (f.tool && entry.tool !== f.tool) return false;
    if (f.status && entry.status !== f.status) return false;
    if (f.callKey && entry.callKey !== f.callKey) return false;
    if (f.thread && entry.thread !== f.thread) return false;
    if (f.message && entry.mailID !== f.message) return false;
    if (f.plan && entry.plan !== f.plan) return false;
    if (f.step && entry.step !== f.step) return false;
    if (f.worker && entry.worker !== f.worker) return false;
    if (f.attempt && entry.attempt !== f.attempt) return false;
    if (f.mailParticipant && !(entry.sessionID === f.mailParticipant || (entry.recipients ?? []).includes(f.mailParticipant))) return false;
    if (f.recipient && !(entry.recipient === f.recipient || (entry.recipients ?? []).includes(f.recipient))) return false;
    if (f.reply_to && entry.replyTo !== f.reply_to) return false;
    if (f.proposal && entry.proposal !== f.proposal) return false;
    if (f.ref && entry.ref !== f.ref) return false;
    // `related` matches explicit ref relations; when the target is a recorded
    // mail, message-id relations (replies, proposal bindings) resolve too.
    if (f.related && entry.ref !== f.related && !entry.rels.includes(f.related)
      && !(f.relatedMail && (entry.replyTo === f.relatedMail || entry.proposal === f.relatedMail))) return false;
    if (f.after != null && !(entry.at >= f.after)) return false;
    if (f.before != null && !(entry.at <= f.before)) return false;
    if (f.path) {
      const needle = f.path.toLowerCase();
      const hay = [...(entry.paths ?? []), entry.source ? Object.values(entry.source).filter(v => typeof v === 'string') : []].flat().map(v => v.toLowerCase());
      if (!hay.some(v => v.includes(needle))) return false;
    }
    if (f.text) {
      const needle = f.text.toLowerCase();
      if (!entry.hints.some(h => h.toLowerCase().includes(needle))) return false;
    }
    return true;
  }
  // Sorted (at, ref) ascending matches. Returns up to limit+1 entries so the
  // caller can detect truncation; pass a cursor {at, ref} to resume after it.
  findEntries(filter, cursor = null, limit = 21) {
    const entries = [...this.index.values()].sort((a, b) => a.at - b.at || a.ref.localeCompare(b.ref));
    const out = [];
    for (const entry of entries) {
      if (cursor && (entry.at < cursor.at || (entry.at === cursor.at && entry.ref.localeCompare(cursor.ref) <= 0))) continue;
      if (!this.matchesFilters(entry, filter)) continue;
      out.push(entry);
      if (out.length >= limit) break;
    }
    return out;
  }
  // Reverse-chronological window for budgeted exact-byte deep scans. The
  // cursor pair itself stays included so partially scanned events can resume.
  deepWindow(before, limit) {
    const entries = [...this.index.values()].sort((a, b) => b.at - a.at || b.ref.localeCompare(a.ref));
    const out = [];
    for (const entry of entries) {
      if (before && (entry.at > before.at || (entry.at === before.at && entry.ref.localeCompare(before.ref) > 0))) continue;
      out.push(entry);
      if (out.length >= limit) break;
    }
    return { window: out, reachedStart: out.length < limit };
  }
  // Newest-first matches. Inbox and outbox maintenance must see the most
  // recent messages, not the oldest N of a growing history.
  findEntriesNewest(filter, limit = 64) {
    const entries = [...this.index.values()].sort((a, b) => b.at - a.at || b.ref.localeCompare(a.ref));
    const out = [];
    for (const entry of entries) {
      if (!this.matchesFilters(entry, filter)) continue;
      out.push(entry);
      if (out.length >= limit) break;
    }
    return out.reverse();
  }
  // Every match, oldest-first. Recovery truth (delivery outcomes, plan step
  // state, attempt bindings) must never be decided by a fixed oldest-N window,
  // so state projections scan the full derived index; the immutable events
  // stay the only authority.
  findEntriesAll(filter) {
    return [...this.index.values()]
      .sort((a, b) => a.at - b.at || a.ref.localeCompare(b.ref))
      .filter(entry => this.matchesFilters(entry, filter));
  }
  // Event ref of a recorded mail by message id. O(index) and memo-free; used
  // to turn message-id relations (reply_to/proposal) into ref relations at
  // query time, because ingest order never decides lookup availability.
  mailEventRef(messageID) {
    if (typeof messageID !== 'string') return null;
    for (const entry of this.index.values()) if (entry.type === 'trace.message' && entry.mailID === messageID) return entry.ref;
    return null;
  }
  async reconcile(limit = 64) {
    if (this.closed) return { scanned: 0, imported: 0 };
    if (!Number.isInteger(limit) || limit < 1 || limit > 128) throw new Error('Invalid reconcile batch');
    if (this.reconcileJob) return this.reconcileJob;
    const job = (async () => {
      if (!this.reconcileDirectory) this.reconcileDirectory = await fs.opendir(path.join(this.root, 'events'));
      let scanned = 0, imported = 0;
      while (!this.closed && scanned < limit) {
        const entry = await this.reconcileDirectory.read();
        if (!entry) { await this.reconcileDirectory.close(); this.reconcileDirectory = null; break; }
        scanned++;
        if (!/^evt_[a-f0-9]{64}\.json$/.test(entry.name)) continue;
        const ref = entry.name.slice(0, -5);
        if (this.seen.has(ref)) continue;
        try { await this.ingest(await this.readEvent(ref)); imported++; }
        catch (error) { this.warning('reconcile', error); }
      }
      return { scanned, imported, scan_complete: !this.reconcileDirectory, watcher: this.watcherState };
    })();
    this.reconcileJob = job;
    try { return await job; } finally {
      this.reconcileJob = null;
      if (this.closed && this.reconcileDirectory) {
        await this.reconcileDirectory.close().catch(() => {}); this.reconcileDirectory = null;
      }
    }
  }
  // Explicit orchestration decisions must see completed writes from another
  // worker process even when watching is unavailable. Unlike observer hooks,
  // these infrequent tool calls take one fresh directory snapshot and ingest
  // every unseen event in it before deciding a binding or settled outcome.
  async reconcileSnapshot() {
    if (this.closed) return;
    const names = await fs.readdir(path.join(this.root, 'events'));
    for (const name of names) {
      if (!/^evt_[a-f0-9]{64}\.json$/.test(name)) continue;
      const ref = name.slice(0, -5);
      if (!this.seen.has(ref)) await this.ingest(await this.readEvent(ref));
    }
  }
  session(id) {
    if (!this.sessions.has(id)) this.sessions.set(id, { sessionID: id, recent: [], notes: [], milestones: [], conflicts: [], intent_conflicts: [], pending: {}, compact: null, intent: null, lastActivity: 0 });
    const s = this.sessions.get(id);
    if (!s.milestones) s.milestones = [];
    return s;
  }
  async blob(value, encoding = 'json') {
    const data = Buffer.from(encoding === 'json' ? stable(value) : value);
    const digest = hash(data), ref = `blob_${digest}`;
    await atomic(path.join(this.root, 'blobs', digest.slice(0, 2), digest), data, true);
    return { ref, sha256: digest, bytes: data.length, encoding };
  }
  async readBlob(ref) {
    if (!/^blob_[a-f0-9]{64}$/.test(ref)) throw new Error(`Invalid blob ref ${String(ref).slice(0, 80)}: expected blob_<64hex>`);
    const digest = ref.slice(5);
    let data;
    try {
      data = await fs.readFile(path.join(this.root, 'blobs', digest.slice(0, 2), digest));
    } catch (error) {
      if (error?.code) throw ioError('Blob', ref, error);
      throw error;
    }
    if (hash(data) !== digest) throw new Error('Blob hash mismatch');
    return data;
  }
  // Bounded byte-range read for budgeted candidate scans. Reads exactly
  // [start, start+length) without loading the whole blob; the chunk is NOT
  // hash-verified because it is discovery only - exact evidence always goes
  // through expand(), which verifies the full blob.
  async readBlobRange(ref, start, length) {
    if (!/^blob_[a-f0-9]{64}$/.test(ref)) throw new Error(`Invalid blob ref ${String(ref).slice(0, 80)}: expected blob_<64hex>`);
    if (!Number.isInteger(start) || start < 0 || !Number.isInteger(length) || length < 1) throw new Error('Invalid blob range');
    const digest = ref.slice(5);
    let handle;
    try {
      handle = await fs.open(path.join(this.root, 'blobs', digest.slice(0, 2), digest), 'r');
    } catch (error) {
      if (error?.code) throw ioError('Blob', ref, error);
      throw error;
    }
    try {
      const { size } = await handle.stat();
      const want = Math.min(length, Math.max(0, size - start));
      if (want <= 0) return { chunk: Buffer.alloc(0), size, read: 0 };
      const chunk = Buffer.alloc(want);
      const { bytesRead } = await handle.read(chunk, 0, want, start);
      return { chunk: chunk.subarray(0, bytesRead), size, read: bytesRead };
    } finally { await handle.close(); }
  }
  async readEvent(ref) {
    if (!/^evt_[a-f0-9]{64}$/.test(ref)) throw new Error(`Invalid event ref ${String(ref).slice(0, 80)}: expected evt_<64hex>`);
    let event;
    try {
      event = JSON.parse(await fs.readFile(path.join(this.root, 'events', `${ref}.json`), 'utf8'));
    } catch (error) {
      if (error?.code) throw ioError('Event', ref, error);
      throw error;
    }
    const { at, ref: actual, ...body } = event;
    if (actual !== ref || `evt_${hash(stable(body))}` !== ref || body.workspaceID !== this.workspaceID || body.schema !== 1) throw new Error('Event integrity mismatch');
    return event;
  }
  async exists(ref) {
    if (!refPattern.test(ref)) throw new Error(`Invalid source ref ${String(ref).slice(0, 80)}: expected evt_<64hex> or blob_<64hex>`);
    return ref.startsWith('evt_') ? this.readEvent(ref) : this.readBlob(ref);
  }
  async record(type, host, data, extra = {}) {
    const payload = await this.blob(data);
    // Replay guard: an identical causality-free body (retry / duplicate
    // delivery) dedupes to the earlier event WITHOUT consuming a sequence
    // number. Bounded map; cross-process replays are documented as outside
    // this guarantee (single-writer workspace is the norm).
    const v1 = { schema: 1, workspaceID: this.workspaceID, type, host, payload, ...extra };
    const replayKey = stable(v1);
    const seenRef = this.replayGuard.get(replayKey);
    if (seenRef) {
      const prior = await this.readEvent(seenRef).catch(() => null);
      if (prior) return prior;
      this.replayGuard.delete(replayKey);
    }
    // Phase B causality: durable per-session sequence + chain link, allocated
    // atomically so the event ref is derived inside the critical section.
    // Crash after allocation but before persistence leaves a detectable
    // sequence gap (Phase C coverage marks it; never rewritten).
    let body = v1, ref = `evt_${hash(stable(body))}`;
    if (this.sequences && host?.sessionID) {
      const built = await this.sequences.allocate(host.sessionID, (session_seq, previous_event_ref) => {
        const body2 = { ...v1, event_schema: 2, session_seq, ...(previous_event_ref ? { previous_event_ref } : {}) };
        return { ref: `evt_${hash(stable(body2))}`, body: body2 };
      });
      body = built.body;
      ref = built.ref;
    }
    if (this.replayGuard.size >= 1024) this.replayGuard.delete(this.replayGuard.keys().next().value);
    this.replayGuard.set(replayKey, ref);
    let event;
    try { event = await this.readEvent(ref); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      event = { ...body, ref, at: Date.now() };
      // Racing identical writers must reuse the first durable timestamp.
      const filename = path.join(this.root, 'events', `${ref}.json`);
      try { await atomic(filename, stable(event), true); }
      catch (writeError) {
        const existing = await this.readEvent(ref).catch(() => null);
        if (!existing) throw writeError;
        event = existing;
      }
    }
    await this.ingest(event);
    if (host.sessionID) await atomic(path.join(this.root, 'sessions', `${hash(host.sessionID)}.json`), stable(this.session(host.sessionID)));
    return event;
  }
  reduce(event, hostCreated = event.compact?.host_created_at) {
    if (this.seen.has(event.ref)) return;
    this.seen.add(event.ref);
    const sid = event.host.sessionID;
    if (!sid) return;
    const s = this.session(sid), item = { ref: event.ref, type: event.type, at: event.at, tool: event.tool, status: event.status, source: event.source, outputs: event.outputs };
    s.recent = keep(s.recent, item, 32);
    // Deterministic precedence: observation time first, then the content-hash
    // ref as an explicit tie-break (same pattern as compaction ordering).
    // Arrival order is never treated as causality, so out-of-order watch,
    // reconcile batches and restarts converge to the identical projection.
    if (!s.identityRef || event.at > s.lastActivity || (event.at === s.lastActivity && event.ref.localeCompare(s.identityRef) > 0)) {
      Object.assign(s, event.host); s.lastActivity = event.at; s.identityRef = event.ref;
    }
    if (event.type === 'trace.note') {
      const noteItem = { ...item, ...event.note };
      s.notes = keep(s.notes, noteItem, 64);
      if (!s.milestones) s.milestones = [];
      const isMilestone = Boolean(
        event.note?.milestone || event.note?.supersedes?.length ||
        ['decision', 'unresolved', 'baseline', 'handoff', 'correction', 'blocker', 'verification', 'state_change'].includes(event.note?.kind)
      );
      if (isMilestone) {
        if (!s.milestones.some(m => m.ref === noteItem.ref)) {
          s.milestones.push(noteItem);
          s.milestones.sort((a, b) => a.at - b.at || a.ref.localeCompare(b.ref));
        }
        if (s.milestones.length > 256) {
          const allSuperseded = new Set(s.milestones.flatMap(m => (m.supersedes ?? []).concat(m.milestone?.supersedes ?? [])));
          const unsuperseded = s.milestones.filter(m => !allSuperseded.has(m.ref));
          const superseded = s.milestones.filter(m => allSuperseded.has(m.ref)).slice(-32);
          s.milestones = [...unsuperseded, ...superseded].sort((a, b) => a.at - b.at || a.ref.localeCompare(b.ref));
        }
      }
    }
    if (event.type === 'trace.intent') {
      const cur = s.intent;
      // Same-millisecond intents are concurrent declarations with no provable
      // order: keep the conflict visible instead of silently collapsing them,
      // and never claim the tie-break is a semantic "latest decision".
      if (cur && cur.at === event.at && cur.ref !== event.ref) {
        const refs = [event.ref, cur.ref].sort();
        s.intent_conflicts = keep(s.intent_conflicts, { ref: refs.join('~'), at: event.at, refs }, 8);
      }
      if (!cur || event.at > cur.at || (event.at === cur.at && event.ref.localeCompare(cur.ref) > 0)) s.intent = { ...item, ...event.intent };
    }
    if (event.type === 'tool.before') {
      // after can arrive first through filesystem watch or reconcile batches;
      // never reopen a terminal call. Terminal evidence is rebuilt from every
      // ingested tool.after and outlives the bounded pending display window.
      if (!s.pending[event.callKey]?.terminal && !this.terminalCalls.has(event.callKey)) s.pending[event.callKey] = { ...item, paths: event.paths, callKey: event.callKey };
    }
    if (event.type === 'tool.after') {
      this.terminalCalls.add(event.callKey);
      s.pending[event.callKey] = { terminal: true, at: event.at };
    }
    // Completed entries are only replay guards; retain a bounded window, not outputs.
    const completed = Object.entries(s.pending).filter(([, v]) => v.terminal).sort((a, b) => b[1].at - a[1].at);
    for (const [key] of completed.slice(128)) delete s.pending[key];
    if (event.type === 'compaction') {
      const candidate = { ...item, ...event.compact, host_created_at: hostCreated ?? null,
        host_message_id: event.host.messageID ?? '', chronology_unknown: !Number.isFinite(hostCreated) };
      const a = candidate.host_created_at ?? -Infinity, b = s.compact?.host_created_at ?? -Infinity;
      // Host creation time orders compactions, never local observation time.
      // Equal/missing times use an explicit deterministic tie-break, not a
      // claim that opaque IDs prove chronology.
      if (!s.compact || a > b || (a === b && candidate.host_message_id.localeCompare(s.compact.host_message_id) > 0)) s.compact = candidate;
    }
    if (event.type === 'session.lifecycle') {
      if (!s.observation || event.at > s.observation.at || (event.at === s.observation.at && event.ref.localeCompare(s.observation.ref) > 0)) {
        s.lifecycle = event.lifecycle;
        s.observation = { lifecycle: event.lifecycle, at: event.at, ref: event.ref, hostEventID: event.hostEventID ?? null };
      }
      // Execution completion is not session termination. Keep explicit deletion
      // evidence separate from both the last observation and declared intent.
      if (event.lifecycle === 'session.deleted') s.deleted = { ref: event.ref, at: event.at, hostEventID: event.hostEventID ?? null };
    }
    if (event.type === 'coordination.advisory') {
      for (const peer of event.peers) {
        const target = this.session(peer);
        target.conflicts = keep(target.conflicts, { ...item, peers: event.peers, paths: event.paths, resources: event.resources }, 16);
      }
    }
  }
  async expand(ref, offset = 0, limit = 2048, metadataOnly = false) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 24000) throw new Error('Invalid expansion range');
    if (typeof metadataOnly !== 'boolean') throw new Error('Invalid metadata_only');
    if (typeof ref !== 'string' || !refPattern.test(ref)) throw new Error(`Invalid ref ${String(ref).slice(0, 80)}: expected evt_<64hex> or blob_<64hex>`);
    let event, data;
    if (ref.startsWith('evt_')) {
      event = await this.readEvent(ref); data = await this.readBlob(event.payload.ref);
    } else data = await this.readBlob(ref);
    // UTF-8 byte pagination uses base64 too, so arbitrary boundaries are lossless.
    const chunk = metadataOnly ? Buffer.alloc(0) : data.subarray(offset, offset + limit);
    // Unified relation discovery across event kinds: note source/supersedes/
    // depends_on, intent related_refs, compact refs, outputs, advisory payload
    // source_refs, mailbox/plan structured relations (message source_refs,
    // step result_ref/worker_source_refs, worker result source_refs/binding_ref)
    // and message-id links (reply/proposal) resolved to their event refs.
    // This list is a convenience view; absence here never proves the payload
    // lacks relations (trace_find searches the full index).
    const inlineRels = [
      event?.payload.ref, ...(event?.outputs ?? []).map(x => x.ref),
      ...(event?.note?.source_refs ?? []), ...(event?.note?.supersedes ?? []), ...(event?.note?.depends_on ?? []),
      ...(event?.intent?.related_refs ?? []), ...(event?.compact?.refs ?? []),
    ];
    const structured = { 'trace.message': ['source_refs'], 'trace.step': ['result_ref', 'worker_source_refs'], 'trace.step.result': ['source_refs', 'binding_ref'] }[event?.type];
    if (structured && (event.payload?.bytes ?? Infinity) <= 65536) {
      try {
        const parsed = JSON.parse(data.toString());
        for (const key of structured) {
          const v = parsed?.[key];
          if (typeof v === 'string' && refPattern.test(v)) inlineRels.push(v);
          if (Array.isArray(v)) for (const r of v) if (typeof r === 'string' && refPattern.test(r)) inlineRels.push(r);
        }
      } catch (error) { this.warning('expand_structured_rels', error); }
    }
    if (event?.type === 'coordination.advisory' && (event.payload?.bytes ?? Infinity) <= 65536) {
      try { for (const r of JSON.parse(data.toString())?.source_refs ?? []) if (refPattern.test(r)) inlineRels.push(r); }
      catch (error) { this.warning('expand_advisory_rels', error); }
    }
    for (const id of [event?.reply_to, event?.proposal]) {
      const parentRef = this.mailEventRef(id);
      if (parentRef) inlineRels.push(parentRef);
    }
    // Phase B causal projection: chain/causality metadata of this event plus
    // resulting events (children) derived from the in-memory index. Additive
    // and bounded; absent fields mean the event predates event_schema 2.
    let causal = null;
    if (event?.session_seq != null) {
      causal = { session_seq: event.session_seq, ...(event.previous_event_ref ? { previous: event.previous_event_ref } : {}),
        ...(event.caused_by ? { caused_by: event.caused_by } : {}), ...(event.parent_event_ref ? { parent: event.parent_event_ref } : {}) };
    }
    const children = [];
    if (ref.startsWith('evt_')) {
      for (const entry of this.index.values()) {
        if (children.length >= 16) break;
        if (entry.previous === ref || entry.causedBy === ref || entry.parent === ref) children.push(entry.ref);
      }
    }
    return { ref, payload_ref: event?.payload.ref ?? ref, sha256: hash(data), hash_verified: true,
      metadata_only: metadataOnly, offset, limit, returned_bytes: chunk.length, total_bytes: data.length,
      next_offset: offset + chunk.length < data.length ? offset + chunk.length : null,
      metadata: event ?? { sha256: hash(data), bytes: data.length }, source: event?.source ?? null,
      related_refs: [...new Set(inlineRels.filter(Boolean))],
      ...(causal ? { causal } : {}), ...(children.length ? { children } : {}),
      text_blobs: event?.outputs ?? [],
      ...(metadataOnly ? {} : { exact_utf8: chunk.toString('utf8'), exact_base64: chunk.toString('base64'), encoding: 'utf8; base64 preserves page-boundary bytes' }) };
  }
  async storageUsage() {
    const groups = {};
    async function walk(directory, group) {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(filename, group);
        else if (entry.isFile()) {
          const s = await fs.stat(filename);
          group.objects++; group.bytes += s.size; group.allocated_file_bytes += s.blocks * 512;
        }
      }
    }
    for (const name of ['events', 'blobs', 'sessions', 'recall', 'intents', 'state']) {
      groups[name] = { objects: 0, bytes: 0, allocated_file_bytes: 0 };
      await walk(path.join(this.root, name), groups[name]);
    }
    const disk = await fs.statfs(this.root).catch(() => null);
    return { observed_at: Date.now(), consistency: 'best_effort_snapshot; concurrent writes may change totals',
      total_bytes: Object.values(groups).reduce((n, g) => n + g.bytes, 0),
      object_count: Object.values(groups).reduce((n, g) => n + g.objects, 0), groups,
      filesystem_available_bytes: disk ? disk.bavail * disk.bsize : null,
      retention: 'No automatic deletion or disk quota. File allocation excludes directory metadata.' };
  }
}
