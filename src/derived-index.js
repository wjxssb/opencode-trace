// Phase D: persistent, disposable, rebuildable derived search index.
//
// CAS remains the ONLY authority. This SQLite index is a derived mirror of
// the in-memory ingested index: deleting it is always safe, and `rebuild()`
// recreates it from the authoritative in-memory state (itself rebuilt from
// CAS at startup). Any index failure degrades to memory-only operation —
// CAS reads and trace_expand never depend on it.
//
// Schema: `events` (structured fields) + `events_fts` (FTS5 over searchable
// text) + `meta` (rebuild watermark). FTS results are DISCOVERY candidates;
// verified evidence always goes through trace_expand (hash-checked bytes).
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  ref TEXT PRIMARY KEY, session TEXT, seq INTEGER, at INTEGER, type TEXT,
  tool TEXT, status TEXT, path TEXT, caused_by TEXT, previous TEXT,
  parent TEXT, payload_ref TEXT, json TEXT);
CREATE INDEX IF NOT EXISTS ev_session ON events(session);
CREATE INDEX IF NOT EXISTS ev_type ON events(type);
CREATE INDEX IF NOT EXISTS ev_tool ON events(tool);
CREATE INDEX IF NOT EXISTS ev_caused ON events(caused_by);
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(ref UNINDEXED, text);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`;

export class DerivedIndex {
  constructor(store, dir) {
    this.store = store;
    this.dir = dir;
    this.db = null;
    this.state = 'closed';          // closed | ready | error | rebuilding
    this.error = null;
    this.rebuilds = 0;
    this.persistedCount = 0;        // watermark: rows mirrored from CAS
  }

  async open() {
    try {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      this.db = new DatabaseSync(path.join(this.dir, 'index.db'));
      this.db.exec(SCHEMA);
      this.persistedCount = Number(this.db.prepare("SELECT v FROM meta WHERE k='cas_count'").get()?.v ?? 0);
      this.state = 'ready';
      return true;
    } catch (error) {
      this.db = null; this.state = 'error'; this.error = String(error?.message ?? error).slice(0, 200);
      return false;
    }
  }

  /** Write-through upsert from store.indexEvent. Degrades to memory-only. */
  upsert(entry) {
    if (!this.db || this.state === 'error') return;
    try {
      const text = [entry.type, entry.tool ?? '', entry.status ?? '', ...(entry.hints ?? [])].join(' ').slice(0, 4000);
      this.db.prepare('INSERT OR REPLACE INTO events (ref, session, seq, at, type, tool, status, path, caused_by, previous, parent, payload_ref, json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(entry.ref, entry.sessionID, entry.seq, entry.at, entry.type, entry.tool ?? null, entry.status ?? null,
          entry.source?.path ?? entry.source?.filePath ?? (Array.isArray(entry.paths) ? entry.paths[0] : null),
          entry.causedBy ?? null, entry.previous ?? null, entry.parent ?? null, entry.payloadRef,
          JSON.stringify({ ...entry, hints: entry.hints ?? [] }));
      this.db.prepare('INSERT OR REPLACE INTO events_fts (ref, text) VALUES (?,?)').run(entry.ref, text);
      this.db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('cas_count', ?)").run(String(++this.persistedCount));
    } catch (error) {
      this.state = 'error'; this.error = String(error?.message ?? error).slice(0, 200);
      try { this.db?.close(); } catch {}
      this.db = null; // degrade honestly; memory index remains authoritative for queries
    }
  }

  /** Full rebuild from the authoritative in-memory index (itself from CAS). */
  async rebuild() {
    if (!this.db) return { rebuilt: false, reason: this.error ?? 'index unavailable' };
    this.state = 'rebuilding';
    try {
      this.db.exec('DELETE FROM events; DELETE FROM events_fts;');
      const insert = this.db.prepare('INSERT OR REPLACE INTO events (ref, session, seq, at, type, tool, status, path, caused_by, previous, parent, payload_ref, json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
      const fts = this.db.prepare('INSERT OR REPLACE INTO events_fts (ref, text) VALUES (?,?)');
      this.db.exec('BEGIN');
      try {
        let n = 0;
        for (const entry of this.store.index.values()) {
          const text = [entry.type, entry.tool ?? '', entry.status ?? '', ...(entry.hints ?? [])].join(' ').slice(0, 4000);
          insert.run(entry.ref, entry.sessionID, entry.seq, entry.at, entry.type, entry.tool ?? null, entry.status ?? null,
            entry.source?.path ?? entry.source?.filePath ?? (Array.isArray(entry.paths) ? entry.paths[0] : null),
            entry.causedBy ?? null, entry.previous ?? null, entry.parent ?? null, entry.payloadRef,
            JSON.stringify({ ...entry, hints: entry.hints ?? [] }));
          fts.run(entry.ref, text);
          n++;
        }
        this.db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('cas_count', ?)").run(String(n));
        this.db.exec('COMMIT');
        this.state = 'ready'; this.error = null; this.rebuilds++; this.persistedCount = n;
        return { rebuilt: true, indexed: n };
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } catch (error) {
      this.state = 'error'; this.error = String(error?.message ?? error).slice(0, 200);
      return { rebuilt: false, reason: this.error };
    }
  }

  /**
   * FTS candidate refs for free text. Discovery only — never evidence.
   * Returns refs whose indexed text matches; callers must still verify
   * through trace_expand for proof.
   */
  ftsCandidates(text, limit = 50) {
    if (!this.db || this.state !== 'ready' || !text) return [];
    try {
      const query = String(text).split(/\s+/).filter(Boolean).map(w => `"${w.replace(/"/g, '""')}"`).join(' ');
      if (!query) return [];
      return this.db.prepare('SELECT DISTINCT ref FROM events_fts WHERE events_fts MATCH ? LIMIT ?').all(query, limit).map(r => r.ref);
    } catch { return []; }
  }

  /** Structured candidate refs (path/tool/session/causal filters). */
  structured(filters = {}, limit = 50) {
    if (!this.db || this.state !== 'ready') return [];
    const where = [], args = [];
    for (const [col, value] of [['session', filters.session], ['type', filters.type], ['tool', filters.tool], ['status', filters.status], ['caused_by', filters.caused_by], ['previous', filters.previous], ['parent', filters.parent]]) {
      if (value != null) { where.push(`${col} = ?`); args.push(value); }
    }
    if (filters.path) { where.push('path LIKE ?'); args.push(`%${filters.path}%`); }
    if (!where.length) return [];
    try {
      return this.db.prepare(`SELECT ref FROM events WHERE ${where.join(' AND ')} LIMIT ?`).all(...args, limit).map(r => r.ref);
    } catch { return []; }
  }

  status() {
    const memory = this.store.index.size;
    let persisted = null;
    if (this.db && this.state === 'ready') {
      try { persisted = Number(this.db.prepare("SELECT v FROM meta WHERE k='cas_count'").get()?.v ?? 0); } catch {}
    }
    return {
      enabled: !!this.db, state: this.state, error: this.error, rebuilds: this.rebuilds,
      indexed_through: persisted, memory_events: memory,
      index_lag: persisted == null ? null : Math.max(0, memory - persisted),
      backend: 'node:sqlite (FTS5)',
      meaning: 'derived mirror only; CAS is authoritative; FTS results are candidates, evidence via trace_expand',
    };
  }

  async close() { try { this.db?.close(); } catch {} this.db = null; this.state = 'closed'; }
}
