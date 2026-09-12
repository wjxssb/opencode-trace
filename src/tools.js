const str = { type: 'string' };
const refs = { type: 'array', items: str, maxItems: 16 };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
import { present, boundedRaw } from './present.js';
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
        return await result(name, { ok: true, ...await fn(input, host) }, trace);
      } catch (error) {
        trace.warning(name, error);
        return result(name, { ok: false, error: String(error.code ?? error.message ?? 'Trace unavailable').slice(0, 160), native_execution: 'unaffected' }, trace);
      }
    }
  });
  return [
    tool('trace_note', 'Save a model-selected fact, finding, decision, unresolved item, handoff or correction. Source refs must already exist in this workspace; host supplies your identity.',
      schema({ kind: { enum: ['fact', 'finding', 'decision', 'unresolved', 'handoff', 'correction'] }, text: { ...str, maxLength: 4096 }, source_refs: refs, supersedes: refs, depends_on: refs }, ['kind', 'text', 'source_refs']), (i, h) => trace.note(i, h)),
    tool('trace_expand', 'Retrieve exact stored evidence; never rereads the source file. Use metadata_only:true to inspect refs without payload. text_blobs are exact tool text, payload_ref is the full event JSON envelope. Choose the needed ref yourself. Default page 2048 bytes; limit up to 24000. Follow next_offset until null; repeating a page provides no new bytes. SHA-256 verifies the full blob; base64 preserves arbitrary byte boundaries.',
      schema({ ref: str, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 24000 }, metadata_only: { type: 'boolean' } }, ['ref']), i => trace.store.expand(i.ref, i.offset, i.limit, i.metadata_only)),
    tool('trace_find', 'Find historical events by clues instead of known refs: type, session, agent, tool, status, call_key, path, time range, thread/mail/related ref, or text keyword. Plan history is addressable structurally: plan ref, step id, worker session, or attempt_id. text matches capped index hints; deep:true additionally scans exact blob bytes under a budget with a resumable cursor. Returns limited candidates with hit snippets and refs for trace_expand. Index is derived from all ingested history, not the recent window.',
      schema({
        type: { anyOf: [{ type: 'string' }, { type: 'array', items: str, maxItems: 8 }] },
        session: str, agent: str, tool: str, status: str,
        call_key: str, ref: str, related: str, path: str, text: str,
        thread: str, message: str, recipient: str, reply_to: str, proposal: str,
        plan: str, step: str, worker: str, attempt_id: str,
        deep: { type: 'boolean' }, deep_budget_bytes: { type: 'integer', minimum: 1024, maximum: 16777216 },
        after: { type: 'number', minimum: 0 }, before: { type: 'number', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: str,
      }), i => trace.find(i)),
    tool('trace_send', 'Persist and deliver a directed negotiation message to observed sessions in this workspace. Sender identity comes from the host, never from your input. The message is persisted before delivery; receipts distinguish persisted, host_admitted, failed and uncertain states. accept/reject/counter must bind an explicit proposal or counter message id. Delivery only uses the host prompt queue/steer boundary.',
      schema({
        to: { type: 'array', items: str, minItems: 1, maxItems: 8 },
        text: { ...str, maxLength: 16384 },
        type: { enum: ['question', 'proposal', 'objection', 'counter', 'evidence', 'accept', 'reject', 'withdraw', 'handoff', 'note'] },
        thread_id: str, in_reply_to: str, proposal: str,
        delivery: { enum: ['steer', 'queue'] },
        source_refs: refs,
      }, ['to', 'text']), (i, h) => trace.send(i, h)),
    tool('trace_inbox', 'Show negotiation messages addressed to you and messages you sent, with evidence levels per message: persisted, host_admitted, context_observed, recipient_ack, reply_recorded. Each level needs its own recorded or derived event; a receipt is never agreement. sweep:true retries only sends whose delivery record is entirely missing; uncertain host admissions are reported for manual choice, never auto-retried.',
      schema({ thread_id: str, sweep: { type: 'boolean' } }), (i, h) => trace.inbox(i, h)),
    tool('trace_ack', 'Record that you received a specific trace message. This is a delivery receipt only; it never means agreement or completion.',
      schema({ message_id: str }, ['message_id']), (i, h) => trace.ack(i, h)),
    tool('trace_step_result', 'Worker sessions only: submit the structured outcome of the plan step this session was bound to. The orchestrator treats a settled child turn without this result as outcome unknown, and dependents run only on worker-reported success. status must reflect what actually happened - a denied or failed operation is failure, not success. Identity, plan and step come from the host session binding; a session can only report its own step.',
      schema({ status: { enum: ['success', 'failure'] }, summary: { ...str, maxLength: 2048 }, source_refs: refs }, ['status']), (i, h) => trace.stepResult(i, h)),
    tool('trace_plan', 'Execute a small dependency-ordered plan through native sessions only: you own the plan, this binds each step to a fresh session (create + prompt + wait + collect). Independent steps fan out in waves. A step settles when the child turn finishes - that is NOT task success: dependents run only when the worker itself reported success via trace_step_result (outcome worker_reported_success); settled-with-unknown or worker-reported failure blocks dependents. Recorded terminal states - settled (any outcome), transport_failed, failed, cancelled and unsupported - are never re-executed when the same plan version returns; pass retry_failed:true for an explicit new attempt at every step without worker-reported success (each new attempt keeps old attempt evidence). Plan identity is scoped to your session. Optional step.agent must name a real host agent from the recorded snapshot and is bound via native agent switching. Maximum 8 steps; step text up to 4096 bytes. Plan acceptance never completes your parent task by itself.',
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
      schema({ summary: str, paths: { type: 'array', items: str, maxItems: 64 }, resources: { type: 'array', items: str, maxItems: 32 }, status: { enum: ['active', 'waiting', 'done', 'cancelled'] }, related_refs: refs }, ['summary', 'paths', 'status']), (i, h) => trace.intent(i, h)),
    tool('trace_status', 'Show bounded memory, peer intent declarations separately from historical host lifecycle observations, exact source refs and degradation count. Peer pagination limits display only. include_storage:true performs an optional filesystem byte/object count; no retention or quota is enforced.',
      schema({ peer_offset: { type: 'integer', minimum: 0 }, peer_limit: { type: 'integer', minimum: 1, maximum: 64 }, include_storage: { type: 'boolean' } }), async (i, h) => {
        const offset = i.peer_offset ?? 0, limit = i.peer_limit ?? 8;
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 64) throw new Error('Invalid peer page');
        await trace.store.reconcile();
        await trace.hydrate(h.sessionID);
        return { ...trace.projection(h.sessionID, offset, limit), store: trace.store.root, errors: trace.errors,
          observer: { outstanding_jobs: trace.observerJobs.size, maximum_jobs: trace.maxObserverJobs,
            dropped_observations: trace.droppedObservations, watcher_jobs: trace.store.watchJobs.size,
            maximum_watcher_jobs: trace.store.maxWatchJobs, missed_watcher_notifications: trace.store.missedWatchEvents },
          ...(i.include_storage ? { storage: await trace.store.storageUsage() } : {}) };
      })
  ];
}
