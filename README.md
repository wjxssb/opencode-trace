# opencode-trace

A small OpenCode V2 observer: durable tool history, exact source recovery, model-selected notes, bounded recall and advisory awareness of peer sessions. Native OpenCode executes every native operation.

An independent plugin with its own source, installation, local storage and rollback. See [source provenance](MIGRATION.md) for the extraction history and MIT attribution.

Node >=20. No runtime dependencies, build step, MCP, daemon, database service or donor installation. The OpenCode host loads `server.js`. Tested locally with OpenCode V2 beta-19296; this is a V2 plugin, not a legacy V1 hook adapter.

## Install and rollback

```sh
git clone https://github.com/wjxssb/opencode-trace.git
cd opencode-trace
node install/cli.js install --config /absolute/workspace/opencode.json
opencode service restart
```

Replace the config path with the OpenCode V2 JSON or JSONC config for your workspace. No `npm install` or build is needed. Save the printed `manifest` path for rollback. This repository is distributed directly through GitHub; the package is private to prevent accidental npm publication.

The installer writes an immutable version bundle to `~/.local/share/opencode-trace/versions/`, then adds one entry to the config's `plugins` array. JSON and JSONC are supported. Existing comments, permissions, agents, providers, MCP settings and other plugins remain intact. It prints a receipt path containing the original exact bytes, before/after SHA-256, bundle hash and installed path. Restart OpenCode to verify the new instance.

```
node install/cli.js rollback --manifest /absolute/path/to/receipt.json
opencode service restart
```

Rollback restores the exact original config when it still matches the installed hash. If unrelated changes were made later, it removes only its own unmodified entry and preserves those changes. It refuses ambiguous or modified managed entries. History and version bundles are retained. No global `current` link is required: each config points at a specific immutable version.

For isolated testing, `--root PATH` selects bundle/receipt storage; `--store-root PATH` sets the plugin's history root. Neither option changes other OpenCode config. Installation does not change the selected model.

## Tools

| Tool | Purpose |
|---|---|
| `trace_note` | Save a fact, finding, decision, unresolved item, handoff or correction, with existing `source_refs`, `supersedes`, and `depends_on`. |
| `trace_expand` | Read an exact immutable event/note or content blob by ref. Returns metadata, original structured source locator, unified related refs and byte pagination. |
| `trace_find` | Find history by clues instead of refs: type, session, agent, tool, status, call_key, path, thread/mail/plan/related refs, time range, or text. `deep:true` scans exact blob bytes under a budget with a resumable cursor. |
| `trace_intent` | Declare one current intent per session: summary, paths, optional resources, active/waiting/done/cancelled and related refs. Same-millisecond concurrent intents stay visible as `intent_conflicts`. |
| `trace_status` | Show current memory, recent native result refs, peer snapshots and degradation count, with explicit peer pagination. |
| `trace_send` | Persist and deliver a directed negotiation message (persist before delivery, host-derived sender, attempt/result delivery WAL paired by unique `attempt_id`, thread membership from full history, addressee-only decisions on proposals, explicit thread ids fail closed). |
| `trace_inbox` | Show negotiation mail with per-level evidence: persisted / host_admitted / context_observed / recipient_ack / reply_recorded. The newest-message window is viewer-scoped (sender or recipient), so other sessions' traffic cannot push a participant's own mail out of view. `sweep:true` retries only sends whose newest attempt never started; crash-window attempts are reconciled from evidence or left for manual choice, never auto-retried. |
| `trace_ack` | Record delivery receipt for a specific message; never agreement. |
| `trace_step_result` | Worker sessions only: submit the structured outcome of the plan step this session was bound to (`success` or `failure`, with optional summary and verified `source_refs`). Identity, plan, step and attempt come from the host session binding, never from tool input. One attempt carries one outcome: identical replays dedupe to the first event and conflicting claims are rejected, so the last arriver can never rewrite task truth. |
| `trace_plan` | Execute an LLM-owned plan through native sessions only (create+bind agent+prompt+wait+collect). A settled step means the child turn finished - never that the task succeeded: dependents run only on `worker_reported_success` from the worker's own `trace_step_result`; settled-unknown, worker-reported failure, transport failure, pre-start failure, cancellation and unsupported all block dependents. Every phase failure is journaled with its phase, child session id and attempt id, with best-effort cleanup. All recorded terminal states are reused on resume; `retry_failed:true` explicitly re-runs only steps without worker-reported success under fresh attempt ids, old attempt evidence retained. Plan identity is owner-session scoped; optional `step.agent` binds a real host agent via native switching. |

The model decides what is worth remembering. Code validates structure, sizes and workspace-local refs; it does not classify the meaning of prompts, outputs or commands. Identity comes from the host tool context, not tool input. Notes from peers can be cited within the same canonical workspace; arbitrary external refs cannot be expanded.

