# Workload evidence utilities

These scripts measure the checked-out runtime; the audit preserves separate
0.1.0 BEFORE and 0.1.1 AFTER results. Results include failed model
turns and storage/discoverability limits. Passing receipt validation means the
receipts agree with observed outcomes; it does not mean every workload passed.

See [EVIDENCE.md](../EVIDENCE.md) for the final model-qualified matrix and
[measured-results.json](../evidence/measured-results.json) for per-call paging
and token counters. `byte_accounting.py`, `analyze_receipts.py` and
`verify_closure.py` process private synthetic receipts. The last requires the
full maintainer audit layout; it is not a standalone clean-checkout test.
`closure_cases.py` contains bounded real-host ENOTDIR and lifecycle fixtures.
The repository's standalone regression gate is `node --test tests/*.test.js`.

## Portable component measurements

Use fresh output directories outside your project. The storage sweep retains
roughly 220 MiB of evidence on the measured filesystem and does not delete it.

```sh
node --expose-gc benchmarks/storage.mjs /absolute/evidence/storage
node benchmarks/coordination.mjs /absolute/evidence/coordination
node benchmarks/note_window.mjs /absolute/evidence/note-window
```

The storage sweep measures actual event/blob writes, per-operation timing and
fresh-process replay. `allocated` counts file allocation blocks, excluding
directory blocks and inode metadata; `apparent` counts file content bytes. Its
synthetic `result.content` payload is smaller than some real host envelopes.
The 50-turn context window is simulated, not a native compaction test.

Coordination uses four Node processes and sixteen synthetic session identities.
It tests filesystem convergence, pagination, simultaneous intents, cross-process
source expansion, workspace isolation and stale intent retention. Visibility
timings start after the writer returns; they are first-poll observations, not a
measurement of the complete propagation delay or a latency guarantee.

The note-window probe saves an unresolved item followed by eighty findings. It
checks both default discoverability and exact retrieval using the retained ref.

## Real-host harness

`live_evidence.py`, `live_cases.py` and `qwen_wire.py` are maintainer test helpers
for OpenCode V2 beta-19296, using real Qwen responses and native host tools.
They require a separately prepared isolated server; they are not standalone
OpenCode installers. Python is a test dependency only.

Prepare a private receipt directory and an isolated directory named
`/tmp/opencode-trace-evidence-*`, containing `on`, `off`, `independent`, `config`,
`data`, `state` and `cache`. The on/independent project configurations load the
plugin into a separate `storeRoot`; off has no plugin. Global fixture config
uses provider `trace-qwen` with model `unsloth/Qwen3.8-27B-NVFP4`, context 32768,
output 4096, and an OpenAI-compatible base URL pointing at the proxy. Do not copy
real credentials into this fixture. Use `local-test-placeholder` with an
unauthenticated loopback inference endpoint. Give every project an AGENTS.md
restricting the task to the fixture and excluding platform databases and other
workspaces.

The paths JSON supplies `root` (private receipts), `work` (isolated directory),
`binary` (the actual OpenCode V2 binary), and `server_port` (49455 in this run).
Start the private server with all four XDG directories pointing to this fixture
and `OPENCODE_SERVER_PASSWORD=opencode-trace-loopback-fixture`. Bind it to
127.0.0.1 and redirect startup logs to a private file. The constant is an isolated
test credential, never a deployment password. The harness uses the same value.

```sh
python3 benchmarks/qwen_wire.py --directory /absolute/evidence/wire
python3 benchmarks/live_evidence.py --paths /absolute/evidence/paths.json --trial 1
python3 benchmarks/live_cases.py --paths /absolute/evidence/paths.json probes
python3 benchmarks/live_cases.py --paths /absolute/evidence/paths.json planning
python3 benchmarks/live_cases.py --paths /absolute/evidence/paths.json failure
python3 benchmarks/verify_evidence.py /absolute/evidence
```

Run model cases sequentially for interpretable timings. The proxy forwards only
to the configured local inference endpoint and never logs request headers. It
records full message bodies from the dedicated test provider, which must remain
private. Stop the private server and proxy after testing. Keep source files,
generated expected values, sessions and raw receipts for independent checking.

Real-host coverage: hidden-value recovery after source replacement and native
compaction, peer handoff, identical short native operations, model cooperation
based on declared intents, explicit writes despite advisory conflicts, and
native execution with deliberately unavailable trace storage. Timeouts are
recorded as failures. Inspect `verified-evidence.json` together with the raw
receipts rather than treating model-written success statements as proof.
