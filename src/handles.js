// Ephemeral, host-managed, turn-scoped evidence handles (Trace V2 Phase A).
//
// Handles give the model short deterministic labels ([e1], [b1], [n1]) for
// canonical refs carried in one runtime snapshot, so normal tool use never
// requires copying 256-bit identifiers. Production incident 2026-09-20
// (session ses_f427e7ae9ffeze5yh969vDn4uN): the model corrupted 49-hex and
// 61-hex copies of full refs it had seen verbatim in the same recall.
//
// Invariants (see docs/v2/A-HANDLES.md):
// - Transport/display only. A handle is NEVER a durable identity, never
//   written into evidence payloads, never accepted by the store. Resolution
//   to canonical evt_/blob_ refs happens in the tool layer BEFORE any store
//   validation, so durable state keeps storing full refs only.
// - Scope: one generation per (session, model request). The generation is
//   installed when a recall snapshot is prepared and stays valid until the
//   next request for that session replaces it - covering the whole turn and
//   its tool calls. Exactly one previous generation per session is retained
//   as a tombstone so stale handles report "expired", not "unknown".
// - Deterministic: snapshot assignment is a pure function of the final
//   rendered view (same state + same snapshot => same handles, same order).
// - Never guess: resolution is exact match against the current generation.
//   No prefix matching, no similarity, no cross-session fallback, ever.
// - Handle forms are disjoint from canonical refs: /^[ebn][1-9][0-9]{0,3}$/
//   can never collide with evt_<64hex> / blob_<64hex>, and no truncated SHA
//   string is ever treated as a handle.

import { refPattern } from './util.js';

export const HANDLE_PATTERN = /^(?:[ebn][1-9][0-9]{0,3})$/;
// Bounded mapping sizes: a snapshot may label at most 64 refs; tool results
// may register at most 64 more per call; a generation holds at most 256.
export const SNAPSHOT_HANDLE_CAP = 64;
export const REGISTRATION_CAP = 64;
export const GENERATION_CAP = 256;
// Conservative TTL for generations of sessions whose disposal signal was
// never observed (observer drop, crash, missed watcher event). Far beyond
// any live turn (model turns are seconds to minutes), so eviction can never
// hit a session that is mid-request.
export const DEFAULT_HANDLE_TTL_MS = 6 * 60 * 60 * 1000;
// Opportunistic sweep throttle: at most one scan per minute of process life.
const SWEEP_INTERVAL_MS = 60 * 1000;

export const isHandle = value => typeof value === 'string' && HANDLE_PATTERN.test(value);

// Display tail only: short, explicitly ellipted, never a usable identity.
const tail = ref => typeof ref === 'string' && ref.length > 20
  ? `${ref.slice(0, 11)}…${ref.slice(-4)}`
  : String(ref ?? '');

/**
 * Assign handles to a finished snapshot projection view (pure function).
 * Walk order is the model-facing display order: recent events (oldest first,
 * matching the projection order), then their output blobs, then retained
 * notes and unresolved notes, then the current intent ref. The view gains an
 * `evidence_handles` display list (tails only); the returned assignments
 * carry the full canonical refs for the in-memory registry.
 */
export function assignSnapshotHandles(view) {
  const assignments = [];
  const seen = new Set();
  const ordinals = { e: 0, b: 0, n: 0 };
  const add = (kind, ref, label) => {
    if (assignments.length >= SNAPSHOT_HANDLE_CAP || typeof ref !== 'string' || !refPattern.test(ref) || seen.has(ref)) return;
    seen.add(ref);
    const prefix = kind === 'blob' ? 'b' : kind === 'note' ? 'n' : 'e';
    ordinals[prefix] += 1;
    const handle = `${prefix}${ordinals[prefix]}`;
    assignments.push({ handle, ref, kind, label });
  };
  for (const row of view.recent ?? []) {
    add('event', row.ref, `${row.tool ?? row.type ?? 'event'}${row.status ? ` · ${row.status}` : ''}`);
  }
  for (const row of view.recent ?? []) {
    for (const output of row.outputs ?? []) add('blob', output.ref, `output · ${output.bytes ?? '?'}B`);
  }
  // Phase II handle-first fix (H12): active-memory evidence refs are the
  // finalization-critical citations — they must always carry handles, or the
  // model is forced back to copying 64-hex refs (the exact incident this
  // closes: handoff notes citing gate-review events canonically because the
  // refs surfaced in active memory had no current-turn handle).
  for (const ref of view.active_memory?.evidence_refs ?? []) {
    add('event', ref, 'active-memory evidence');
  }
  for (const note of [...(view.notes ?? []), ...(view.unresolved ?? [])]) {
    add('note', note.ref, `note(${note.kind ?? '?'})`);
  }
  if (view.current_intent?.ref) add('event', view.current_intent.ref, `intent(${view.current_intent.status ?? '?'})`);
  view.evidence_handles = assignments.map(a => ({
    handle: a.handle,
    kind: a.kind,
    ref: tail(a.ref),
    ...(a.label ? { label: a.label } : {}),
  }));
  return assignments;
}

