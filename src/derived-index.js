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

const SCHEMA_VERSION = 4; // bump when the projection (columns/FTS shape) changes -> rebuild (4: CJK bigram expansion)

// node:sqlite bind contract: a bindable value is exactly null, string, number,
// bigint or Buffer. `undefined` and any object/array are REJECTED and — inside
// a transactional rebuild — reject one row poisons the whole rebuild. Every
// column therefore passes through a narrow normalizer; nothing unvalidated
// reaches StatementSync.run/.get/.all.
const bindText = value => (typeof value === 'string' ? value : null);
const bindInteger = value => (typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null);

// path column semantics: accept ONLY a primitive string. The first candidate
// that IS a string wins; otherwise NULL. Never String(object) — "[object
// Object]" would create garbage searchable paths. (Production defect
// 2026-09-21: an event with paths: [] made `paths[0]` undefined, and the
// `??` chain handed `undefined` — not null — to the bind.)
const firstStringPath = entry => {
  const candidates = [entry.source?.path, entry.source?.filePath, Array.isArray(entry.paths) ? entry.paths[0] : null];
  return candidates.find(value => typeof value === 'string') ?? null;
};

// One canonical row mapper for every events-table write (upsert + rebuild).
const indexRow = entry => ({
  ref: bindText(entry.ref),
  session: bindText(entry.sessionID),
  seq: bindInteger(entry.seq),
  at: bindInteger(entry.at),
  type: bindText(entry.type),
  tool: bindText(entry.tool),
  status: bindText(entry.status),
  path: firstStringPath(entry),
  caused_by: bindText(entry.causedBy),
  previous: bindText(entry.previous),
  parent: bindText(entry.parent),
  payload_ref: bindText(entry.payloadRef),
  json: JSON.stringify({ ...entry, hints: entry.hints ?? [] }),
});
const searchableText = entry => expandCjk([entry.type ?? '', entry.tool ?? '', entry.status ?? '', ...(entry.hints ?? [])].join(' ').slice(0, 4000));

// CJK recall (schema 4). FTS5's default unicode61 tokenizer keeps a run of
// CJK characters as ONE token, so a two-character word inside a longer run
// ("退磁" in "交流退磁方法") never matches; the trigram tokenizer needs >= 3
// characters and most Chinese words have 2. Measured on the production
// index (103,492 events): see docs/CJK-SEARCH.md. The indexed text keeps
// the original (Latin tokens unchanged) and appends each CJK run's character
// bigrams; queries turn each CJK run into the adjacent bigram phrase.
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const cjkBigrams = run => {
  const chars = [...run];
  const out = [];
  for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
  return out;
};
export const expandCjk = text => {
  const extra = [];
  for (const m of text.matchAll(CJK_RUN)) if ([...m[0]].length >= 2) extra.push(cjkBigrams(m[0]).join(' '));
  return extra.length ? `${text}\n${extra.join(' ')}` : text;
};
const quote = s => `"${s.replace(/"/g, '""')}"`;
/** Free text -> FTS5 query: every whitespace word must match (implicit AND);
 *  CJK parts become adjacent-bigram phrases, other parts plain phrases. */
