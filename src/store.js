import * as fs from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { atomic, canonical, hash, stable, refPattern } from './util.js';

const keep = (items, item, limit) => [...items.filter(x => x.ref !== item.ref), item].sort((a, b) => a.at - b.at || a.ref.localeCompare(b.ref)).slice(-limit);

export class Store {
  constructor(workspace, root = path.join(os.homedir(), '.local/share/opencode-trace'), warning = () => {}) {
    this.workspace = workspace; this.base = root; this.warning = warning;
    this.sessions = new Map(); this.seen = new Set(); this.watchJobs = new Set();
    this.watchRefs = new Set(); this.maxWatchJobs = 16; this.missedWatchEvents = 0;
    // Completed tool calls, rebuilt from every ingested tool.after event.
    // Terminal evidence must not depend on the bounded pending display window:
    // a late out-of-order tool.before (watch overflow, reconcile batch order)
    // must never reopen a finished call. callKeys are 64-hex digests, not
    // outputs, so the in-memory set stays small for realistic sessions.
    this.terminalCalls = new Set();
  }
  async init() {
    this.workspace = await canonical(this.workspace);
    this.workspaceID = hash(this.workspace);
    this.root = path.join(this.base, 'workspaces', this.workspaceID);
    for (const d of ['events', 'blobs', 'sessions', 'recall', 'intents', 'state']) await fs.mkdir(path.join(this.root, d), { recursive: true, mode: 0o700 });
    // Watch before recovery to cover concurrent writers during the one startup scan.
    this.watcher = watch(path.join(this.root, 'events'), (_event, filename) => {
      if (!/^evt_[a-f0-9]{64}\.json$/.test(filename ?? '')) return;
      const ref = filename.slice(0, -5);
      if (this.seen.has(ref) || this.watchRefs.has(ref)) return;
      if (this.watchJobs.size >= this.maxWatchJobs) { this.missedWatchEvents++; return; }
      this.watchRefs.add(ref);
      const job = this.readEvent(ref).then(e => this.ingest(e)).catch(e => this.warning('watch', e));
      this.watchJobs.add(job); job.finally(() => { this.watchJobs.delete(job); this.watchRefs.delete(ref); });
    });
    this.watcher.unref();
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
      return { scanned, imported };
    })();
    this.reconcileJob = job;
    try { return await job; } finally {
      this.reconcileJob = null;
      if (this.closed && this.reconcileDirectory) {
        await this.reconcileDirectory.close().catch(() => {}); this.reconcileDirectory = null;
      }
    }
  }
  session(id) {
    if (!this.sessions.has(id)) this.sessions.set(id, { sessionID: id, recent: [], notes: [], conflicts: [], intent_conflicts: [], pending: {}, compact: null, intent: null, lastActivity: 0 });
    return this.sessions.get(id);
  }
  async blob(value, encoding = 'json') {
    const data = Buffer.from(encoding === 'json' ? stable(value) : value);
    const digest = hash(data), ref = `blob_${digest}`;
    await atomic(path.join(this.root, 'blobs', digest.slice(0, 2), digest), data, true);
    return { ref, sha256: digest, bytes: data.length, encoding };
  }
  async readBlob(ref) {
    if (!/^blob_[a-f0-9]{64}$/.test(ref)) throw new Error('Invalid blob ref');
    const digest = ref.slice(5);
    const data = await fs.readFile(path.join(this.root, 'blobs', digest.slice(0, 2), digest));
    if (hash(data) !== digest) throw new Error('Blob hash mismatch');
    return data;
  }
  async readEvent(ref) {
    if (!/^evt_[a-f0-9]{64}$/.test(ref)) throw new Error('Invalid event ref');
    const event = JSON.parse(await fs.readFile(path.join(this.root, 'events', `${ref}.json`), 'utf8'));
    const { at, ref: actual, ...body } = event;
    if (actual !== ref || `evt_${hash(stable(body))}` !== ref || body.workspaceID !== this.workspaceID || body.schema !== 1) throw new Error('Event integrity mismatch');
    return event;
  }
  async exists(ref) {
    if (!refPattern.test(ref)) throw new Error('Invalid source ref');
    return ref.startsWith('evt_') ? this.readEvent(ref) : this.readBlob(ref);
  }
  async record(type, host, data, extra = {}) {
    const payload = await this.blob(data);
    const body = { schema: 1, workspaceID: this.workspaceID, type, host, payload, ...extra };
    const ref = `evt_${hash(stable(body))}`;
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
    if (event.type === 'trace.note') s.notes = keep(s.notes, { ...item, ...event.note }, 64);
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
    let event, data;
    if (ref.startsWith('evt_')) {
      event = await this.readEvent(ref); data = await this.readBlob(event.payload.ref);
    } else data = await this.readBlob(ref);
    // UTF-8 byte pagination uses base64 too, so arbitrary boundaries are lossless.
    const chunk = metadataOnly ? Buffer.alloc(0) : data.subarray(offset, offset + limit);
    return { ref, payload_ref: event?.payload.ref ?? ref, sha256: hash(data), hash_verified: true,
      metadata_only: metadataOnly, offset, limit, returned_bytes: chunk.length, total_bytes: data.length,
      next_offset: offset + chunk.length < data.length ? offset + chunk.length : null,
      metadata: event ?? { sha256: hash(data), bytes: data.length }, source: event?.source ?? null,
      related_refs: [event?.payload.ref, ...(event?.outputs ?? []).map(x => x.ref), ...(event?.note?.source_refs ?? []), ...(event?.compact?.refs ?? [])].filter(Boolean),
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
