# Local qualification

## Current state (P6, 2026-09-10)

**P6 real-model qualification: PASS (GLM-5.3-flash).** A dedicated harness
(`tests/p6_qualification.mjs`, local-only, real provider via api.z.ai coding
plan) drove seven real sessions on an isolated OpenCode host against a
randomized fixture workspace. All ten P6 gates passed: clue-only recovery of
a historical value from event blobs (SHA-verified), two-session natural
negotiation through the mailbox, reviewer counter-evidence discovery against
pre-seeded historical facts, evidence-driven revision with cited refs, a late
verifier recovering state without chat history, native build/reviewer role
binding with real permission boundaries, `trace_plan` workers submitting
their own `trace_step_result` claims, fuzzy end-to-end reconstruction, no
corruption, and full usability after a real server process restart. An
independent verifier LLM re-verified the evidence chain itself (blob hashes,
negative queries, re-derived refs) and judged the collaboration genuine;
its noted weakest link (the reconstructor left no durable note) is recorded
as MODEL_BEHAVIOR, not a program rule. `REAL_MODEL_GLM = PASS`;
`REAL_MODEL_QWEN = NOT_RUN` (local vLLM healthy; GLM stands alone).
Receipts: `receipts/p6-real-model-<timestamp>/` (local, sanitized - refs and
hashes only, no credentials). Component suites remain 62/62 per Node version.

The trace surface at current `main` has ten model-facing tools
(`trace_note`, `trace_expand`, `trace_find`, `trace_intent`, `trace_status`,
`trace_send`, `trace_inbox`, `trace_ack`, `trace_step_result`, `trace_plan`),
62 component tests per Node version (20.19.5 and 22.16.0), a 23-check real
isolated-host E2E (`tests/e2e_host.mjs`) and a 15-check install/rollback drill
(`tests/p5_install_drill.mjs`). The E2E and drill are local real-host gates;
GitHub Actions runs only the component suite because the runner has no
OpenCode binary. Real-model (GLM/Qwen) multi-session negotiation qualification
is not yet run; that is the next gate (P6), followed by shadow install on the
user's main instance. `worker_reported_success` is an identity-bound worker
claim, not independently verified success.

The rest of this page preserves the original 0.1.0 installation qualification. See the
[0.1.1 targeted audit](EVIDENCE.md) for measured costs, fixes, GLM recovery,
Qwen's pre-fix timeout and post-fix `ENVIRONMENT_BLOCKED_XID43` result.

Qualified on 2026-09-09 with Ubuntu 24.04.3 LTS, OpenCode V2 `0.0.0-beta-19296`, Node `v22.16.0`.

Release: `0.1.0` (historical). Runtime bundle SHA-256:
`e2911f7f4770f3bc9d770bcb0316e7bb35b3bf725403568d365c58a10b4c2381`.

The runtime has zero external dependencies. Six source modules plus `server.js` total 519 lines, counting comments and blank lines. Installer modules total 156 lines.

Validation was performed on actual OpenCode sessions and durable tool receipts, not model-written PASS statements:

- 16 Node test groups cover the requested normalization, identity, pairing, persistence, provenance, recall, compaction, coordination, failure handling and installer cases.
- GLM `zai-coding-plan/glm-5.3-flash`: baseline without the plugin, installed native read/shell/edit/write/subagent, execute dispatcher, existing Context7 tool, notes/intents/expand and native compact with a valid recovery map.
- Qwen `unsloth/Qwen3.8-27B-NVFP4` through a local provider: the complete final-release native/trace toolchain passed. User installation smoke and post-restart source recovery also passed with Qwen.
- A loopback deterministic model fixture drove actual OpenCode native patch, malformed-map compaction, store-failure and process-restart tests. It only supplied model responses; OpenCode executed the tools and compaction. No external GPT provider was added. V2 exposes patch to GPT-named model routes and edit/write to Qwen/GLM, so that model-name fixture exercised the real patch implementation.
- Native catalog before/after was identical apart from the four added trace tools. A malformed trace map retained a completed native summary and created a recovery gap. A non-directory store root returned a trace error while native shell/read/edit/write completed.
- Real private OpenCode server process restart recovered a pre-compact source, its finding and compact anchor. Both sides of overlapping session intents saw advisories; structured edits proceeded.
- The actual user rollback script restored the workspace config to its previously absent state, removed trace from the loaded plugins, preserved history and passed native Qwen shell smoke. Reinstallation produced identical config bytes; a new OpenCode process recovered the earlier user note/source and completed native shell.

These are maintainer-local qualification results. Raw sessions, config backups and receipts remain private; they are not included in the public repository.
Machine-checkable isolated acceptance: `qualification.json` (23 checks).
User receipts: `user-smoke-receipt.json`, `user-final-receipt.json`, `user-final-state.json`.
Full final report: `FINAL-REPORT.md` in that receipt directory.

Run the standalone tests from a clean clone. The receipt verifier additionally requires the original private receipt directory:

```
node --test tests/*.test.js
python3 tests/verify_receipts.py /path/to/private/receipts
```

`tests/scripted_provider.py` is a test-only loopback model responder taking `--control` and `--receipts`. Test configurations and control data remain in the private receipt directory; the public fixture and verifier alone do not reproduce the real-host qualification. Temporary fixture services were stopped. Production runtime does not need this responder or Python.

Scope limits: qualification is for the tested V2 beta, not all OpenCode releases. Startup scans immutable events once; context uses cached projections. Host-identical repeated inner invocations cannot be given a finer identity than the host exposes. Unavailable storage loses trace observations for that interval but leaves native execution available. Peer intents can remain stale until updated. History is local and may contain private data delivered by host hooks.
