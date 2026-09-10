const str = { type: 'string' };
const refs = { type: 'array', items: str, maxItems: 16 };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const result = value => {
  const content = JSON.stringify(value);
  // Host output-schema validation requires JSON values, including nested fields.
  return { output: JSON.parse(content), content, metadata: { opencode_trace: true } };
};

export function definitions(trace) {
  const tool = (name, description, input, fn) => ({ name, description, input, output: { type: 'object', additionalProperties: true },
    options: { codemode: false, permission: name },
    async execute(input, host) {
      try {
        await trace.ready;
        if (!host?.sessionID) throw new Error('Host session identity unavailable');
        return result({ ok: true, ...await fn(input, host) });
      } catch (error) {
        trace.warning(name, error);
        return result({ ok: false, error: String(error.code ?? error.message ?? 'Trace unavailable').slice(0, 160), native_execution: 'unaffected' });
      }
    }
  });
  return [
    tool('trace_note', 'Save a model-selected fact, finding, decision, unresolved item, handoff or correction. Source refs must already exist in this workspace; host supplies your identity.',
      schema({ kind: { enum: ['fact', 'finding', 'decision', 'unresolved', 'handoff', 'correction'] }, text: { ...str, maxLength: 4096 }, source_refs: refs, supersedes: refs, depends_on: refs }, ['kind', 'text', 'source_refs']), (i, h) => trace.note(i, h)),
    tool('trace_expand', 'Retrieve exact stored evidence; never rereads the source file. Use metadata_only:true to inspect refs without payload. text_blobs are exact tool text, payload_ref is the full event JSON envelope. Choose the needed ref yourself. Default page 2048 bytes; limit up to 24000. Follow next_offset until null; repeating a page provides no new bytes. SHA-256 verifies the full blob; base64 preserves arbitrary byte boundaries.',
      schema({ ref: str, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 24000 }, metadata_only: { type: 'boolean' } }, ['ref']), i => trace.store.expand(i.ref, i.offset, i.limit, i.metadata_only)),
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
