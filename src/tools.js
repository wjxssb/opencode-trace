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
    tool('trace_expand', 'Retrieve exact stored event, note or blob evidence. Byte pagination, base64 for lossless page boundaries; never rereads the current source file.',
      schema({ ref: str, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 24000 } }, ['ref']), i => trace.store.expand(i.ref, i.offset, i.limit)),
    tool('trace_intent', 'Declare your current intent and explicit paths/resources. Overlap produces advisory information only. Update to done/cancelled when finished.',
      schema({ summary: str, paths: { type: 'array', items: str, maxItems: 64 }, resources: { type: 'array', items: str, maxItems: 32 }, status: { enum: ['active', 'waiting', 'done', 'cancelled'] }, related_refs: refs }, ['summary', 'paths', 'status']), (i, h) => trace.intent(i, h)),
    tool('trace_status', 'Show bounded workspace/session memory, real peer sessions, recent source event refs and degradation count. Peer pagination limits display only.',
      schema({ peer_offset: { type: 'integer', minimum: 0 }, peer_limit: { type: 'integer', minimum: 1, maximum: 64 } }), async (i, h) => {
        const offset = i.peer_offset ?? 0, limit = i.peer_limit ?? 8;
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 64) throw new Error('Invalid peer page');
        await trace.hydrate(h.sessionID);
        return { ...trace.projection(h.sessionID, offset, limit), store: trace.store.root, errors: trace.errors };
      })
  ];
}
