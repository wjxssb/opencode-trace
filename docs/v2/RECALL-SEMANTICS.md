# RECALL-SEMANTICS promotion journal (2.0.7-recall-semantics-4a4891d)

Date: 2026-09-20. Verdict: CONFIRMED SEMANTIC AMBIGUITY (+ model reasoning error enabled by it) — FIXED.

## Incident

During the V2 B–G campaign, session `ses_f423e644cffeAHM1dxXh85msr4` received the
degraded Trace recall frame `{"sessionID","recall_truncated":true,"retrieve":"trace_status"}`
(persisted quote: `evt_e357ca43`), reasoned "my session recall is fully truncated"
(`evt_457993900`) → "my remaining budget is insufficient to finish F/G" (`evt_6404eb24`),
and handed off claiming "session budget exhausted mid-E" (`evt_dfc18847`, 19:04:02Z).
No host/model/execution telemetry supported the claim: zero provider context errors,
zero compaction events, and the session demonstrably kept working until 19:17:41Z —
13 minutes AFTER the "physical exhaustion" claim. The only budget signal anywhere in
the frame was Trace's own recall display ceiling.

## Root cause

- TRACE SEMANTIC AMBIGUITY (primary): the degraded fallback emitted a bare, untyped
  `recall_truncated` with no reason source, no implication contract, and no recovery
  instruction — readable as session/model-context exhaustion.
- MODEL REASONING ERROR ENABLED BY THE AMBIGUOUS SIGNAL (secondary): an inferred resource
  condition was asserted as mechanical fact and written into the durable handoff note
  (corrected by `evt_6a72557b`).

Not implicated: Supervisor (no interpretation of truncation anywhere in its source),
OpenCode runtime-context schema (no budget fields; none fabricated), V1 legacy plugin
(not serving).

## Fix (commit 4a4891d, cherry-pick of main dbec4e2 onto serving baseline 501b516)

- Degraded frame is source-typed: `reason:'trace_runtime_budget'`,
  `implies_session_exhaustion:false`, `session_context:'not_observable_via_trace'`, and a
  compact recovery instruction (trace_status → trace_find → trace_expand; keep the task
  active and continue).
- `trace_status` description carries the invariant; `trace_note` requires typed handoff
  reasons (context_limit|execution_budget|planned_checkpoint|user_request|runtime_failure|other)
  with an evidence source (host|provider|orchestrator|user|agent_judgment). Guidance-level
  by design (reviewer-endorsed): structural enforcement belongs to Phase F.
- Hard invariant: recall truncation is a Trace-side display budget; it is never evidence of
  model-context, session, or execution exhaustion. Legitimate handoffs (planned checkpoint,
  user request, real telemetry) remain fully allowed — nothing is suppressed.
- Cache/prefix architecture untouched: recall stays in the per-turn `context` hook
  (late runtime-context); stable constants carry no truncation state (tested).

## Verification

- Unit suite @ 4a4891d: 203 tests, 202 pass, 0 fail, 1 skip, rc=0
  (reviewer receipt `chk_f62904b41b68f97972ad5c467e05c0efcca8541da818486d89239f804268961d`).
- Negative control: on the un-fixed tree exactly the 3 new contract tests fail
  (T1/T7, T5/T6/T8/T9, tool-guidance) — the tests detect the old behavior.
- Contract snapshot re-blessed for exactly 2 intentional description deltas.
- Local real-model qualification (resident vLLM qwen38-27b-dense, zero GLM): with heavy
  seeded state (genuinely truncated bounded recall), the model drove the REAL candidate
  plugin — retrieved the omitted target note via trace tools (structurally verified:
  a trace_expand ref resolved to the target blob), surfaced the figure, affirmed
  continuation, zero exhaustion claims (`qual/recall-semantics-model-drill.mjs`).
- Host-level isolated smoke: candidate plugin loaded in a real isolated opencode2 host and
  served genuinely truncated bounded recall with durable receipts; model turn blocked by a
  host provider-config fetch (401 opencode.ai) — environment limitation, not candidate defect.
- Known pre-existing flake (not this change): load-sensitive tests (P5.3, B2) can fail under
  CPU contention; deterministic single-run green.

## Fresh independent review

`rev_1789934631674_tvyhkzot` (fresh reviewer session ses_f3f9504bcffedhXL6sCDZxk2eQ):
**looks_good**, 894s, no actionable defect; verified scope, snapshot re-bless legitimacy,
test rigor incl. negative control, release integrity, narrow scope, prefix architecture,
and handoff non-suppression.

## Release + promotion

- Immutable release `/home/frank/.local/share/opencode-runtime/releases/2.0.7-recall-semantics-4a4891d`
  (parent 1e2114a + plugins/trace only; hardlinks materialized to real copies; trace binding
  `4a4891dc78de7fc06e1e3d2431080168698a22a4`; dir sha `575cb24b…`).
- Staging incident (during this work): one in-place write through a hardlink copy mutated the
  parent release's manifest/source-binding. Restored content-faithfully (restored sha
  `5e7b510a…`; original pre-write sha `afefda2d…` captured before any write). Serving plugin
  bytes verified intact vs git 501b516 (zero mismatches); rescue pins target the untouched
  `0169868e2ae` manifest and remain valid. Pre-existing builder flaws documented in-file
  (`restoration_provenance`) + durable note `evt_a617dffc`: recorded hashes can match no real
  artifact; manifests were byte-shared across sibling releases; `handles.js` never tracked.
  Rule going forward: release-tree metadata writes must be write-temp + atomic rename.
- Narrow promotion: `opencode.jsonc` trace package path only → candidate
  (config sha `9e27abe65010a343883eaf1eb4ef650b24686cb18c20bef48cbbcb23deb6f9b3`;
  backup `promotions/before-opencode.json.recall-semantics-4a4891d`). Supervisor,
  last-model, safety-guard entries untouched. Idle gate: no concurrent campaign workers.
- Running processes keep the previous build until restart; all newly started sessions load
  the candidate.

## Follow-ups

1. Phase F: structural handoff-reason enforcement (reviewer-side), per review decision.
2. Release builder: embed release identity in manifests; stop byte-sharing manifests across
   sibling releases; track all shipped files; use atomic renames.
3. Candidate/v2-bcde-wip successor commit (same semantics at its three fallback sites) —
   required so the future B–G promotion inherits the invariant.
4. Test stability: isolate/timing-harden P5.3/B2 to avoid false review-gate alarms.