`trace_expand` reads stored bytes rather than reopening the original document. Its default payload page is 2048 bytes (maximum 24000). `metadata_only:true` returns verified metadata and refs without payload bytes. `text_blobs` lists exact individual tool text blobs; `payload_ref` identifies the full JSON result envelope. The model chooses the ref and page size. Follow `next_offset` until null; rereading a page adds no evidence. `exact_base64` preserves every byte even when a UTF-8 character crosses page boundaries; concatenating decoded pages recovers the SHA-256-verified original. `exact_utf8` is for convenient reading. The page limit bounds source bytes, not the complete JSON response, which also contains base64 and metadata. Metadata inspection still reads and verifies the stored blob locally.

## Storage

Default root:

```
~/.local/share/opencode-trace/workspaces/<sha256(realpath(workspace))>/
  events/evt_<sha256>.json
  blobs/<first-two-hex>/<sha256>
  sessions/<sha256(sessionID)>.json
  recall/<sha256(sessionID)>.json
  intents/<sha256(sessionID)>.json
  state/schema.json
```

Schema version is 1. Events have `ref`, `type`, `host`, `payload`, `workspaceID`, `at` and type-specific metadata. `host` records only identities supplied by OpenCode. Tool events also have `callID`, `callKey`, `tool`, `source` and terminal `status`; their immutable JSON payload contains the exact input/result/error. Before and after share a key derived from session/message/call identity plus the host tool and exact input. V2 reuses a dispatcher's call ID for its inner tools, so the additional fields prevent collisions. Repeated identical inner calls with the same host ID/input are indistinguishable at this API boundary; no synthetic invocation identity is invented. Distinct payload revisions are retained; identical replay reuses the same event and timestamp.

Blobs carry SHA-256, byte length and encoding. Files are private (0600, directories 0700). Writes use fsynced temporary files: immutable blobs/events publish atomically with a no-clobber hard link; replaceable snapshots use atomic rename. Partial `.tmp` files cannot replace or corrupt committed records. Expand verifies hashes. No secret stores, unrelated files or process environment are scraped; only host-delivered content is recorded, including host redactions as delivered. History can therefore contain private material already present in a session; it stays local.

Immutable events are authoritative. Startup replays event files once, tolerating corrupt records with a warning. Session JSON files are disposable bounded projections; no concurrent writer owns a session. Filesystem notifications merge immutable events from other plugin instances. Context uses the in-memory projection and host's current context; it does not scan the entire event directory on each dispatch. Startup cost grows with retained event count; no automatic retention deletion is performed.

To recover lost filesystem notifications without restart, each context/status request advances one directory cursor by at most 64 entries and imports unseen immutable events. Scans wrap at the end; idle sessions do not poll. Reconciliation is coalesced to one job and one directory handle. Watcher reads are capped at 16; overflow is reconciled by subsequent requests. Convergence under notification loss depends on continued context/status calls and store availability, not a wall-clock guarantee.

Since 0.1.1, context checkpoints store the current message count, SHA-256 of the canonical ordered ID array, and its last eight IDs. They do not copy the growing ID prefix every turn. Exact messages remain in separate immutable events; older checkpoints remain readable. This removes quadratic checkpoint metadata growth, not the linear cost of retaining history. Event counts, startup memory and replay time still grow. Snapshots retain only 64 notes per session, so an older note can disappear from default recall while remaining expandable by its known ref.

`trace_status` with `include_storage:true` performs an on-demand workspace scan reporting event/blob bytes, object counts, file allocation and filesystem available bytes. It is a best-effort snapshot during concurrent writes and is not run on each context hook. There is no disk quota, safety floor or automatic deletion. A full filesystem can affect other applications independently of the observer's fail-open behavior; unlimited retention is not promised.

## Recall, compaction and coordination

The context hook appends `OPENCODE_TRACE_RECALL_V1`, default 12 KiB with a hard maximum of 16 KiB. It contains selected notes, unresolved refs, current intent, recent source refs, a compact anchor, advisories and a small peer snapshot. It never includes full tool outputs. Structural truncation removes peer detail and older entries first; exact retained records remain expandable. Display limits are not agent or session admission limits.

During native `/compact`, the model can append a bounded `<opencode-trace-map-v1>` JSON map to its normal summary. Fields are arrays of existing trace refs: `current_refs`, `unresolved_refs`, `important_refs`, `recent_refs`, `retrieve_if_needed`, `supersedes`, `depends_on`. Maximum 4096 bytes and 8 refs per field. Native completed summaries are discovered from the trusted session context/API. Summary, map and anchor are archived. Missing or malformed maps yield `recovery_gap` and leave native compaction alone.

The current compact is selected by native `time.created`, independent of host array order or local observation time. Older archives recover that field from their verified payload. Equal timestamps use a deterministic ID tie-break; missing timestamps are explicitly marked `chronology_unknown`, so the plugin cannot promise chronology when the host omitted it.

Explicit overlapping intents and structured edit/write paths generate durable advisories visible to both sessions. Path normalization resolves symlinked existing ancestors. Shell commands and textual patches have unknown mutation paths; their language is never parsed. The host's ordinary permissions and agent topology remain in charge. Intent status and recording time are displayed separately from the last host lifecycle observation and its evidence ref. Execution completion does not terminate a session. Only explicit host deletion yields deletion evidence; otherwise current liveness is unknown, even after an observed execution start. No timeout rewrites an active declaration. The model decides how to act on historical declarations and advisory overlap.

