# TRACE V2 CAMPAIGN — PHASE 0 BASELINE (recorded 2026-09-20, before any V2 edit)

## Runtime identity
- Active release: `2.0.7-runtime-context-2a158a9d1ea5` (only release; `current` symlink → same)
- OpenCode binary: `opencode v2.0.7+runtime.2a158a9d`
- Node: `v22.16.0`
- Trace plugin dir aggregate hash (find | sort | xargs sha256sum | sha256sum):
  `169bb83b17d8db378791c1fa7f079859868ad68e4fa9e9c0876fe3ca2dbf8a9b`
- Supervisor plugin dir aggregate hash:
  `a7ea38eff4d62e6ba659657d0f25a010438a523002f33976df70133f0f1fe8ce`
- Inline-reviewer producer aggregate hash:
  `62d6f9f3247e2ea49171ce1ae85f75c06f5964744d5c263ac6d0850c5ef55faf`
- Trace plugin package version: `0.1.4` (private, ESM, node>=20)

## Config hashes (sha256)
- `~/.config/opencode/opencode.jsonc` `be75d579f1a207bd2e3ad295d64270cdbb5476e486d8a9d10baed14938e61ca1`
- `~/.config/opencode/cli.json`      `59582e4e6d72f938acb92cdc323f6645967ddc35d9b40f4265bc5f7271d6681a`
- `~/.config/opencode/service.json`  `0adce6404dffc7f9a69a591c01fd82b939724cacd383681ae7313ee07bf9f875`
- `~/.config/opencode/tui.json`      `bf9102b93a5b96272e1bd60e5ecbde96344cadf9b0e5222f9ef71db9fd64dbdd`
- Plugin registration: `plugins/trace` with `options.contextDelivery = "runtime-context-v1"`

## Local model / backend
- vLLM OpenAI-compatible server `127.0.0.1:18080` (container port 8000), epoch start **9月19 2026 22:35**
- Model: `qwen38-27b-dense` (= `nvidia/Qwen3.8-27B-NVFP4`, served name `unsloth/Qwen3.8-27B-NVFP4`)
- Key flags: `--max-model-len 262144 --seed 0 --enable-prefix-caching --spec-method mtp --spec-tokens 3`,
  tensor-parallel 2, kv-cache nvfp4, max-num-seqs 1
- Provider in opencode.jsonc: `local-qwen-auto` → baseURL `http://127.0.0.1:18080/v1`
- GLM/Z.AI inference for this campaign: **0 requests** (intentional). CodePlan test credits: **0**.

## Trace storage layout (production store)
- Root: `~/.local/share/opencode-trace/workspaces/<sha256(workspace)>/{events,blobs,sessions,recall,intents,state}`
- Workspace `/home/frank` → `b85b2a0b91c13678b4358eb41a3a941f6d76a865c07a4a925fd8002fdf6b88f8`
- events **50386**, blobs **58215**, sessions **193**; workspace dir **770M** (blobs 564M)
- Total across **161 workspaces**: **1012M**

## Current behavior parameters (production source of truth)
- Recall budget: byte-based, default `12288` bytes, ceiling `min(16384, max(8192, N))` (trace.js recallSnapshot)
- Active memory cap: `ACTIVE_MEMORY_BYTE_CAP = 2048` bytes
- Observer guard `safe()`: 1000 ms timeout race, `maxObserverJobs = 8`, drops counted (`droppedObservations`)
- Deep scan: `DEEP_CHUNK = 262144` B chunks, budget default 2 MiB, max 16 MiB, resumable cursor
- Index hints: `HINT_READ_BYTES = 8192`, ≤8 strings, ≤200 chars each (approximate discovery only)
- Watcher: per-workspace fs.watch on `events/`, modes `watch_and_reconcile | reconcile_only`, counters
  `missedWatcherEvents`/`missed_watcher_notifications`, bounded 16 concurrent watch jobs
- Note/claim semantics: kinds fact|finding|decision|unresolved|handoff|correction; milestone kinds
  decision|state_change|verification|blocker|correction|handoff|baseline; strong-state prose
  (`verified|pass|fixed|confirmed|production baseline`) without verified evidence ref → downgraded to
  `CLAIMED / UNVERIFIED` (trace.js note()). `isVerifiedEvidence`: only completed tool.after without
  explicit failure, or trace.step.result `worker_reported_success`.
- tool.after verification-transition milestones: FAIL→PASS and PASS→FAIL auto-recorded
- Supersedes: hides from active recall, history retained; own-session-only enforcement
- Encryption/redaction: **none** today (no secret policy, no redaction markers, no crypto)

## Incident context (drives Phase A)
- 2026-09-20 production session `ses_f427e7ae9ffeze5yh969vDn4uN`: model miscopied 64-hex refs
  (49-hex, 61-hex copies of refs visible in the same recall). Audit
  `/home/frank/trace-note-contract-audit-20260919` produced fixes `6d16534`+`0169868`
  (kind-contract description + non-accepting closest-ref hint), **qualified, NOT promoted**.
- Production release plugin src == audit repo commit `778cc4a` bytes (verified by hash-diff;
  only src/tools.js, src/trace.js differ via those two commits, plus tests/install harness).

## Campaign repo
- `/home/frank/trace-v2/trace` (git)
  - `1a75235` `baseline-production` — byte-identical import of release plugin/trace
  - `a104051`+ follow-ups = sync of qualified audit fixes + full test suite; tag `v2-base`
- Suite at v2-base: `node --test tests/*.test.js` → **170 tests, 169 pass, 1 skip, 0 fail, ~20.2s**
  (skip: environment-gated e2e; install.test.js green after importing install/ harness)

## Runtime-context / cache architecture (protected)
- Early system prefix stable; Trace injects only via late `context` hook,
  delivery `runtimeContext.entries[]` (runtime-context-v1) with fallback to system append
- `context.checkpoint` (prepared) + `context.applied` (hook applied) receipts
- RECALL_MARKER `OPENCODE_TRACE_RECALL_V1` + evidence policy text lead the recall block
