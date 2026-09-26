const str = { type: 'string' };
const refs = { type: 'array', items: str, maxItems: 16 };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
import { present, boundedRaw } from './present.js';
import { normalizeTraceIntentInput } from './normalization.js';
import { refPattern, callKey } from './util.js';
// P1 presentation: content is human Markdown + a fenced machine block (the
// host persists content and the model reads it — Phase 0 spike); the raw
// structured value rides in metadata.raw, size-bounded for host delivery.
const result = async (name, value, trace) => {
  const json = JSON.stringify(value);
  const shown = present(name, value);
  // The host truncates at 50 KiB / 2000 lines. Store a large response before
  // delivery, so refs, pagination and coverage cannot disappear from its tail.
  const oversized = Buffer.byteLength(shown.content, 'utf8') > 24000 || shown.content.split('\n').length > 1500;
  const stored = oversized ? await trace.store.blob(value, 'json') : null;
  const retrieval = stored ? { result_ref: stored.ref, result_sha256: stored.sha256, result_bytes: stored.bytes } : {};
  const content = stored
    ? `### ${shown.title}\n\nFull structured result stored without loss. Retrieve with trace_expand(ref="${stored.ref}", limit=2048); follow next_offset until null.\n\n` +
      '```json\n' + JSON.stringify({ ok: value.ok, ...retrieval, presentation_omitted: true, next_cursor: value.next_cursor, next_offset: value.next_offset }, null, 2) + '\n```'
    : shown.content;
  return { title: shown.title, output: content, content, metadata: { opencode_trace: true, title: shown.title, ...retrieval, raw: boundedRaw(value, json) } };
};

