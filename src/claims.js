// Phase F: typed provenance — durable claim records with a conservative
// status taxonomy (directive §24-29).
//
// Trust hierarchy:
//   host CheckReceipt   = mechanical execution evidence (host-measured)
//   Reviewer prose      = interpretation
//   Trace typed claim   = durable provenance projection
//
// Hard rules:
// - Status taxonomy is exactly: CLAIMED | SUPPORTED | VERIFIED_MECHANICAL |
//   CONTRADICTED | UNKNOWN. Nothing else is a valid status.
// - PROSE CAN ONLY EVER PRODUCE CLAIMED. Any text — including text shaped
//   like a receipt ("tests passed", fake JSON) — is a model assertion, never
//   mechanical verification (F1/F4).
// - VERIFIED_MECHANICAL is NARROW: a structurally complete host receipt
//   (checkID, kind, mechanical status, command exit code, timeout/signal,
//   candidate binding, output hashes) was bound to the claim. It means "this
//   command, in this candidate, with this output hash, exited this way" —
//   NEVER "the implementation is correct" (F2).
// - A receipt whose command exit code is nonzero (or which timed out) cannot
//   support a success claim; it CONTRADICTS it (F3).
// - Receipts bind to ONE candidate identity. A candidate-A receipt stays
//   valid historical evidence for A and can never mechanically justify a
//   candidate B (F5) — staleness is computed against the current candidate
//   at read time and is a separate dimension from the immutable status.
// - Claim status and capture coverage are independent dimensions: a command
//   can be VERIFIED_MECHANICAL while capture coverage is incomplete; both
//   are represented honestly and neither upgrades the other (F8).
// - Typed claims never approve reviews, never clear review obligations, and
//   never override needs_context or stale protection (F9/F10).
// - Claims are immutable CAS events; a superseding claim records `supersedes`
//   refs while the superseded evidence history remains fully retrievable
//   (F12).

import { refPattern } from './util.js';

export const CLAIM_STATUSES = Object.freeze([
  'CLAIMED', 'SUPPORTED', 'VERIFIED_MECHANICAL', 'CONTRADICTED', 'UNKNOWN',
]);

export const CHECK_ID_PATTERN = /^chk_[0-9a-f]{16,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Structural validation for a host CheckReceipt. Throws TypeError on any
 * missing/malformed field — the binding path is strict by design. Returns a
 * normalized receipt snapshot safe to persist.
 */
export function validateReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new TypeError('receipt must be a structured CheckReceipt object (prose can never bind)');
  }
  const { checkID, kind, status, commandExitCode, timedOut, signal, candidate, output } = receipt;
  if (typeof checkID !== 'string' || !CHECK_ID_PATTERN.test(checkID)) {
    throw new TypeError('receipt.checkID must match chk_<hex>');
  }
  if (typeof kind !== 'string' || !kind.trim()) throw new TypeError('receipt.kind is required');
  if (typeof status !== 'string' || !status.trim()) throw new TypeError('receipt.status is required');
  if (!Number.isInteger(commandExitCode) || commandExitCode < 0 || commandExitCode > 255) {
    throw new TypeError('receipt.commandExitCode must be an integer 0..255');
  }
  if (typeof timedOut !== 'boolean') throw new TypeError('receipt.timedOut must be boolean');
  if (typeof signal !== 'string' || !signal.trim()) throw new TypeError('receipt.signal is required ("none" when absent)');
  if (!candidate || typeof candidate !== 'object' || typeof candidate.commit !== 'string' || !HEX64.test(candidate.commit)) {
    throw new TypeError('receipt.candidate.commit must be a 64-hex candidate identity');
  }
  if (!output || typeof output !== 'object' || typeof output.sha256 !== 'string' || !HEX64.test(output.sha256)) {
    throw new TypeError('receipt.output.sha256 must be the 64-hex hash of the raw command output');
  }
  if (output.ref != null && (typeof output.ref !== 'string' || !refPattern.test(output.ref))) {
    throw new TypeError('receipt.output.ref must be a canonical evt_<64hex>/blob_<64hex> ref');
  }
  return {
    checkID, kind, status, commandExitCode, timedOut,
    signal: signal === 'none' ? 'none' : signal,
    candidate: { commit: candidate.commit, ...(typeof candidate.branch === 'string' ? { branch: candidate.branch } : {}) },
    output: {
      sha256: output.sha256,
      ...(output.ref != null ? { ref: output.ref } : {}),
      ...(Number.isInteger(output.bytes) ? { bytes: output.bytes } : {}),
    },
    ...(Number.isInteger(receipt.durationMs) ? { durationMs: receipt.durationMs } : {}),
  };
}