Automatic peer projection carries identity, lifecycle observations, intent ref/status, paths/resources and timestamps. Peer intent prose is available only by explicit expansion. This is a structural boundary without keyword filtering; it is not a guarantee of model immunity to malicious evidence. Sessions in the same canonical workspace share its trace trust boundary. Separate worktrees with different real paths have separate stores.

Hooks used: session `prompt` and `context`; tool `execute.before` and `execute.after`; agent transform for a read-only snapshot; tool transform to add the trace tools; lifecycle event subscription and session `get`/`context` for recovery; the plugin client's native `session.prompt` (mailbox delivery), `create`/`prompt`/`wait`/`context` (plan steps) when the host exposes them. The plugin never changes native tools, messages, permissions, agents or execution routing, and binds no shell hook.

The derived index behind `trace_find` is memory-only and rebuilt from authoritative events at startup; hint extraction peeks at most 8 KiB of each payload. Deep text scans read blobs in 256 KiB chunks with needle overlap, so the byte budget is enforced at chunk granularity and a single huge output can never bypass it into memory; the resume cursor stores the logically consumed byte prefix (overlap bytes are never counted as consumed), so no byte range can fall between two pages, and reported hits are discovery coordinates - exact evidence always goes through `trace_expand`, which hash-verifies the full blob. Evidence levels never auto-upgrade: a persisted mailbox message is not delivery, a delivery receipt is not comprehension, an ack is not agreement, and plan acceptance never completes a parent task. Mailbox delivery uses an attempt/result write-ahead record paired by unique `attempt_id`: only the newest attempt decides the outcome, an attempt whose result is missing is a crash window that is reconciled from the recipient's own persisted transcript or reported for manual choice, never silently re-delivered or masked by an older retracted attempt. Thread participation is derived from recorded evidence over the full thread history, not a bounded display window, so late-joined participants keep their standing; accept/reject/counter may only be cast by the proposal's addressees, replies, proposal bindings and explicit thread ids must all describe one thread, and a malformed explicit `thread_id` fails closed instead of opening a new thread. Plan steps separate execution from task truth: `settled` proves only that the child turn finished, `worker_reported_success` exists solely as a structured, identity-bound, traceable worker claim from `trace_step_result` - it is not independently verified success, and a verified outcome would require an independent verifier or source evidence, which is later semantic work, not this layer.

Observer errors are caught and logged without payloads. Native hooks wait at most one second for local observer work, then continue. Trace tools can return `ok:false`; that does not affect native execution. A failed store may lose trace observations for that interval. A setup/registration error disables the corresponding observer feature and warns rather than making OpenCode unusable.

At most eight native-hook observer jobs may remain outstanding. A timed-out job retains its slot until the underlying operation settles; further observations are dropped with degradation reporting, without a hidden queue or blocking native execution. This bounds job count, not the size of an individual host result. Status exposes outstanding/dropped counts. There is no promise of complete trace capture during saturation or storage failure.

## Validate

```
node --test tests/*.test.js
node tests/e2e_host.mjs /absolute/fresh-dir     # real isolated-host E2E (20 checks)
node tests/p5_install_drill.mjs /absolute/fresh-dir  # isolated install/rollback drill (15 checks)
```

Tests cover identity normalization, paired immutable events, blobs and tampering, restart/replay, source recovery after file change, bounded recall, compaction maps/gaps, note validation, multi-session convergence, deterministic advisory overlap, unknown shell paths, fail-open hooks and config-preserving installation/rollback. Regression tests additionally cover message revision retention, same-millisecond convergence with visible intent conflicts, the durable terminal guard against late out-of-order tool events, prepared/applied context evidence stages, clue-only retrieval over thousands of events, budgeted deep scans with resumable cursors, mailbox crash windows and honest orchestration resume. P5.2 correctness closures have their own regressions: attempt-paired delivery WALs (a retracted older attempt never masks a newer crash window), viewer-scoped inbox windows, exact deep-cursor boundary recovery (a needle inside the consumed/physical gap region is found with its exact byte offset across pages), boundary-straddling needles found exactly once, per-attempt worker results (identical replays dedupe, conflicting claims are rejected, forged plan/step input is ignored), phase-journaled step failures with orphan-child cleanup, full-history thread membership for late joiners, fail-closed thread ids, and a restart test proving delivery crash windows, worker result bindings and thread membership survive a process boundary. GitHub Actions runs the component suite on Node 20 and 22. The E2E and P5 scripts are real-host drills: they start a private OpenCode server (isolated `HOME`, loopback ports, deterministic scripted provider) and never touch an existing user service, config or session. Real-host qualification results and their limits are recorded in [QUALIFICATION.md](QUALIFICATION.md) and host/reference capabilities in [CAPABILITIES.md](CAPABILITIES.md); private session receipts are not distributed.

The [targeted audit](EVIDENCE.md) records measured storage amplification, model-qualified recovery, failures, fixes and remaining boundaries. Qwen's post-fix model run was blocked by GPU Xid 43; no Qwen improvement is claimed.