export function definitions(trace) {
  const tool = (name, description, input, fn) => ({ name, description, input, output: { type: 'object', additionalProperties: true },
    options: { codemode: false, permission: name },
    async execute(input, host) {
      try {
        await trace.ready;
        if (!host?.sessionID) throw new Error('Host session identity unavailable');
        // Ephemeral evidence handles resolve to canonical refs before any
        // store validation; unknown/expired/foreign handles reject clearly.
        // Optional call keeps test stubs and legacy hosts working unchanged.
        const rawCallKey = callKey({ sessionID: host.sessionID, id: host.id, tool: name, input });
        const resolvedHandles = await trace.resolveInputHandles?.(input, host.sessionID, name, host, rawCallKey);
        const value = { ok: true, ...await fn(input, host) };
        if (resolvedHandles?.length) value.handles_resolved = resolvedHandles;
        // S3 handle-first: a successful write registers its durable ref as a
        // fresh current-generation handle and presents it handle-first
        // (saved_as: n3/b2/e5), so the model never needs to copy the
        // canonical ref back. Notes/claims/milestones present as n#.
        const createdRef = value.ref ?? value.ack_ref ?? value.delivery_ref ?? null;
        if (createdRef && typeof createdRef === 'string') {
          const kind = ['trace_note', 'trace_claim', 'trace_claim_receipt'].includes(name) ? 'note'
            : createdRef.startsWith('blob_') ? 'blob' : 'event';
          const created = trace.handles?.registerCreated?.(host.sessionID, createdRef, kind);
          if (created) value.saved_as = created.handle;
        }
        return await result(name, value, trace);
      } catch (error) {
        trace.warning(name, error);
        if (name === 'trace_intent' && host?.sessionID) {
          trace.recordIntentFailure(host.sessionID, error, input);
        }
        return result(name, { ok: false, error: String(error.message ?? error.code ?? 'Trace unavailable').slice(0, 320), native_execution: 'unaffected' }, trace);
      }
    }
  });
  return [
    tool('trace_prepare_citations', 'S5 finalization: resolve and validate this turn\'s evidence handles into an EPHEMERAL, turn-scoped CitationSet token (process-local, non-CAS). The final handoff note cites the token via trace_note citation_set; the gateway revalidates it fail-closed (unknown/stale generation/CONTRADICTED claim all reject) and expands to canonical refs. Canonical evt_/blob_ refs remain the only durable identity; the model copies zero SHA strings.',
      schema({ handles: { ...refs, description: 'This turn\'s short handles (e1/b1/n1) to bind into the set; 1..16 items.' } }, ['handles']),
      async (i, h) => {
        const out = await trace.gateway.prepareCitations(h.sessionID, i.handles, h);
        return out;
      }),
    tool('trace_note', 'Save a concise durable decision, constraint, failure cause, blocker/next action, finding, handoff or structured milestone; skip routine logs. Cite evidence and label uncertainty; empty source_refs provides no corroboration. After verified correction/resolution, supersede your old note. Host supplies identity. Top-level kind is exactly one of the six note kinds (fact, finding, decision, unresolved, handoff, correction): do not invent other kinds; a state change is kind "finding", or milestone.kind "state_change", which maps to finding. Supply kind and text (plus an optional short summary), or milestone.kind and milestone.summary. Evidence is cited handle-first: this turn\'s short handles (e1/b1/n1 from the Evidence list) via the evidence field (or the compatibility source_handles/evidence_handles/supersedes/depends_on fields) are the normal interface; handles are turn-scoped labels resolved before storage, and durable notes always keep full canonical refs. Full canonical refs (evt_<64hex> or blob_<64hex>) copied verbatim from observed Trace output are the compatibility/advanced path: never shorten, reconstruct or invent refs. Handoff notes must name a reason type (context_limit|execution_budget|planned_checkpoint|user_request|runtime_failure|other) and an evidence source (host|provider|orchestrator|user|agent_judgment); Trace recall truncation alone never establishes context or session exhaustion.',
      schema({
        kind: { enum: ['fact', 'finding', 'decision', 'unresolved', 'handoff', 'correction'], description: 'Top-level note kind; exactly these six values. Do not invent other kinds; a state change is expressed as "finding" (milestone.kind "state_change" maps to finding).' },
        text: { ...str, maxLength: 4096, description: 'Note body, at most 4096 UTF-8 bytes.' },
        summary: { ...str, maxLength: 4096, description: 'Optional short headline stored with the note (at most 2048 UTF-8 bytes beside text) and used as the milestone summary when that is omitted; with no text it becomes the text.' },
        source_refs: { ...refs, description: 'Compatibility provenance path. Full canonical refs (evt_<64hex> or blob_<64hex>) copied verbatim from observed Trace output, or this turn\'s short evidence handles (e1/b1/n1). Never shorten, reconstruct or invent; omit when the exact ref is unavailable. Prefer the evidence field.' },
        evidence: { ...refs, description: 'PREFERRED evidence citation (handle-first): this turn\'s short handles (e1/b1/n1) from the Evidence list; full canonical refs are the compatibility path. Resolved to canonical source_refs before storage; durable notes always keep full canonical refs.' },
        citation_set: { ...str, pattern: '^cb_[0-9a-f]{24}$', description: 'S5 finalization: a prepare_citations token (cb_<24hex>). Revalidated fail-closed at write time (unknown/stale/contradicted sets reject); expands to canonical source_refs; the token never persists.' },
        source_handles: { ...refs, description: 'Compatibility alias: turn-scoped evidence handles (e1/b1/n1) from the current Evidence list; resolved to canonical refs before storage.' },
        supersedes: { ...refs, description: 'Your prior note refs, verified corrected/resolved. Hides from active recall, preserves history; never close still-open issues. Canonical refs or evidence handles.' },
        depends_on: refs,
        milestone: schema({
          kind: { enum: ['decision', 'state_change', 'verification', 'blocker', 'correction', 'handoff', 'baseline'] },
          summary: { ...str, maxLength: 2048 },
          what_changed: { ...str, maxLength: 2048 },
          why_it_matters: { ...str, maxLength: 2048 },
          current_state: { ...str, maxLength: 1024 },
          decision: { ...str, maxLength: 2048 },
          evidence_refs: refs,
          evidence_handles: { ...refs, description: 'Turn-scoped evidence handles (e1/b1/n1); resolved to canonical evidence_refs before storage.' },
          unresolved: { type: 'array', items: str, maxItems: 16 },
          next_action: { ...str, maxLength: 2048 },
          do_not_repeat: { type: 'array', items: { ...str, maxLength: 256 }, maxItems: 16 },
          supersedes: refs,
          depends_on: refs,
          to_session: { ...str, maxLength: 256, description: 'Explicit target session ID for handoff.' },
          to_worker: { ...str, maxLength: 256, description: 'Explicit target worker role or agent name.' },
          task_ref: { ...str, maxLength: 256, description: 'Shared task ID or plan ID for handoff binding.' },
          handoff_id: { ...str, maxLength: 256, description: 'Shared handoff token or transfer ID.' },
          continuation_of: { ...str, maxLength: 256, description: 'Session ID or note ref this session continues.' }
        }, ['kind'])
      }), (i, h) => trace.note(i, h)),
    tool('trace_expand', 'Read exact stored evidence, not current files. ref accepts a canonical evt_/blob_ ref or this turn\'s short evidence handle (e1/b1/n1). metadata_only inspects refs; text_blobs hold tool text, payload_ref the event JSON. Default 2048 bytes, max 24000. Follow next_offset until null; repeated pages add nothing. SHA-256 verifies the whole blob; base64 preserves split byte boundaries.',
      schema({ ref: str, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 24000 }, metadata_only: { type: 'boolean' } }, ['ref']), (i, h) => trace.expandTool(i, h)),
    tool('trace_find', 'Search all ingested history; return snippets/refs for trace_expand. text searches capped hints; deep scans exact bytes with a budget and resumable cursor. Results carry short discovery handles usable this turn. External operations may be absent; no match does not prove absence. A write/edit tool.before hit lists in rels the file\'s bytes before that call (preimages), even outside git.',
      schema({
        type: { anyOf: [{ type: 'string' }, { type: 'array', items: str, maxItems: 8 }] },
        session: { ...str, description: 'Host sessionID whose captured event history to search, including another worker session.' }, agent: str, tool: str, status: str,
        call_key: str, ref: str, related: str, path: str, text: str,
        thread: str, message: str, recipient: str, reply_to: str, proposal: str,
        plan: str, step: str, worker: { ...str, description: 'Plan-bound worker session filter for trace_plan step records only. Use session for general tool/message history.' }, attempt_id: str,
        deep: { type: 'boolean' }, deep_budget_bytes: { type: 'integer', minimum: 1024, maximum: 16777216 },
        after: { type: 'number', minimum: 0 }, before: { type: 'number', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: str,
      }), (i, h) => trace.find(i, h)),
    tool('trace_send', 'Persist then deliver to observed workspace sessions through the host prompt queue/steer boundary. Host supplies sender. Receipts distinguish persisted, host_admitted, failed and uncertain. accept/reject/counter require an explicit proposal or counter message id.',
      schema({
        to: { type: 'array', items: str, minItems: 1, maxItems: 8 },
        text: { ...str, maxLength: 16384 },
        type: { enum: ['question', 'proposal', 'objection', 'counter', 'evidence', 'accept', 'reject', 'withdraw', 'handoff', 'note'] },
        thread_id: str, in_reply_to: str, proposal: str,
        delivery: { enum: ['steer', 'queue'] },
        source_refs: refs,
        source_handles: { ...refs, description: 'Turn-scoped evidence handles; resolved to canonical source_refs before storage.' },
      }, ['to', 'text']), (i, h) => trace.send(i, h)),
    tool('trace_inbox', 'Page sent/received messages; keep thread filter with next_cursor (max 96/page). Evidence: persisted, host_admitted, context_observed (native peer metadata only), recipient_ack, reply_recorded. Receipt is not agreement. sweep retries only missing delivery records; uncertain admissions require manual choice.',
      schema({ thread_id: str, sweep: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 96 }, cursor: str }), (i, h) => trace.inbox(i, h)),
    tool('trace_ack', 'Acknowledge receipt of one trace message; never agreement or completion.',
      schema({ message_id: str }, ['message_id']), (i, h) => trace.ack(i, h)),
    tool('trace_step_result', 'Report your bound plan step outcome. Host supplies identity/plan/step. Denied or failed operations mean failure; dependents require worker-reported success. A settled turn alone is outcome unknown.',
      schema({ status: { enum: ['success', 'failure'] }, summary: { ...str, maxLength: 2048 }, source_refs: refs, source_handles: { ...refs, description: 'Turn-scoped evidence handles; resolved to canonical source_refs before storage.' } }, ['status']), (i, h) => trace.stepResult(i, h)),
    tool('trace_plan', 'Run up to 8 dependency-ordered steps in fresh native sessions; independent steps fan out. Inherit effective model/variant/agent; explicit step.agent must exist and honors its model. Read back bindings before prompting; unavailable/mismatched bindings fail closed. Dependents require trace_step_result success, not merely a settled turn. Reuse terminal steps; retry_failed retries terminal non-success only. Concurrent/unterminated attempts return in_flight_unknown and are never duplicated. Plan identity is caller-scoped; acceptance does not complete the parent task.',
      schema({
        steps: { type: 'array', minItems: 1, maxItems: 8, items: schema({
          id: { ...str, pattern: '^[a-z0-9_-]{1,32}$' },
          text: { ...str, maxLength: 4096 },
          depends_on: { type: 'array', items: str, maxItems: 8 },
          agent: str,
        }, ['id', 'text']) },
        retry_failed: { type: 'boolean' },
      }, ['steps']), (i, h) => trace.plan(i, h)),
    tool('trace_intent', 'Declare your current intent and explicit paths/resources. Overlap produces advisory information only. Update to done/cancelled when finished.',
      schema({
        summary: str,
        paths: {
          anyOf: [
            { type: 'array', items: str, maxItems: 64 },
            { type: 'string' },
            { type: 'null' }
          ]
        },
        resources: {
          anyOf: [
            { type: 'array', items: str, maxItems: 32 },
            { type: 'string' },
            { type: 'null' }
          ]
        },
        status: { enum: ['active', 'waiting', 'done', 'cancelled'] },
        related_refs: refs,
        related_handles: { ...refs, description: 'Turn-scoped evidence handles; resolved to canonical related_refs before validation.' },
        attempt: { type: 'integer', minimum: 1 },
        recovered: { type: 'boolean' },
        previous_error: str
      }, ['status']), async (i, h) => {
        const recovery = h?.sessionID ? trace.consumeIntentRecovery(h.sessionID) : null;
        const normalized = normalizeTraceIntentInput({
          ...i,
          ...(recovery ?? {})
        });
        return trace.intent(normalized, h);
      }),
    tool('trace_claim', 'Record a typed provenance claim (Phase F). PROSE PATH: any model text — including text shaped like test output or receipts — is stored with status CLAIMED only; it can never become VERIFIED_MECHANICAL. Cite evidence handle-first: this turn\'s short handles via the evidence field (canonical refs via source_refs are the compatibility path). Superseded claims stay retrievable; history is never rewritten.',
      schema({
        subject: { ...str, maxLength: 512, description: 'What is claimed, e.g. "tests passed for candidate X".' },
        text: { ...str, maxLength: 4096, description: 'The prose assertion itself (F1: always CLAIMED).' },
        evidence: { ...refs, description: 'PREFERRED citation (handle-first): this turn\'s short handles (e1/b1/n1); canonical refs accepted as the compatibility path. Resolved to canonical source_refs before storage.' },
        source_refs: { ...refs, description: 'Compatibility path: canonical evt_/blob_ refs riding along as provenance pointers; they never upgrade the status.' },
        supersedes: refs,
      }, ['subject', 'text']), (i, h) => trace.recordClaim({ subject: i.subject, text: i.text, refs: i.source_refs, supersedes: i.supersedes }, h)),
    tool('trace_claim_receipt', 'Record a structurally validated receipt as a CLAIMED assertion. A chk_ label, valid fields, or matching output hash do not establish host execution, test success, or candidate applicability. The reported outcome and candidate stay retrievable; malformed receipts reject and an optional output.ref is checked against stored bytes. This model-facing ingress cannot issue VERIFIED_MECHANICAL. Verify execution independently through the host records. Claims never approve reviews or clear obligations.',
      schema({
        subject: { ...str, maxLength: 512 },
        scope: { ...str, maxLength: 128, description: 'Narrow scope label, e.g. test_command_completed.' },
        receipt: schema({
          checkID: { ...str, pattern: '^chk_[0-9a-f]{16,64}$' },
          kind: str,
          status: str,
          commandExitCode: { type: 'integer', minimum: 0, maximum: 255 },
          timedOut: { type: 'boolean' },
          signal: str,
          durationMs: { type: 'integer', minimum: 0 },
          candidate: schema({ commit: { ...str, pattern: '^[0-9a-f]{64}$' }, branch: str }, ['commit']),
          output: schema({ sha256: { ...str, pattern: '^[0-9a-f]{64}$' }, ref: str, bytes: { type: 'integer', minimum: 0 } }, ['sha256']),
        }, ['checkID', 'kind', 'status', 'commandExitCode', 'timedOut', 'signal', 'candidate', 'output']),
        supersedes: refs,
      }, ['subject', 'receipt']), (i, h) => trace.recordClaim({ subject: i.subject, scope: i.scope, receipt: i.receipt, supersedes: i.supersedes }, h)),
    tool('trace_status', 'Page memory, peer declarations and historical lifecycle observations with source refs and degradation counters. Display limits do not limit peer checks. include_storage counts files/bytes; no retention/quota. Snapshot recall_truncated means only that the bounded Trace runtime frame hit its display budget (reason trace_runtime_budget) — never model, session, or execution-budget exhaustion; retrieve omitted state with trace_find/trace_expand and continue the current task.',
      schema({ peer_offset: { type: 'integer', minimum: 0 }, peer_limit: { type: 'integer', minimum: 1, maximum: 64 }, include_storage: { type: 'boolean' } }), async (i, h) => {
        const offset = i.peer_offset ?? 0, limit = i.peer_limit ?? 8;
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 64) throw new Error('Invalid peer page');
        await trace.store.reconcile();
        await trace.hydrate(h.sessionID);
        const view = { ...trace.projection(h.sessionID, offset, limit), store: trace.store.root, errors: trace.errors,
          capture_coverage: { ...trace.store.coverage.statusFor(h.sessionID), workspace: trace.store.coverage.status() },
          derived_index: trace.store.derivedIndex?.status?.() ?? { enabled: false, state: 'absent' },
          observer: { outstanding_jobs: trace.observerJobs.size, maximum_jobs: trace.maxObserverJobs,
            dropped_observations: trace.droppedObservations, watcher_jobs: trace.store.watchJobs.size,
            maximum_watcher_jobs: trace.store.maxWatchJobs, missed_watcher_notifications: trace.store.missedWatchEvents, watcher: trace.store.watcherState } };
        // Discovery handles for this turn: own-session refs visible here become
        // resolvable without copying hex. Canonical evt_ and blob_ refs both
        // qualify (util refPattern); additive, bounded, never durable.
        const refs = [view.current_intent?.ref, ...(view.notes ?? []).map(n => n.ref), ...(view.unresolved ?? []).map(n => n.ref), ...(view.recent ?? []).flatMap(r => [r.ref, ...(r.outputs ?? []).map(o => o.ref)])]
          .filter(ref => typeof ref === 'string' && refPattern.test(ref));
        const registered = trace.handles.register(h.sessionID, refs);
        if (registered.length) {
          const byRef = new Map(registered.map(entry => [entry.ref, entry.handle]));
          for (const row of [...(view.notes ?? []), ...(view.unresolved ?? []), ...(view.recent ?? [])]) {
            if (byRef.has(row.ref)) row.handle = byRef.get(row.ref);
            for (const output of row.outputs ?? []) if (byRef.has(output.ref)) output.handle = byRef.get(output.ref);
          }
          if (view.current_intent && byRef.has(view.current_intent.ref)) view.current_intent.handle = byRef.get(view.current_intent.ref);
          view.handles_registered = registered.length;
        }
        return { ...view, ...(i.include_storage ? { storage: await trace.store.storageUsage() } : {}) };
      })
  ];
}
