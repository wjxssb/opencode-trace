// EvidenceGateway (V3 stage S1) — the single model-facing evidence ingress
// authority. Every citation token a model supplies passes through here
// exactly once:
//   turn-scoped handle (e#/b#/n#)  -> resolved against the current session
//                                     generation BEFORE any store validation
//   canonical evt_/blob_ ref        -> validated against the store
//   anything else                   -> fail closed with a precise diagnostic
// Handles are never persisted as identity; durable payloads keep full
// canonical refs only. No fuzzy repair: malformed identity is rejected, and
// diagnostics (closest stored ref, live handles) are display-only hints that
// are never auto-applied.
//
// Responsibilities (mission §5): resolveCitation, resolveMany,
// normalizeEvidence, validateGeneration/Session/Expiry/EvidenceType,
// validateCandidate, bindClaim, registerEvidence, prepareModelView,
// normalizeHandoff.
//
// Deliberately NOT in this module (S1 boundary): hashing, CAS writes,
// sequence allocation, FTS, queue management, Reviewer receipt grammar.
// The gateway ORCHESTRATES identity resolution and validation; the store
// remains the sole authority for CAS and durable identity.

import * as fs from 'node:fs/promises';
import path from 'node:path';
import { refPattern } from './util.js';
import { assignSnapshotHandles, HANDLE_PATTERN, handleFailureMessage } from './handles.js';

export class EvidenceGateway {
  /**
   * @param {object} trace the owning Trace instance (handles + store + tool
   *   behavior are reached through it so the gateway stays a pure ingress
   *   authority over identity, not a second store facade)
   */
  constructor(trace) {
    this.trace = trace;
  }

  get handles() { return this.trace.handles; }
  get store() { return this.trace.store; }

  // ---- identity validation helpers (mission §5 validate* responsibilities) ----

  /**
   * Validate the handle generation for a session: exact-match resolution.
   * Reasons mirror HandleRegistry.resolve: expired / foreign_session / unknown.
   */
  validateGeneration(sessionID, handle) {
    return this.handles.resolve(sessionID, handle);
  }

