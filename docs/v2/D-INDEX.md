# Phase D — Persistent, Disposable, Rebuildable Derived Index

Status: IMPLEMENTED + QUALIFIED (tests/derived-index.test.js 12/12; full suite 233/232/0/1).
Backend: `node:sqlite` (DatabaseSync, no flag needed on node 22.16) + FTS5.

## Authority boundary

CAS is the only authority. The SQLite file (`<storeRoot>/derived/index.db`) is a
derived mirror of the in-memory ingested index: it can be deleted or corrupted
at any time without affecting evidence. `trace_expand` remains the verified
path; FTS/SQL results are DISCOVERY CANDIDATES only.

## Schema

- `events`: ref (PK), session, seq, at, type, tool, status, path, caused_by,
  previous, parent, payload_ref, json (full index entry) — indexes on
  session/type/tool/caused_by.
- `events_fts`: FTS5(ref UNINDEXED, text) over type+tool+status+payload hints
  (4KB cap). DISTINCT ref lookups (FTS5 rows are not unique by ref).
- `meta`: `cas_count` watermark (rows mirrored), maintained by write-through
  upserts and rebuilds.

## Operations

- Write-through: `store.indexEvent` -> `derivedIndex.upsert(entry)` (sync,
  µs-scale; any failure degrades the mirror to `state: 'error'`, memory-only).
- Startup: open; if `meta.cas_count != recovered index size` -> full rebuild
  from the authoritative in-memory index (transactional).
- `rebuild()`: DELETE + transactional reinsert from `store.index` — provably
  equivalent across runs (D3).
- `status()`: {enabled, state, error, rebuilds, indexed_through, index_lag,
  backend} — surfaced in trace_find coverage + trace_status (`derived_index`).
- Degradation: index unavailable -> memory queries + CAS reads + expand all
  keep working (D10).

## Search flow

in-memory structured filters (as before) -> if text query under-filled:
`ftsCandidates(text)` fallback (multi-token AND matching beyond the 8-hint
in-memory cap) -> merge into results -> deep scan fallback unchanged ->
`trace_expand` for verified bytes. Search results keep V2-A discovery handles.

## Performance (measured, this environment)

rebuild of 300 events: **7.4ms**; FTS query: **0.16ms**. Write-through upsert
adds sub-millisecond per event. The startup recovery scan remains the dominant
cost; a startup fast-path (load sessions/index from SQLite without per-file
JSON parsing) is deliberately deferred to Phase G, where the sidecar becomes
the index owner.

## Test matrix results

D1 empty build, D2 full rebuild, D3 rebuild equivalence, D4 FTS text (with
DISTINCT-ref dedupe), D5 path, D6 tool, D7 session, D8 causal caused_by
query, D9 deletion recovery, D10 corruption degradation+rebuild, D11 lag
measure+repair, D12 candidate -> verified expand, D14 handles on results,
D15 performance bounds — all pass. D13 is covered by C8/C9.
