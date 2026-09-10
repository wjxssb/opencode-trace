# CAPABILITIES — verified host and reference abilities (P3)

Statuses: VERIFIED (evidence produced this round), DOCUMENTED (official V2 docs
only, runtime proof pending), UNSUPPORTED (no evidence; do not assume).

## Local OpenCode host

Version: `opencode2 v0.0.0-beta-19296`. Evidence: live `GET /openapi.json`
fetched from the running background service on 2026-09-10 (119 paths), saved
out-of-tree during the audit run.

| Ability | Route / API | Status |
| --- | --- | --- |
| Session prompt with delivery boundary | `POST /api/session/{id}/prompt`, body has `delivery: "steer" \| "queue"` and `resume` | VERIFIED (local openapi) |
| Synthetic context message | `POST /api/session/{id}/synthetic` (same delivery/resume fields) | VERIFIED (local openapi) |
| Inbox introspection and conversion | `GET /api/session/{id}/inbox`, `DELETE .../inbox/{inboxID}`, `POST .../inbox/{inboxID}/steer`, `POST .../inbox/{inboxID}/queue` | VERIFIED (local openapi) |
| Idle/running synchronization | `POST /api/session/{id}/wait` | VERIFIED (local openapi) |
| Cancel execution | `POST /api/session/{id}/interrupt` | VERIFIED (local openapi) |
| Transcript read | `GET /api/session/{id}/context`, `GET /api/session/{id}/message` | VERIFIED (local openapi) |
| Background tools | `POST /api/session/{id}/background` | VERIFIED (local openapi) |
| Session create / fork / rename / switch agent-model | `POST /api/session`, `POST /api/session/{id}/fork`, `/rename`, `/agent`, `/model` | VERIFIED (local openapi) |
| Plugin ctx equals server client (`ctx.session.*`, hooks, `ctx.event.subscribe`) | V2 plugin docs | DOCUMENTED — runtime probe happens in the isolated-host E2E before any orchestration claim |
| Context assembly observation | `ctx.session.hook("context")` fires on the assembled agent-loop request | DOCUMENTED + locally consistent (P1d evidence stages implemented) |
| Real model-request observation | `ctx.session.hook("http.request" / "http.response")` carries `sessionID` and `kind` for every native provider request | DOCUMENTED — needed for a `request_observed` evidence level; wiring deferred to P4 with isolated-host proof |
| Cold-session wake | Sessions are server-resident; "cold" does not exist as a DSH-style lifecycle. Prompting an idle session starts a turn; delivery to a session with no live client stays `unknown` in trace receipts | VERIFIED by architecture (server owns sessions), runtime nuance pending E2E |

Notably UNSUPPORTED / not assumed:

- No direct inter-session RPC or shared memory between agents. All cross-session
  traffic must pass through host-admitted prompts/synthetic messages.
- No exactly-once delivery anywhere in the host contract. Trace receipts record
  `unknown` when an attempt cannot be proven, and never auto-retry it.
- `Agent.id` is not `Session.id`. Sessions carry `parentID` (V2 schema);
  agents are reusable profiles. Trace mailbox IDs use a separate `msgx_/thr_`
  namespace and never claim to be host IDs.
- The plugin must not spawn its own model loop; delivery only uses the host
  prompt boundary shown above.

## DeepSeek Harness reference (read-only)

Pinned revision: `c291e7961a515f6d7af9304e7fd1d257929aef26` (master, cloned
2026-09-10). Modules inspected under `packages/`:

| Mechanism | DSH location | What we borrow |
| --- | --- | --- |
| Append-only session events with derived projections and repair | `core/session/src/` (`types.ts`, `known-event-types.ts`, `repair.ts`, `seq-ranges.ts`) | Events are the authority; projections/indexes are rebuildable. Already this project's architecture; reinforced by P1/P2. |
| Background subagent returns a durable id; parent receives a settle notice with the final message; `send_message` steers the running step or starts an idle turn | `subagent/tool-subagent/src/index.ts` (tool description, line ~386) | Negotiation receipts: accept-return only, never an answer; per-state delivery mirrors this. |
| `send_message` / park / interrupt acceptance receipts; residency (`running`/`idle`/`cold`) handled by a control layer, not the tool | `subagent/tool-subagent-control/src/index.ts` | trace_send returns acceptance receipts; residency decisions stay with the host; uncertain states are honest. |
| Workflow control flow is a separate orchestration layer, not chat | `workflow/workflow/src/` | P4 orchestration must be a thin adapter over native subagent/session tools, not a second scheduler. |

What we deliberately do NOT copy: DSH API names, its runtime assumptions
(durable subagent processes, park/resume of agents), or any code (license and
attribution would be required; none of it is needed).
