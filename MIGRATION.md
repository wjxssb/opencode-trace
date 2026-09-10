# Source provenance

Donor: https://github.com/wjxssb/CodeWhale-OpenCode-V2

Branch: `loop2/opencode-adapter`

Fetched branch HEAD: `447d0ee449aa3cc9da9f68c9f440b00dc811ef13`.
The fetch was performed again at the start of this extraction on this machine.

Studied `bridge/plugin/codewhale/index.js`, its native V2 integration tests and installer. Reused/reworked the patterns for canonical serialization, message identity extraction, exact tool envelopes, before/after call keys, native context hooks, direct tool transform registration, and persistent native compaction discovery. This is a fresh repository, not a fork of donor history. MIT attribution is retained in LICENSE.

The runtime was rewritten around Node filesystem built-ins. Nothing imports or connects to the donor. The local checkout under `/home/frank/audit/opencode-trace-20260909/donor` is provenance evidence only.

Excluded: Rust kernel, Python MCP bridge, process launcher, authority socket and tokens, hardening/encryption keys, SQLite authority database, encrypted CAS, PlanOwner/MutationOwner, root-run authority, admission/delegation quotas, execution/wait facades, scheduling, permissions authority, native tool filtering, and shell interception. There are no `CODEWHALE_*` runtime environment variables.

The previous installed integration was separately uninstalled at the user's explicit request before this task. Its source, historical database/CAS and installation backups remain under the existing user paths and `/home/frank/audit/codewhale-uninstalled-20260909`. This project does not access them.

Local host adaptation: OpenCode V2 `0.0.0-beta-19296` resolves a configured local plugin directory via `server.js` or `index.js`, rather than using this package's `exports` field. `server.js` is a one-line entrypoint for that API. The donor targeted an older beta; qualification here applies to the actual installed beta, without replacing or patching it.

This host publishes `session.compaction.ended` for native V2 compaction; the observer handles it as well as the legacy `session.compacted` name. Its dispatcher reuses the outer call ID for inner tool hooks, so pairing also includes the trusted tool name and input. Direct tool output objects are JSON-normalized before the host validates them.
