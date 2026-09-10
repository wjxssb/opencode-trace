# Local qualification

Qualified on `/home/frank`, Ubuntu 24.04.3 LTS, OpenCode V2 `0.0.0-beta-19296`, Node `v22.16.0`.

Release: `0.1.0`. Runtime bundle SHA-256:
`e2911f7f4770f3bc9d770bcb0316e7bb35b3bf725403568d365c58a10b4c2381`.

The runtime has zero external dependencies. Six source modules plus `server.js` total 519 lines, counting comments and blank lines. Installer modules total 156 lines.

Validation was performed on actual OpenCode sessions and durable tool receipts, not model-written PASS statements:

- 16 Node test groups cover the requested normalization, identity, pairing, persistence, provenance, recall, compaction, coordination, failure handling and installer cases.
- GLM `zai-coding-plan/glm-5.3-flash`: baseline without the plugin, installed native read/shell/edit/write/subagent, execute dispatcher, existing Context7 tool, notes/intents/expand and native compact with a valid recovery map.
- Qwen `frank-local/unsloth/Qwen3.8-27B-NVFP4`: after the user requested Qwen first and the endpoint recovered, the complete final-release native/trace toolchain passed. User installation smoke and post-restart source recovery also passed with Qwen.
- A loopback deterministic model fixture drove actual OpenCode native patch, malformed-map compaction, store-failure and process-restart tests. It only supplied model responses; OpenCode executed the tools and compaction. No external GPT provider was added. V2 exposes patch to GPT-named model routes and edit/write to Qwen/GLM, so that model-name fixture exercised the real patch implementation.
- Native catalog before/after was identical apart from the four added trace tools. A malformed trace map retained a completed native summary and created a recovery gap. A non-directory store root returned a trace error while native shell/read/edit/write completed.
- Real private OpenCode server process restart recovered a pre-compact source, its finding and compact anchor. Both sides of overlapping session intents saw advisories; structured edits proceeded.
- The actual user rollback script restored the previously absent `/home/frank/opencode.json`, removed trace from the loaded plugins, preserved history and passed native Qwen shell smoke. Reinstallation produced identical config bytes; a new OpenCode process recovered the earlier user note/source and completed native shell.

Receipts: `/home/frank/audit/opencode-trace-20260909/`.
Machine-checkable isolated acceptance: `qualification.json` (23 checks).
User receipts: `user-smoke-receipt.json`, `user-final-receipt.json`, `user-final-state.json`.
Full final report: `FINAL-REPORT.md` in that receipt directory.

Recheck immutable isolated receipts:

```
python3 tests/verify_receipts.py /home/frank/audit/opencode-trace-20260909
node --test tests/*.test.js
```

`tests/scripted_provider.py` is a test-only loopback model responder taking `--control` and `--receipts`. Test configurations and control data remain in the receipt directory for reproduction; temporary fixture services were stopped and their project configuration files were archived. Production runtime does not need this responder or Python.

Scope limits: qualification is for the tested V2 beta, not all OpenCode releases. Startup scans immutable events once; context uses cached projections. Host-identical repeated inner invocations cannot be given a finer identity than the host exposes. Unavailable storage loses trace observations for that interval but leaves native execution available. Peer intents can remain stale until updated. History is local and may contain private data delivered by host hooks.
