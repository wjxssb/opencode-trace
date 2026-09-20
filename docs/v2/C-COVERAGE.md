# Phase C — Coverage Watermarks + Explicit Gaps

Status: IMPLEMENTED + QUALIFIED (tests/coverage.test.js 12/12; full suite 209+13 / 0 fail / 1 skip).

## Watermarks

- Per-session durable sequence watermark: `<storeRoot>/sequence/<hash>.state`
  (Phase B allocator) is the capture/persist watermark.
- In-memory ingest watermark (`CoverageTracker.lastSeq`) seeded from the index
  after recovery, then advanced per ingested schema-2 event.
- Phase D will add `indexed_through`; Phase G adds queue watermarks.

## Gap semantics

Known capture discontinuity becomes durable evidence: a `trace.capture_gap`
event `{session, from_seq, to_seq, reason, component, status, observed_at}`,
deduped per (session, range, reason) in ANY status (a failed write retries via
`flushPending`, never silently lost, never re-marked into duplicate events).

Sources wired today:
- sequence jump on ingest (`capture_gap`, component `sequence`)
- observer drop / hook timeout (`observer_drop`, via `safe()`)
- watcher overflow (`watcher_gap`, `Store.noteWatcherMiss`)
- (Phase G adds queue overflow with a monotonic pending journal)

Reconciliation: when a missing sequence later arrives, a FOLLOW-UP marker
`status: 'reconciled'` (with `reconciles_seq` + `reconciles_marker`) is
recorded; the original `detected` marker is never deleted or rewritten.
Marker events occupy sequence space themselves (total ordering preserved).

## Query semantics

`trace_find` results (index + deep) carry
`coverage.capture = {status: complete|incomplete, known_gaps,
reconciled_gaps, pending_writes, dropped_total, missed_watcher_total}`.

- `matches: []` + `status: complete` -> no match within covered evidence.
- `matches: []` + `status: incomplete` -> absence NOT established.

`trace_status` exposes `capture_coverage`. Runtime context gains a COMPACT
`capture_coverage` warning only when incomplete (never floods with history).

## Failure behavior

Marker writes are best-effort with a bounded retry queue (`flushPending`,
await-then-retry ordering); `Store.close()` drains them (bounded) so cleanup
never races an unfinished evidence write. A marker that cannot be written
keeps `status: 'pending_write'` and the store reports incomplete coverage.

## Test matrix results

C1-C13 all pass, including watcher-miss evidence, writer-failure recovery via
pending retry, restart persistence of markers, complete-vs-incomplete
no-match distinction, Reviewer/Supervisor-consumable status fields, V2-A
handle compatibility, and the late-injection/cache invariant.
