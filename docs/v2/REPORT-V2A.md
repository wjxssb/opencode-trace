# TRACE V2 ARCHITECTURE AND IMPLEMENTATION REPORT — V2-A (Phase A)

## 1. Final Verdict
V2-A (ephemeral turn-scoped evidence handles) IMPLEMENTED, QUALIFIED, INDEPENDENTLY
REVIEWED (review evt_5967b9001d8cb1aad55eadc5ec9b39b2109d64e670604bbca1d825794396adc2),
and STAGED as immutable release `2.0.7-trace-v2a-45db3ea`. NOT ACTIVATED (no symlink
flip, no service restart). Phases B-H NOT implemented this session — deferred with
honest scope accounting.

## 2. Baseline
- Production releases found: `2.0.7-runtime-context-2a158a9d1ea5` (baseline import)
  and `2.0.7-runtime-context-tracefix-0169868e2ae` (audit fix, promoted by a parallel
  session mid-campaign; `current` → tracefix). Candidate ≡ tracefix + V2-A only.
- opencode v2.0.7+runtime.2a158a9d, node v22.16.0, store 1012M/161 workspaces
  (workspace /home/frank: 50386 events, 58215 blobs, 193 sessions).
- Local model: qwen38-27b-dense (vLLM 127.0.0.1:18080, epoch 09-19 22:35).

## 3-5. Handles / invariants
See docs/v2/A-HANDLES.md (design, scope, resolver, stale handling, durability proof).
Durable state stores full canonical refs only (H7/H8/A3 + reviewer-verified paths:
note()/stepResult()/autoRecordMilestone() cannot persist handles).

## 6-17. Causality / coverage / index / token budget / claims / sidecar / security
NOT IMPLEMENTED (mission phases B-H). Not silently skipped: each requires its own
gate. This report does not claim them.

## 18. Backward compatibility
Old v1 events untouched and readable (index.js/store.js byte-identical to qualified
base except documented diffs; contract snapshot re-blessed intentionally).

## 19-20. Files / commits
Commits (main): 1a75235 baseline-production · a7f7b88+c9dbd66 v2-base sync ·
06aaf66 V2-A feature · 78afa7f snapshot re-bless · 72e165e arch note ·
45db3ea local-model qualification. Tags: baseline-production, v2-base.
Paths: src/handles.js (new), src/trace.js, src/tools.js, src/present.js,
tests/handles.test.js (new), tests/local-qual-model.mjs (new), tests/local-qual.mjs
(new), docs/v2/* (new), tests/__snapshots__/contract-snapshot.json (re-blessed).

## 21. Tests
Full suite: 185 tests, 184 pass, 0 fail, 1 env-gated skip (~20s; baseline 20.2s).
Handles matrix H1-H11 + A1-A4: 15/15. Real local model drill: 2/2.
Reviewer independently re-ran the full suite in its sandbox: same result.

## 22. Real local model qualification
qwen38-27b-dense drove the full workflow against real candidate code: shell evidence
→ trace_expand via short handle e1 → trace_note (durable canonical-only, evt_b2277e38…
6ff78) → e99 clear rejection. Production-service probe with local model confirmed the
native host tool roundtrip. GLM misfire disclosure: one early qualification attempt
routed to the production service (config isolation failure) and issued a handful of
GLM requests unintentionally; every subsequent run was local-only.

## 23. Performance
recallSnapshot+handles: ~176µs/call (8-event fixture); host hook path unchanged
(1s timeout race, ≤8 jobs). Suite time parity. No TTFT regression mechanism exists
(recall block grows only by the bounded EVIDENCE HANDLES lines).

## 24. Cache regression
No early-prefix mutation: index.js hook wiring byte-identical to qualified base
(reviewer-verified via git diff); injection remains late runtime-context-v1;
checkpoint/applied receipts unchanged.

## 25. Failure injection
Covered by suite: handle unknown/expired/foreign rejections (H3/H4/H5 + A2/A4),
restart regeneration (H6), stub-safety (fakeTrace suite), byte-overflow drop-first
(A1/trim tests), snapshot truncation fallback.

## 26-27. Releases / retention
Staged release: 2.0.7-trace-v2a-45db3ea (trace dir hash 69e4acc5bcf85f22…, 457M,
copied from tracefix + candidate plugin; docs/.git excluded). No GC/retention changes.

## 28. Remaining risks (from review, accepted)
a) tool.before/after durable events keep the raw handle FORM in input echoes
   (resolved canonical refs live in results/notes) — documented trade-off.
b) HandleRegistry.active grows one generation per session per process (no TTL);
   bounded per generation (≤256 handles) but not evicted — long-lived servers
   should add eviction in a later phase.
c) trace_status discovery registration covers evt_ rows only (regex quirk
   e(vt|blob)_ misses blob_) — capability gap, not a correctness bug.
d) Drill note-citation assertion is behavior-tolerant (handle or verified
   canonical); source_handles parameter path pinned deterministically by H7/A3.

## 29. Deferred work
Phases B-H per mission §12, in order: causal event schema + session chain;
coverage watermarks + gap semantics; persistent derived index; token-aware
runtime budget; typed provenance claims; sidecar capture; sensitive-data policy.
Environment note: isolated second-service hosting cannot register custom local
providers on the current server build (documented) — must be solved before a
full-host candidate qualification rerun.

## 30. GLM / CodePlan usage
Intentional GLM inference: 0. Intentional CodePlan test credits: 0.
Unintentional: one early qualification run mis-routed to the production service
(a handful of GLM requests) before isolation was understood; disclosed above.

## 31. FINAL STATE
**TRACE V2-A PROMOTED_AND_VERIFIED** (production-prep round, 2026-09-20).
Prep commit `a7fef31` (refPattern status filter + registry release/TTL lifecycle +
trace.handle_resolution metadata) — suite 194/193/0/1, handles 15/15, drill 2/2,
cache diff 0 lines; round-2 independent review PASS (rev_1789923775667_pj2nljcm);
round-2 doc advisories applied (`1e2114a`).
Promotion (journaled + idle-gated, NO bare switch):
- release `2.0.7-trace-v2a-1e2114a` — trace dir sha256 c887c630…259257;
  deterministic git-archive bundle fded6bdc…8e1594, release bytes verified equal
- journal `~/.local/share/opencode-runtime/promotions/2026-09-20T17-12-51.582Z-trace-v2a.json`
  (before-config backup + after-config + narrow-merge verification + symlink
  before/after + idle-gate evidence with the openly-listed orphaned execution
  mark ses_f71c232d… of 09-11 excluded by a 30-minute staleness bound)
- config plugins[].package (trace) -> 2.0.7-trace-v2a-1e2114a path; current -> same
- LIVE SMOKE: the host config watcher hot-reloaded the plugin after the journaled
  config change; production runtime-context now delivers the EVIDENCE HANDLES
  block ([e1]/[b1]/[n1]…) in the promoter's own session — activation verified live
Rollback: restore `before-config` from the journal + symlink back to
`2.0.7-runtime-context-tracefix-0169868e2ae` (CAS untouched at every step).