  /** A handle only ever resolves within its own session (never cross-session). */
  validateSession(sessionID, handle) {
    const r = this.validateGeneration(sessionID, handle);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason, session_scope_violation: r.reason === 'foreign_session' };
  }

  /** An expired handle is rejected, never silently rebound. */
  validateExpiry(sessionID, handle) {
    const r = this.validateGeneration(sessionID, handle);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason, expired: r.reason === 'expired' };
  }

  /**
   * Validate the evidence type a resolved ref may carry in a given slot
   * (e.g. supersedes must reference a note from the caller's own session).
   * Type expectations stay in the tool layer for now (S1 externally
   * equivalent); this method exposes the check as the single gateway path.
   */
  async validateEvidenceType(ref, expectation) {
    const entry = await this.store.exists(ref);
    if (expectation?.type && entry.type !== expectation.type) {
      throw new Error(expectation.message ?? `ref ${ref.slice(0, 15)}… is not of type ${expectation.type}`);
    }
    if (expectation?.session && entry.host?.sessionID !== expectation.session) {
      throw new Error(expectation.sessionMessage ?? 'ref belongs to a different session');
    }
    return entry;
  }

  /** Candidate validation: existence is the S1 bar; candidate binding (F5) routes through here at S2. */
  async validateCandidate(ref) {
    await this.store.exists(ref);
    return true;
  }

  /**
   * bindClaim: the single ingress point for typed provenance binding (S2
   * routes trace_claim through it). Receipt grammar and trust boundaries
   * stay in claims.js/trace.recordClaim — the gateway only guarantees that
   * any refs riding along are canonical and validated first.
   */
  async bindClaim(input, host) {
    if (Array.isArray(input?.refs)) await this.refs(input.refs, 'source_refs');
    if (Array.isArray(input?.supersedes)) await this.refs(input.supersedes, 'supersedes');
    return this.trace.recordClaim(input, host);
  }

  // ---- citation resolution ----

  /**
   * THE single citation entry point (S3 makes this the only model-facing
   * path). Strict form: one token in, one canonical ref out.
   *   handle-shaped  -> current-generation exact match (never expired, never
   *                     foreign, never unknown without failing closed)
   *   canonical ref  -> validated to exist in this workspace
   *   anything else  -> invalid identity, fail closed
   */
  async resolveCitation(sessionID, token, field = 'source_refs') {
    if (typeof token !== 'string') throw new Error(`Invalid ${field}: expected a ref string`);
    const v = token.trim();
    if (HANDLE_PATTERN.test(v)) {
      const r = this.validateGeneration(sessionID, v);
      if (!r.ok) throw new Error(handleFailureMessage(sessionID, v, r.reason));
      return { ref: r.ref, via: 'handle', kind: r.kind, handle: v };
    }
    if (refPattern.test(v)) {
      try { await this.validateCandidate(v); }
      catch (error) {
        if (error?.code === 'ENOENT') throw new Error(`Unknown ${field} ${String(v).slice(0, 80)}: not found in this workspace; use trace_find then trace_expand for a valid ref`);
        throw error;
      }
      return { ref: v, via: 'canonical' };
    }
    throw new Error(`Invalid ${field} ${String(v).slice(0, 80)}`);
  }

  async resolveMany(sessionID, tokens, field = 'source_refs') {
    const out = [];
    const resolutions = [];
    for (const token of tokens ?? []) {
      const r = await this.resolveCitation(sessionID, token, field);
      out.push(r.ref);
      if (r.via === 'handle') resolutions.push({ handle: r.handle, ref: r.ref });
    }
    return { refs: [...new Set(out)], resolutions };
  }

  // ---- canonical ref validation (moved verbatim from Trace.refs) ----

  /**
   * Query-filter ref validation (find). Filters are NOT citations: a filter
   * naming a ref that is not (yet) ingested here legitimately matches
   * nothing, so existence is not required — but the token must still be a
   * structurally valid canonical ref (fail closed, no fuzzy repair).
   */
  validateFilterRef(ref, field = 'ref filter') {
    if (ref !== undefined && !refPattern.test(ref)) throw new Error(`Invalid ${field}`);
    return ref;
  }
  async refs(refs = [], field = 'source_refs') {
    if (!Array.isArray(refs) || refs.length > 16) throw new Error(`Expected ${field} as up to 16 refs`);
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      if (typeof ref !== 'string') throw new Error(`Invalid ${field}[${i}]: expected a ref string`);
      try {
        await this.store.exists(ref);
      } catch (error) {
        const shown = String(ref).slice(0, 80);
        if (error?.code === 'ENOENT') throw new Error(`Unknown ${field}[${i}] ${shown}: not found in this workspace; use trace_find then trace_expand for a valid ref`);
        const detail = String(error?.message ?? error?.code ?? 'invalid ref');
        const core = detail.replace(/^Invalid (source|event|blob) ref \S+:?\s*/, '');
        throw new Error(`Invalid ${field}[${i}] ${shown}: ${core}${await this.closestRefHint(ref)}`);
      }
    }
    return [...new Set(refs)];
  }

  // Deterministic, display-only hint for a malformed ref: if exactly one stored
  // event ref shares a >=16 hex char prefix with the malformed value, point at
  // the full canonical ref so the model can copy it verbatim. The malformed
  // ref is still rejected; validation never loosens and the hint never accepts.
  async closestRefHint(ref) {
    const prefix = ref.startsWith('blob_') ? 'blob_' : ref.startsWith('evt_') ? 'evt_' : '';
    if (!prefix) return '';
    let names;
    try { names = await fs.readdir(path.join(this.store.root, 'events')); } catch { return ''; }
    let best = null;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const stored = name.slice(0, -5);
      let shared = 0;
      while (shared < ref.length && shared < stored.length && ref[shared] === stored[shared]) shared++;
      if (shared - prefix.length < 16) continue;
      if (best === null) best = { ref: stored, shared };
      else if (best.shared === shared || best.ref !== stored) return '';
    }
    return best ? ` Closest stored ref: ${best.ref} (copy it verbatim or omit this field; shortened or invented refs are rejected).` : '';
  }

  /** Fail-closed invalid-ref error plus a diagnostic hint pointing at the
   * current turn's live handles. Never auto-corrects, never fuzzy-matches. */
  async refsOrHint(refs, field, host) {
    try { return await this.refs(refs, field); }
    catch (error) {
      if (String(error.message).includes('not found in this workspace') && host?.sessionID) {
        const handles = this.handles.listSession(host.sessionID, 12);
        if (handles.length) {
          const hint = handles.map(h => h.handle).join(' ');
          throw new Error(`${error.message} Current turn evidence handles: ${hint} — pass one as source_handles/evidence_handles, or run trace_find/trace_expand to re-register historical evidence.`);
        }
      }
      throw error;
    }
  }

  // ---- input normalization (moved verbatim from Trace.resolveInputHandles) ----
  //
  // Resolve ephemeral evidence handles to canonical refs BEFORE any store
  // validation sees the input. Canonical refs pass through untouched; strings
  // that are neither canonical refs nor handles are left for downstream
  // validation to reject with its existing precise errors. Handles are never
  // persisted as identity: the raw input remains the durable audit record,
  // and a best-effort `trace.handle_resolution` event records the handle ->
  // canonical correspondence for this call (additive event type, no schema
  // change to existing events). Returns the resolutions (possibly empty).
  async normalizeEvidence(input, sessionID, toolName = null, host = {}, rawCallKey = null) {
    const resolutions = [];
    if (!input || typeof input !== 'object') return resolutions;
    const resolveOne = value => {
      if (typeof value !== 'string') return value;
      const v = value.trim();
      if (refPattern.test(v) || !HANDLE_PATTERN.test(v)) return value;
      const resolved = this.handles.resolve(sessionID, v);
      if (!resolved.ok) throw new Error(handleFailureMessage(sessionID, v, resolved.reason));
      resolutions.push({ handle: v, ref: resolved.ref });
      return resolved.ref;
    };
    if (typeof input.ref === 'string') input.ref = resolveOne(input.ref);
    for (const field of ['source_refs', 'supersedes', 'depends_on', 'related_refs']) {
      if (Array.isArray(input[field])) input[field] = input[field].map(resolveOne);
    }
    if (input.milestone && Array.isArray(input.milestone.evidence_refs)) {
      input.milestone.evidence_refs = input.milestone.evidence_refs.map(resolveOne);
    }
    const merge = (container, handleField, canonicalField) => {
      const handles = container[handleField];
      if (handles === undefined) return;
      if (!Array.isArray(handles)) throw new Error(`${handleField} must be an array of evidence handles (e1/b1/n1)`);
      const resolved = handles.map(value => {
        if (typeof value !== 'string' || !HANDLE_PATTERN.test(value.trim())) {
          throw new Error(`${handleField} accepts only evidence handles like e1/b1/n1; got ${JSON.stringify(String(value).slice(0, 40))}`);
        }
        const r = this.handles.resolve(sessionID, value.trim());
        if (!r.ok) throw new Error(handleFailureMessage(sessionID, value.trim(), r.reason));
        resolutions.push({ handle: value.trim(), ref: r.ref });
        return r.ref;
      });
      container[canonicalField] = [...new Set([...(container[canonicalField] ?? []), ...resolved])];
      delete container[handleField];
    };
    merge(input, 'source_handles', 'source_refs');
    merge(input, 'supersedes_handles', 'supersedes');
    merge(input, 'depends_on_handles', 'depends_on');
    merge(input, 'related_handles', 'related_refs');
    if (input.milestone) merge(input.milestone, 'evidence_handles', 'evidence_refs');
    if (resolutions.length) {
      try {
        await this.store.record('trace.handle_resolution', { sessionID }, {
          tool: toolName ?? null, resolutions, raw_call_key: rawCallKey ?? null,
          semantics: 'correspondence metadata only: raw input may cite ephemeral handles; canonical evt_/blob_ refs remain the only durable identity',
        }, { callKey: rawCallKey ?? null });
      } catch { /* best-effort metadata; the raw input echo remains the audit record */ }
    }
    return resolutions;
  }

  /** Register refs discovered by read tools this turn (delegation). */
  registerEvidence(sessionID, refs = []) {
    return this.handles.register(sessionID, refs);
  }

  /** The model-visible handle projection for a finished snapshot (delegation; S3/S4 evolve this). */
  prepareModelView(view) {
    return assignSnapshotHandles(view);
  }

  /**
   * normalizeHandoff (S1): handoff notes are the finalization path. The
   * evidence fields must resolve through the gateway before storage; the
   * semantic note construction stays in Trace.note (S1 externally equivalent).
   */
  async normalizeHandoff(input, host) {
    const source_refs = await this.refsOrHint(input.source_refs, 'source_refs', host);
    const supersedes = await this.refs(input.supersedes, 'supersedes');
    const depends_on = await this.refs(input.depends_on, 'depends_on');
    return { source_refs, supersedes, depends_on };
  }
}
