# Phase B — Causal Event Graph + Session Continuity

Commits: sequence allocator + store causality + verifyChain + expand projection.
Status: IMPLEMENTED + QUALIFIED (tests/causality.test.js 15/15; full suite 209/208/0/1).

## Event schema evolution (backwards-compatible)

New events carry `event_schema: 2` plus optional causal fields as top-level
event fields (inside the hashed body, so refs self-verify as before):

    event_schema: 2
    session_seq          ordering / continuity (per-session, durable allocator)
    previous_event_ref   previous event of the same session (chain)
    caused_by            causal provenance (tool.after -> tool.before,
                         plan step -> plan, step result -> step start)
    parent_event_ref     hierarchy / containment (reserved wiring)

Field semantics are kept distinct by design; nothing is overloaded.
Historical events are never rewritten: they simply lack these fields
(`event_schema` absent) and remain valid (B8). Readers understand both.

## Sequence allocation (concurrency-safe)

`src/sequence.js` — per-session state file `{seq, last_ref}` under
`<storeRoot>/sequence/<hash(sessionID)>.state`, guarded by an O_EXCL lock
with retry and stale-lock breaking (10s). The event ref is derived INSIDE the
critical section (`build(seq, previous_ref)`), so the state file can advance
atomically together with the chain pointer.

Failure semantics (honest):
- crash after state-write but before event persistence -> that seq has no
  event: a permanent, detectable gap (Phase C marks it; never renumbered).
- crash before state-write -> seq is reused; no gap.
- duplicate delivery / retry -> deduped in Store.record by the
  causality-free body hash BEFORE allocation (bounded in-process map), so
  replays never consume a sequence number. Cross-process replays are outside
  this guarantee (single-writer-per-workspace is the norm).

`record()` treats every host-session event as part of the session spine.
Events without a session (agents.snapshot) remain v1.

## Chain verification

`Trace.verifyChain(sessionID)` returns internal integrity/continuity
evidence (explicitly NOT external attestation): monotonic seq with gap
ranges, broken previous links (expected seq mismatch), missing referenced
events, cross-session links, cycle-shaped (forward) edges, duplicate seq
forks, and legacy v1 event count.

## Causal projection

`trace_expand` output gains additive `causal` (seq/previous/caused_by/parent)
and `children` (bounded, derived from the in-memory index) for schema-2
events. Old events project without them.

## Test matrix results

B1-B14 all pass (tests/causality.test.js), including concurrent allocation
(B2), restart continuity (B11), legacy readability (B8), gap/missing
detection (B9), cycle detection (B10), cross-session rejection (B10b),
hash integrity (B12), V2-A handles (B13) and runtime-context contract (B14).