/** Render the model-facing handle block for the recall text. */
export function renderEvidenceHandles(rows) {
  if (!Array.isArray(rows) || !rows.length) return '';
  const lines = rows.map(r => `[${r.handle}] ${r.label ?? r.kind}${r.ref ? ` → ${r.ref}` : ''}`);
  return `\n\n=== EVIDENCE HANDLES (turn-scoped labels; pass them to trace tools) ===\n${lines.join('\n')}`;
}

export function handleFailureMessage(sessionID, handle, reason) {
  if (reason === 'expired') {
    return `Expired evidence handle '${handle}': superseded by a newer runtime snapshot of this session; re-read the current Evidence list.`;
  }
  if (reason === 'foreign_session') {
    return `Evidence handle '${handle}' belongs to a different session's mapping and is never resolved across sessions.`;
  }
  return `Unknown evidence handle '${handle}': not in this turn's mapping. Handles are turn-scoped and regenerated on resume; re-read the Evidence list in the runtime context or run trace_status.`;
}

export class HandleRegistry {
  constructor() {
    this.active = new Map();   // sessionID -> generation
    this.retired = new Map();  // sessionID -> previous generation (tombstone only)
    this.lastSweepAt = Date.now();
  }

  /**
   * Drop every mapping for a disposed/deleted session (active + retired
   * tombstone). Called from the session lifecycle observer on
   * `session.deleted`; safe to call for unknown sessions (no-op).
   */
  release(sessionID) {
    const hadActive = this.active.delete(sessionID);
    this.retired.delete(sessionID);
    return hadActive;
  }

  /**
   * Bounded GC for sessions whose disposal signal was never delivered
   * (observer drop, crash, missed watcher event). Age-based only: a
   * generation older than the TTL cannot belong to a live turn, so this can
   * never clean a session that is still active. Returns evicted sessions.
   */
  sweep(now = Date.now(), ttlMs = DEFAULT_HANDLE_TTL_MS) {
    const evicted = [];
    for (const [sessionID, generation] of this.active) {
      if (now - generation.created_at > ttlMs) { this.active.delete(sessionID); this.retired.delete(sessionID); evicted.push(sessionID); }
    }
    for (const [sessionID, generation] of this.retired) {
      if (now - generation.created_at > ttlMs) this.retired.delete(sessionID);
    }
    return evicted;
  }

  /** Install the generation for a freshly prepared snapshot. */
  newGeneration(sessionID, assignments = []) {
    const now = Date.now();
    if (now - this.lastSweepAt >= SWEEP_INTERVAL_MS) { this.lastSweepAt = now; this.sweep(now); }
    const byHandle = new Map(), byRef = new Map();
    const next = { e: 0, b: 0, n: 0 };
    const previous = this.active.get(sessionID);
    if (previous) this.retired.set(sessionID, previous);
    else this.retired.delete(sessionID);
    for (const a of assignments) {
      if (byHandle.size >= GENERATION_CAP) break;
      const prefix = typeof a.handle === 'string' ? a.handle[0] : '';
      const ordinal = Number(typeof a.handle === 'string' ? a.handle.slice(1) : NaN);
      if (prefix in next && Number.isFinite(ordinal)) next[prefix] = Math.max(next[prefix], ordinal);
      byHandle.set(a.handle, { ref: a.ref, kind: a.kind, label: a.label });
      if (!byRef.has(a.ref)) byRef.set(a.ref, a.handle);
    }
    const generation = { byHandle, byRef, next, created_at: Date.now() };
    this.active.set(sessionID, generation);
    return generation;
  }

