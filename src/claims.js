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
// - A structured receipt supplied by a model is also CLAIMED. Neither its
//   shape nor matching CAS bytes establish host execution or candidate scope.
//   This ingress has no host-attestation authority and never emits
//   VERIFIED_MECHANICAL or CONTRADICTED from an unauthenticated receipt.
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
 * Retain a submitted receipt without upgrading its source authority. This
 * function is reached by model tool arguments, not a host execution ledger.
 * A well-formed chk_ value is a label, not a signature. Outcome is explicitly
 * reported rather than verified, including negative/timeout assertions.
 */
export function claimFromReceipt({ subject, scope, receipt, supersedes = [] }) {
  const r = validateReceipt(receipt);
  const passed = r.commandExitCode === 0 && !r.timedOut;
  return {
    subject: String(subject ?? '').trim(),
    status: 'CLAIMED',
    scope: String(scope ?? 'mechanical_check'),
    evidence: { kind: 'check_receipt', receipt: r, authenticity: 'unverified',
      reported_outcome: passed ? 'success' : 'failure' },
    meaning: `Submitted CheckReceipt ${r.checkID} reports kind=${r.kind}, command_exit_code=${r.commandExitCode}`
      + `${r.timedOut ? ', timed out' : ''}${r.signal !== 'none' ? `, signal=${r.signal}` : ''}`
      + ` for candidate ${r.candidate.commit.slice(0, 12)}. Receipt authenticity is NOT established by this record. `
      + 'Matching output bytes verify content identity only; audit the checkID against actual host execution records. '
      + 'This is a structured model claim, never mechanical verification or implementation correctness.',
    supersedes: (Array.isArray(supersedes) ? supersedes : []).filter(r2 => typeof r2 === 'string' && refPattern.test(r2)),
    review_effect: 'none',
    semantics,
  };
}

/** Older canonical claims remain immutable; readers must not inherit the old
 * schema's execution-authority upgrade for model-submitted receipts. */
export function effectiveClaimStatus(payload) {
  if (payload?.evidence?.kind === 'check_receipt') return 'CLAIMED';
  return payload?.claim_status ?? payload?.status ?? 'UNKNOWN';
}

export function reportedReceiptFailure(payload) {
  const receipt = payload?.evidence?.kind === 'check_receipt' ? payload.evidence.receipt : null;
  return receipt && (receipt.commandExitCode !== 0 || receipt.timedOut === true);
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
