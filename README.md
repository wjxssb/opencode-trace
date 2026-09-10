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
| `trace_expand` | Read an exact immutable event/note or content blob by ref. Returns metadata, original structured source locator, related refs and byte pagination. |
| `trace_intent` | Declare one current intent per session: summary, paths, optional resources, active/waiting/done/cancelled and related refs. |
| `trace_status` | Show current memory, recent native result refs, peer snapshots and degradation count, with explicit peer pagination. |

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

Hooks used: session `prompt` and `context`; tool `execute.before` and `execute.after`; agent transform for a read-only snapshot; tool transform to add only four tools; lifecycle event subscription and session `get`/`context` for recovery. The plugin never changes native tools, messages, permissions, agents or execution routing, and binds no shell hook.

Observer errors are caught and logged without payloads. Native hooks wait at most one second for local observer work, then continue. Trace tools can return `ok:false`; that does not affect native execution. A failed store may lose trace observations for that interval. A setup/registration error disables the corresponding observer feature and warns rather than making OpenCode unusable.

At most eight native-hook observer jobs may remain outstanding. A timed-out job retains its slot until the underlying operation settles; further observations are dropped with degradation reporting, without a hidden queue or blocking native execution. This bounds job count, not the size of an individual host result. Status exposes outstanding/dropped counts. There is no promise of complete trace capture during saturation or storage failure.

## Validate

```
node --test tests/*.test.js
```

Tests cover identity normalization, paired immutable events, blobs and tampering, restart/replay, source recovery after file change, bounded recall, compaction maps/gaps, note validation, multi-session convergence, deterministic advisory overlap, unknown shell paths, fail-open hooks and config-preserving installation/rollback. GitHub Actions runs this suite on Node 20 and 22. Real-host qualification results and their limits are recorded in [QUALIFICATION.md](QUALIFICATION.md); private session receipts are not distributed.

The [targeted audit](EVIDENCE.md) records measured storage amplification, model-qualified recovery, failures, fixes and remaining boundaries. Qwen's post-fix model run was blocked by GPU Xid 43; no Qwen improvement is claimed.