  /** Session's current turn handles (bounded; diagnostics + error hints). */
  listSession(sessionID, cap = 16) {
    const generation = this.active.get(sessionID);
    if (!generation) return [];
    const out = [];
    for (const [handle, meta] of generation.byHandle) {
      out.push({ handle, kind: meta.kind });
      if (out.length >= cap) break;
    }
    return out;
  }

  /**
   * Register a freshly created durable ref from a write tool call (S3):
   * the model's own write returns carry a current-generation handle, so the
   * model never needs to copy the canonical ref back. Notes, claims,
   * milestones and handoffs present as n#; blobs as b#; other events as e#.
   */
  registerCreated(sessionID, ref, kind = 'event') {
    const generation = this.active.get(sessionID);
    if (!generation || typeof ref !== 'string' || !refPattern.test(ref)) return null;
    if (generation.byRef.has(ref)) return { handle: generation.byRef.get(ref), ref, existing: true };
    if (generation.byHandle.size >= GENERATION_CAP) return null;
    const prefix = kind === 'blob' ? 'b' : kind === 'note' ? 'n' : 'e';
    generation.next[prefix] = (generation.next[prefix] ?? 0) + 1;
    const handle = `${prefix}${generation.next[prefix]}`;
    generation.byHandle.set(handle, { ref, kind: prefix === 'b' ? 'blob' : prefix === 'n' ? 'note' : 'event', label: 'created this turn' });
    generation.byRef.set(ref, handle);
    return { handle, ref };
  }

  /**
   * Discovery handles for refs returned by tools during the current turn
   * (trace_find results, trace_expand related refs). Refs already mapped in
   * this generation keep their existing handle; ordinals continue after the
   * snapshot assignment so the mapping stays collision-free and deterministic
   * given the call sequence.
   */
  register(sessionID, refs = []) {
    const generation = this.active.get(sessionID);
    if (!generation) return [];
    const registered = [];
    for (const ref of refs) {
      if (typeof ref !== 'string' || !refPattern.test(ref) || generation.byRef.has(ref)) continue;
      if (generation.byHandle.size >= GENERATION_CAP || registered.length >= REGISTRATION_CAP) break;
      const prefix = ref.startsWith('blob_') ? 'b' : 'e';
      generation.next[prefix] = (generation.next[prefix] ?? 0) + 1;
      const handle = `${prefix}${generation.next[prefix]}`;
      generation.byHandle.set(handle, { ref, kind: prefix === 'b' ? 'blob' : 'event', label: 'discovered' });
      generation.byRef.set(ref, handle);
      registered.push({ handle, ref });
    }
    return registered;
  }

  handleFor(sessionID, ref) {
    return this.active.get(sessionID)?.byRef.get(ref) ?? null;
  }

  /**
   * Exact-match resolution. Reasons:
   *   expired         - handle existed in this session's previous generation
   *   foreign_session - handle exists in another session's active generation
   *   unknown         - not in this session's current or previous mapping
   */
  resolve(sessionID, handle) {
    const active = this.active.get(sessionID);
    const hit = active?.byHandle.get(handle);
    if (hit) return { ok: true, ref: hit.ref, kind: hit.kind, label: hit.label, handle };
    if (this.retired.get(sessionID)?.byHandle.has(handle)) return { ok: false, reason: 'expired' };
    for (const [peerID, generation] of this.active) {
      if (peerID !== sessionID && generation.byHandle.has(handle)) return { ok: false, reason: 'foreign_session' };
    }
    return { ok: false, reason: 'unknown' };
  }

  describe() {
    let handles = 0;
    for (const generation of this.active.values()) handles += generation.byHandle.size;
    return { active_generations: this.active.size, retired_generations: this.retired.size, active_handles: handles };
  }
}