export const ftsQuery = text => {
  const words = [];
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    let rest = word;
    const parts = [];
    for (const m of word.matchAll(CJK_RUN)) {
      const chars = [...m[0]];
      parts.push(chars.length >= 2 ? quote(cjkBigrams(m[0]).join(' ')) : quote(m[0]));
      rest = rest.replace(m[0], ' ');
    }
    for (const piece of rest.split(/\s+/)) if (/[\p{L}\p{N}]/u.test(piece)) parts.push(quote(piece));
    if (parts.length) words.push(parts.join(' '));
  }
  return words.join(' ');
};

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
    this.transactions = 0; this.busyErrors = 0; this.transactionTimes = [];
  }

  async open() {
    try {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      this.db = new DatabaseSync(path.join(this.dir, 'index.db'));
      // Phase G soak advisory: the host (read-mostly) and the capture writer
      // (single writer) share this DB; a busy timeout turns rare lock
      // contention into a short wait instead of an immediate SQLITE_BUSY.
      this.db.exec('PRAGMA busy_timeout = 2000');
      this.db.exec(SCHEMA);
      const version = this.db.prepare("SELECT v FROM meta WHERE k='schema_version'").get()?.v ?? null;
      this.persistedCount = Number(this.db.prepare("SELECT v FROM meta WHERE k='cas_count'").get()?.v ?? 0);
      this.staleVersion = version !== null && Number(version) !== SCHEMA_VERSION;
      const rowCount = Number(this.db.prepare('SELECT count(*) AS n FROM events').get().n);
      const ftsCount = Number(this.db.prepare('SELECT count(*) AS n FROM events_fts').get().n);
      if (rowCount !== this.persistedCount || ftsCount !== rowCount) this.staleVersion = true;
      this.state = 'ready';
      return !this.staleVersion;
    } catch (error) {
      try { this.db?.close(); } catch {}
      this.db = null; this.state = 'error'; this.error = String(error?.message ?? error).slice(0, 200);
      return false;
    }
  }

  /** Write-through upsert from store.indexEvent. Degrades to memory-only.
   *  One logical FTS row per ref (delete-before-insert — FTS5 rows are not
   *  unique by ref, so repeated upserts must not grow duplicate rows); the
   *  cas_count watermark counts UNIQUE indexed refs, not upsert calls. */
  upsert(entry) {
    if (!this.db || this.state === 'error') return;
    const started = performance.now();
    try {
      const row = indexRow(entry);
      if (row.ref == null) return; // refless entry cannot be indexed
      const text = searchableText(entry);
      this.db.exec('BEGIN IMMEDIATE');
      const known = this.db.prepare('SELECT 1 FROM events WHERE ref = ?').get(row.ref);
      this.db.prepare('INSERT OR REPLACE INTO events (ref, session, seq, at, type, tool, status, path, caused_by, previous, parent, payload_ref, json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(row.ref, row.session, row.seq, row.at, row.type, row.tool, row.status, row.path,
          row.caused_by, row.previous, row.parent, row.payload_ref, row.json);
      this.db.prepare('DELETE FROM events_fts WHERE ref = ?').run(row.ref);
      this.db.prepare('INSERT INTO events_fts (ref, text) VALUES (?,?)').run(row.ref, text);
      const count = this.persistedCount + (known ? 0 : 1);
      this.db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('cas_count', ?)").run(String(count));
      this.db.exec('COMMIT');
      this.persistedCount = count;
      this.transactions++;
    } catch (error) {
      if (/SQLITE_BUSY|database is locked/.test(String(error?.code ?? '') + ' ' + String(error?.message ?? ''))) this.busyErrors++;
      try { this.db?.exec('ROLLBACK'); } catch {}
      this.state = 'error'; this.error = String(error?.message ?? error).slice(0, 200);
      try { this.db?.close(); } catch {}
      this.db = null; // degrade honestly; memory index remains authoritative for queries
    } finally {
      this.transactionTimes.push(performance.now() - started);
      if (this.transactionTimes.length > 512) this.transactionTimes.shift();
    }
  }

  /** Full rebuild from the authoritative in-memory index (itself from CAS). */
  async rebuild() {
    if (!this.db) return { rebuilt: false, reason: this.error ?? 'index unavailable' };
    this.state = 'rebuilding';
    try {
      const insert = this.db.prepare('INSERT OR REPLACE INTO events (ref, session, seq, at, type, tool, status, path, caused_by, previous, parent, payload_ref, json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
      const fts = this.db.prepare('INSERT OR REPLACE INTO events_fts (ref, text) VALUES (?,?)');
      this.db.exec('BEGIN');
      try {
        this.db.exec('DELETE FROM events; DELETE FROM events_fts;');
        let n = 0;
        for (const entry of this.store.index.values()) {
          const row = indexRow(entry);
          if (row.ref == null) continue; // refless entry: skip, never poison the rebuild
          const text = searchableText(entry);
          insert.run(row.ref, row.session, row.seq, row.at, row.type, row.tool, row.status, row.path,
            row.caused_by, row.previous, row.parent, row.payload_ref, row.json);
          fts.run(row.ref, text);
          n++;
        }
        this.db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('cas_count', ?)").run(String(n));
        this.db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
        this.db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('built_at', ?)").run(String(Date.now()));
        this.db.exec('COMMIT');
        this.state = 'ready'; this.error = null; this.rebuilds++; this.persistedCount = n;
        return { rebuilt: true, indexed: n, schema_version: SCHEMA_VERSION };
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
      const query = ftsQuery(text);
      if (!query) return [];
      // bm25-ranked (FTS5 `rank`); one row per ref is maintained by upsert/rebuild
      const refs = this.db.prepare('SELECT ref FROM events_fts WHERE events_fts MATCH ? ORDER BY rank LIMIT ?').all(query, limit).map(r => r.ref);
      return [...new Set(refs)];
    } catch { return []; }
  }

  /** Structured candidate refs (path/tool/session/causal filters). */
  structured(filters = {}, limit = 50) {
    if (!this.db || this.state !== 'ready') return [];
    const where = [], args = [];
    // Query filters are never persisted data: normalize to SQLite-bindable
    // primitives (string/number) and ignore anything else rather than letting
    // an object/array reach a bind and flip the whole index to error.
    const bindable = value => (typeof value === 'string' || typeof value === 'number' ? value : null);
    for (const [col, value] of [['session', filters.session], ['type', filters.type], ['tool', filters.tool], ['status', filters.status], ['caused_by', filters.caused_by], ['previous', filters.previous], ['parent', filters.parent]]) {
      const bound = bindable(value);
      if (bound != null) { where.push(`${col} = ?`); args.push(bound); }
    }
    if (typeof filters.path === 'string' && filters.path) { where.push('path LIKE ?'); args.push(`%${filters.path}%`); }
    if (!where.length) return [];
    const max = bindInteger(limit) ?? 50;
    try {
      return this.db.prepare(`SELECT ref FROM events WHERE ${where.join(' AND ')} LIMIT ?`).all(...args, max).map(r => r.ref);
    } catch { return []; }
  }

  status() {
    const memory = this.store.index.size;
    // Last-known mirror watermark (in-memory, survives db handle loss) so a
    // suppressed/failing writer still reports honest lag instead of null.
    const persisted = this.persistedCount ?? null;
    const times = [...this.transactionTimes].sort((a, b) => a - b);
    const at = p => times.length ? times[Math.min(times.length - 1, Math.floor(p * times.length))] : null;
    return {
      enabled: !!this.db, state: this.state, error: this.error, rebuilds: this.rebuilds,
      indexed_through: persisted, memory_events: memory,
      index_lag: persisted == null ? null : Math.max(0, memory - persisted),
      backend: 'node:sqlite (FTS5)',
      transactions: this.transactions, busy_errors: this.busyErrors, busy_timeout_ms: 2000,
      transaction_ms: { p50: at(.5), p95: at(.95), p99: at(.99), samples: times.length,
        meaning: 'wall duration including any SQLite busy wait; wait is not separately attributed' },
      meaning: 'derived mirror only; CAS is authoritative; FTS results are candidates, evidence via trace_expand',
    };
  }

  async close() { try { this.db?.close(); } catch {} this.db = null; this.state = 'closed'; }
}