const semantics = 'typed provenance projection; statuses CLAIMED|SUPPORTED|VERIFIED_MECHANICAL|CONTRADICTED|UNKNOWN; '
  + 'VERIFIED_MECHANICAL is host-measured command evidence only (narrow scope), never implementation correctness; '
  + 'claims never approve reviews or clear review obligations';

/**
 * A model/prose assertion. ALWAYS CLAIMED (F1/F4): text can cite refs, but
 * cited refs only ride along as provenance pointers — they never upgrade the
 * status (absence of a receipt stays visible; SUPPORTED is reserved for
 * host-attested corroboration paths, not model wording).
 */
export function claimFromProse({ subject, text, refs = [], supersedes = [] }) {
  return {
    subject: String(subject ?? '').trim(),
    status: 'CLAIMED',
    evidence: {
      kind: 'model_prose',
      text: String(text ?? ''),
      source_refs: (Array.isArray(refs) ? refs : []).filter(r => typeof r === 'string' && refPattern.test(r)),
    },
    meaning: 'model assertion (declaration); never mechanical verification — absence of a host receipt stays visible',
    supersedes: (Array.isArray(supersedes) ? supersedes : []).filter(r => typeof r === 'string' && refPattern.test(r)),
    review_effect: 'none',
    semantics,
  };
}

/**
 * Bind a structurally complete host CheckReceipt to a narrow claim.
 * - receipt reports exit 0 without timeout -> VERIFIED_MECHANICAL for the
 *   narrow `scope` (e.g. 'test_command_completed'), never implementation
 *   correctness.
 * - receipt reports a nonzero exit or a timeout -> the success claim is
 *   CONTRADICTED (F3): the mechanical evidence and the prose disagree, and
 *   the mechanical evidence wins for the narrow dimension while the
 *   contradiction stays visible.
 */
export function claimFromReceipt({ subject, scope, receipt, supersedes = [] }) {
  const r = validateReceipt(receipt);
  const passed = r.commandExitCode === 0 && !r.timedOut;
  return {
    subject: String(subject ?? '').trim(),
    status: passed ? 'VERIFIED_MECHANICAL' : 'CONTRADICTED',
    scope: String(scope ?? 'mechanical_check'),
    evidence: { kind: 'check_receipt', receipt: r },
    meaning: passed
      ? `host-measured only: receipt ${r.checkID} reports kind=${r.kind} command_exit_code=0 under candidate `
        + `${r.candidate.commit.slice(0, 12)} (output sha256 ${r.output.sha256.slice(0, 12)}). Narrow mechanical `
        + 'execution evidence for scope "' + r.kind + '" — never implementation correctness.'
      : `receipt ${r.checkID} contradicts the claimed success: command_exit_code=${r.commandExitCode}`
        + `${r.timedOut ? ', timed out' : ''}${r.signal !== 'none' ? `, signal=${r.signal}` : ''}. `
        + 'The prose claim and the mechanical evidence disagree; the contradiction stays visible.',
    supersedes: (Array.isArray(supersedes) ? supersedes : []).filter(r2 => typeof r2 === 'string' && refPattern.test(r2)),
    review_effect: 'none',
    semantics,
  };
}

/**
 * Candidate staleness (F5): a receipt bound to candidate A remains valid
 * HISTORICAL evidence for A and must never mechanically justify candidate B.
 * Returns { stale, applies_to, current } — the persisted status is never
 * rewritten; staleness is a read-time projection.
 */
export function claimStaleness(claim, currentCandidate) {
  const appliesTo = claim?.evidence?.receipt?.candidate ?? null;
  const current = currentCandidate?.commit ??
    (typeof currentCandidate === 'string' ? currentCandidate : null);
  if (!appliesTo?.commit || !current) return { stale: false, applies_to: appliesTo, current: current ?? null };
  return { stale: appliesTo.commit !== current, applies_to: appliesTo, current };
}
