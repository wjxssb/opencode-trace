// CanonicalCaptureEnvelopeV1 (V3 stage S6) — the explicit canonical domain
// type at the G write boundary.
//
// The envelope is the ONLY shape the capture backend (queue, journal,
// worker, CAS, coverage, FTS) ever sees. It CANNOT represent model handles:
// every identity field is a full canonical evt_/blob_ ref, validated
// positively with refPattern. Anything handle-shaped (e1), token-shaped
// (cb_), or malformed fails validation BEFORE queue admission — the G side
// never learns the vocabulary for model identities (it does not import the
// handle registry module and never matches handle patterns; see the §13
// dependency test).
//
// Write path (§12): model handles/finalization sets -> EvidenceGateway (resolve,
// validate, expand) -> canonical normalized evidence -> envelope build ->
// sequence/event identity -> queue -> worker -> CAS/coverage/FTS/provenance.
// If gateway resolution fails, NOTHING enters G.
import { hash, stable, refPattern } from './util.js';

export const CANONICAL_CAPTURE_ENVELOPE_SCHEMA = 1;

// Identity fields that must each be a full canonical ref when present.
const REF_FIELDS = ['event_ref', 'payload_ref', 'previous_event_ref', 'caused_by',
  'candidate_binding', 'claim_binding'];
const REF_LIST_FIELDS = ['source_refs', 'evidence_refs'];

function bad(what) { return new Error(`CanonicalCaptureEnvelopeV1: invalid ${what}`); }

/**
 * Positive canonical-only validation. Every identity position must hold a
 * full canonical evt_/blob_ ref; handle-shaped, token-shaped, truncated or
 * otherwise malformed values are rejected. Arbitrary payload CONTENT is
 * never scanned (content is evidence, not identity — scanning it would
 * false-positive on shell output that merely mentions short labels).
 */
export function assertCanonicalEnvelope(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw bad('envelope (must be an object)');
  if (env.schema !== CANONICAL_CAPTURE_ENVELOPE_SCHEMA) throw bad('schema (must be 1)');
  for (const f of ['workspace_id', 'session_id', 'event_type', 'event_ref', 'idempotency_key']) {
    if (typeof env[f] !== 'string' || !env[f]) throw bad(`${f} (must be a non-empty string)`);
  }
  if (!Number.isInteger(env.session_seq) || env.session_seq < 1) throw bad('session_seq (must be a positive integer)');
  if (typeof env.created_at !== 'number' || !Number.isFinite(env.created_at)) throw bad('created_at (must be a finite number)');
  for (const f of REF_FIELDS) {
    if (env[f] !== undefined && env[f] !== null && !refPattern.test(env[f])) throw bad(`${f} ${JSON.stringify(String(env[f]).slice(0, 40))} (must be a canonical evt_/blob_ ref)`);
  }
  for (const f of REF_LIST_FIELDS) {
    if (env[f] === undefined) continue;
    if (!Array.isArray(env[f]) || env[f].length > 16) throw bad(`${f} (must be an array of up to 16 refs)`);
    for (let i = 0; i < env[f].length; i++) {
      if (!refPattern.test(env[f][i])) throw bad(`${f}[${i}] ${JSON.stringify(String(env[f][i]).slice(0, 40))} (must be a canonical evt_/blob_ ref)`);
    }
  }
  const payload = env.payload;
  if (!payload || typeof payload !== 'object') throw bad('payload (must be an object)');
  if (!refPattern.test(payload.ref) || typeof payload.sha256 !== 'string' || typeof payload.bytes !== 'number') {
    throw bad('payload.ref/sha256/bytes (must be canonical + coherent metadata)');
  }
  if (payload.sha256 !== payload.ref.slice(5)) throw bad('payload.ref must match payload.sha256');
  if (Array.isArray(env.outputs)) {
    for (let i = 0; i < env.outputs.length; i++) {
      const o = env.outputs[i];
      if (!o || typeof o !== 'object' || !refPattern.test(o.ref)) throw bad(`outputs[${i}].ref (must be a canonical blob ref)`);
    }
  }
  if (Array.isArray(env.blobs)) {
    for (let i = 0; i < env.blobs.length; i++) {
      const b = env.blobs[i];
      if (!b || typeof b !== 'object' || !refPattern.test(b.ref)) throw bad(`blobs[${i}].ref (must be a canonical blob ref)`);
    }
  }
  return true;
}

/** Pure in-memory payload identity (same bytes as Store.blobRef, no I/O). */
export function payloadIdentity(data) {
  const bytes = Buffer.from(stable(data), 'utf8');
  const digest = hash(bytes);
  return { ref: `blob_${digest}`, sha256: digest, bytes: bytes.length, encoding: 'json' };
}

/**
 * Build the canonical envelope for one event. All refs are computed in
 * memory (content addressing); NOTHING is written. seq/previous come from
 * the caller, which allocates them through the durable per-session
 * allocator at enqueue time so loss accounting stays exact.
 *
 * The body mirrors the synchronous record() path byte-for-byte (schema-1
 * base + schema-2 causal wrap), so an event ref is identical whether the
 * event travels the sync path or the capture path (idempotency + causal
 * chain integrity across paths).
 */
export function buildCanonicalEnvelope({ workspace_id, session_id, event_type, host, data, extra = {}, seq, previous_event_ref = null }) {
  const payload = payloadIdentity(data);
  const v1 = { schema: 1, workspaceID: workspace_id, type: event_type, host, payload: { ...payload }, ...extra };
  delete v1.payload.content;
  const body = { ...v1, event_schema: 2, session_seq: seq, ...(previous_event_ref ? { previous_event_ref } : {}) };
  const ref = `evt_${hash(stable(body))}`;
  const envelope = {
    schema: CANONICAL_CAPTURE_ENVELOPE_SCHEMA,
    workspace_id, session_id,
    session_seq: seq,
    ...(previous_event_ref ? { previous_event_ref } : {}),
    event_ref: ref,
    event_type,
    payload_ref: payload.ref,
    payload: { ref: payload.ref, sha256: payload.sha256, bytes: payload.bytes, encoding: payload.encoding },
    source_refs: [...(extra.source_refs ?? [])],
    evidence_refs: [...(extra.evidence_refs ?? [])],
    ...(extra.caused_by ? { caused_by: extra.caused_by } : {}),
    ...(extra.candidate_binding ? { candidate_binding: extra.candidate_binding } : {}),
    ...(extra.claim_binding ? { claim_binding: extra.claim_binding } : {}),
    ...(Array.isArray(extra.outputs) ? { outputs: extra.outputs.map(o => ({ ...o })) } : {}),
    idempotency_key: `${session_id}:${seq}:${ref.slice(4, 16)}`,
    created_at: Date.now(),
    // Persistence inputs (content, not identity — never scanned for vocabulary):
    body, encoded: stable(data),
  };
  assertCanonicalEnvelope(envelope);
  return envelope;
}
