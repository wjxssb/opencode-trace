# V2-A Architecture Note — Ephemeral Model-Facing Evidence Handles

Status: implemented, qualified (tests/handles.test.js, 15/15), committed `06aaf66` + re-bless.
Incident addressed: 2026-09-20 production session `ses_f427e7ae9ffeze5yh969vDn4uN`
(model corrupted 49/61-hex copies of refs visible in the same recall).

## Design

Handles are short host-managed labels (`e1`, `b1`, `n1`) for canonical refs
carried in one runtime snapshot. They change the model-facing transport only;
the durable evidence model is untouched.

| Property | Decision |
|---|---|
| Forms | `e<k>` events, `b<k>` blobs, `n<k>` notes; `/^[ebn][1-9][0-9]{0,3}$/` |
| Disjointness | can never collide with `evt_`/`blob_` refs; no truncated SHA is ever a handle (H11) |
| Scope | **turn-scoped per session**: one generation installed per prepared snapshot (context hook); valid through the turn's tool calls; replaced by the next request |
| Tombstone | exactly one previous generation retained per session → stale handles report `expired` (not `unknown`) (H4) |
| Restart | registry is process-memory only; fresh process = no mapping; next snapshot regenerates handles deterministically from canonical refs (H6) |
| Determinism | `assignSnapshotHandles(view)` is pure; assignment order = display order of the final trimmed view (recent events → their output blobs → notes → unresolved → intent ref) (A1) |
| Discovery | tool results (find/expand/status) attach `handle` fields; unmapped refs register continuing ordinals; already-mapped refs surface their existing handle |
| Caps | 64 per snapshot, 64 per tool registration, 256 per generation |
| Resolution | exact-match only: current generation → tombstone → foreign-session scan → `unknown`. Never prefix, never similarity, never cross-session |
| Errors | `Unknown evidence handle 'e42': … re-read the Evidence list`; `Expired … superseded by a newer runtime snapshot`; `belongs to a different session's mapping` |
| Durability | resolution happens in the tool wrapper **before** any store validation; durable payloads keep full canonical refs only (H7/H8/A3); tool `input` echoes may contain handles (transport form), the resolved note does not |

## Data flow

```
context hook ──► recallSnapshot(sid)
                    │  trim (bytes ceiling) ──► assignSnapshotHandles(view)   (pure)
                    │  render: snapshot JSON + ACTIVE MILESTONE MEMORY
                    │         + === EVIDENCE HANDLES === block (tails only)
                    ▼
        handles.newGeneration(sid, assignments)          (in-memory registry)
                    ▼
model cites [e1] in trace_note / trace_expand …
                    ▼
tool wrapper: resolveInputHandles(input, sid)             (e1 → evt_<64hex>)
                    ▼
existing strict store validation ──► durable note stores canonical refs
```

Canonical display: the Evidence block shows 11+4-char ref tails (`evt_055a51c…3f3a`)
for human audit only; full canonical refs remain in the snapshot JSON (`recent[]`,
`notes[]`) exactly as before, so audit/export/debug needs are unchanged.

## Invariants kept

- A (CAS): handles never durable; no short ID ever stored as identity.
- B (integrity): `trace_expand` still re-checks hashes; handles resolve to the
  same verified read path (H9 byte-equality).
- C (immutability): no event/blob rewritten.
- D (cache): handles render late inside the recall snapshot; nothing enters the
  early stable prefix.
- E (native execution): resolution failures return `ok:false` +
  `native_execution: unaffected`; middleware is optional-chained so test stubs
  and legacy hosts keep working.
- F (provenance): unchanged — handles carry no verification semantics.

## Test matrix results (tests/handles.test.js)

H1 ✓ H2 ✓ H3 ✓ H4 ✓ H5 ✓ H6 ✓ H7 ✓ H8 ✓ H9 ✓ H10 ✓ H11 ✓
A1 determinism ✓ A2 find-discovery ✓ A3 milestone evidence_handles + strong-state
downgrade unaffected ✓ A4 status discovery ✓

## Real local model qualification (tests/local-qual-model.mjs, 2026-09-20)

Resident model `qwen38-27b-dense` (vLLM 127.0.0.1:18080) drove a live agentic
drill against the real candidate code (real store, real per-request context
hook, real tool middleware): ran `echo qual-evidence-7f31`, expanded the
resulting event via the SHORT HANDLE `e1` (never copying hex), saved a
trace_note whose durable payload kept canonical-only refs, and received a
clear structured rejection for unknown handle `e99`. All PASS.
`expands=["e1","e99"] noteSourceRefs=["evt_b2277e38…6ff78"]`.

Host-integration evidence: a production-service probe with the real local
model (`--model local-qwen-auto/27b-dense`) exercised `trace_expand e99`
through the real host tool path (native tool execution round-trip works).
Full host-side activation of the candidate build was blocked by an
environment limitation of the current server build: plugin sets are bound at
service start from the global config, and standalone servers spawned with an
isolated HOME do not register custom local `providers` in any config shape
tested (4 combinations; `/api/model` empty), so a fully isolated second
service with the candidate plugin could not be booted. The drill therefore
drives the real host-equivalent context hook in-process. This limitation is
environmental (server build), not a defect of the candidate.

GLM/CodePlan usage: intentional non-local inference = 0. One qualification
attempt mis-routed to the production service before isolation was
understood (a handful of GLM requests, reported in the campaign report);
every subsequent run was pinned to the local model.

## Limitations (honest)

- Handles are process-local: two concurrent sessions in *different* processes
  share the durable store but not registries; each session only resolves its
  own generation (foreign_session / unknown by design).
- A handle cited in a *later* turn (after its generation retired) is rejected;
  the model must re-read the current Evidence list. This is intentional.
- Tool-input echoes in durable `tool.before/after` events keep the handle form
  the model sent; the resolved canonical refs live in the tool *result* and in
  the note payload. (Trade-off accepted: input events record what was sent.)
