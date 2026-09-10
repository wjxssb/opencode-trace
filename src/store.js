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
  }
  async init() {
    this.workspace = await canonical(this.workspace);
    this.workspaceID = hash(this.workspace);
    this.root = path.join(this.base, 'workspaces', this.workspaceID);
    for (const d of ['events', 'blobs', 'sessions', 'recall', 'intents', 'state']) await fs.mkdir(path.join(this.root, d), { recursive: true, mode: 0o700 });
    // Watch before recovery to cover concurrent writers during the one startup scan.
    this.watcher = watch(path.join(this.root, 'events'), (_event, filename) => {
      if (!/^evt_[a-f0-9]{64}\.json$/.test(filename ?? '')) return;
      const job = this.readEvent(filename.slice(0, -5)).then(e => this.reduce(e)).catch(e => this.warning('watch', e));
      this.watchJobs.add(job); job.finally(() => this.watchJobs.delete(job));
    });
    this.watcher.unref();
    const names = (await fs.readdir(path.join(this.root, 'events'))).filter(x => /^evt_[a-f0-9]{64}\.json$/.test(x));
    const recovered = [];
    for (const name of names) {
      try { recovered.push(await this.readEvent(name.slice(0, -5))); }
      catch (error) { this.warning('recovery', error); }
    }
    recovered.sort((a, b) => a.at - b.at || a.ref.localeCompare(b.ref));
    for (const event of recovered) this.reduce(event);
    await atomic(path.join(this.root, 'state', 'schema.json'), stable({ schema: 1, workspace: this.workspace, workspaceID: this.workspaceID }));
    return this;
  }
  close() { this.watcher?.close(); }
  async flush() { await Promise.allSettled([...this.watchJobs]); }
  session(id) {
    if (!this.sessions.has(id)) this.sessions.set(id, { sessionID: id, recent: [], notes: [], conflicts: [], pending: {}, compact: null, intent: null, lastActivity: 0 });
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
    this.reduce(event);
    if (host.sessionID) await atomic(path.join(this.root, 'sessions', `${hash(host.sessionID)}.json`), stable(this.session(host.sessionID)));
    return event;
  }
  reduce(event) {
    if (this.seen.has(event.ref)) return;
    this.seen.add(event.ref);
    const sid = event.host.sessionID;
    if (!sid) return;
    const s = this.session(sid), item = { ref: event.ref, type: event.type, at: event.at, tool: event.tool, status: event.status, source: event.source };
    s.recent = keep(s.recent, item, 32);
    if (event.at >= s.lastActivity) {
      Object.assign(s, event.host); s.lastActivity = event.at;
    }
    if (event.type === 'trace.note') s.notes = keep(s.notes, { ...item, ...event.note }, 64);
    if (event.type === 'trace.intent' && event.at >= (s.intent?.at ?? 0)) s.intent = { ...item, ...event.intent };
    if (event.type === 'tool.before') {
      // after can arrive first through filesystem watch; never reopen a terminal call.
      const terminal = s.pending[event.callKey]?.terminal;
      if (!terminal) s.pending[event.callKey] = { ...item, paths: event.paths, callKey: event.callKey };
    }
    if (event.type === 'tool.after') s.pending[event.callKey] = { terminal: true, at: event.at };
    // Completed entries are only replay guards; retain a bounded window, not outputs.
    const completed = Object.entries(s.pending).filter(([, v]) => v.terminal).sort((a, b) => b[1].at - a[1].at);
    for (const [key] of completed.slice(128)) delete s.pending[key];
    if (event.type === 'compaction' && event.at >= (s.compact?.at ?? 0)) s.compact = { ...item, ...event.compact };
    if (event.type === 'session.lifecycle') s.lifecycle = event.lifecycle;
    if (event.type === 'coordination.advisory') {
      for (const peer of event.peers) {
        const target = this.session(peer);
        target.conflicts = keep(target.conflicts, { ...item, peers: event.peers, paths: event.paths, resources: event.resources }, 16);
      }
    }
  }
  async expand(ref, offset = 0, limit = 12000) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 24000) throw new Error('Invalid expansion range');
    let event, data;
    if (ref.startsWith('evt_')) {
      event = await this.readEvent(ref); data = await this.readBlob(event.payload.ref);
    } else data = await this.readBlob(ref);
    // UTF-8 byte pagination uses base64 too, so arbitrary boundaries are lossless.
    const chunk = data.subarray(offset, offset + limit);
    return { ref, metadata: event ?? { sha256: hash(data), bytes: data.length }, source: event?.source ?? null,
      related_refs: [event?.payload.ref, ...(event?.outputs ?? []).map(x => x.ref), ...(event?.note?.source_refs ?? []), ...(event?.compact?.refs ?? [])].filter(Boolean),
      offset, total_bytes: data.length, next_offset: offset + chunk.length < data.length ? offset + chunk.length : null,
      exact_utf8: chunk.toString('utf8'), exact_base64: chunk.toString('base64'), encoding: 'utf8; base64 preserves page-boundary bytes' };
  }
}
