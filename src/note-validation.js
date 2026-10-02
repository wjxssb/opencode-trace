// Validate before normalization so malformed fields cannot silently disappear.
const textLimits = {
  summary: 2048, what_changed: 2048, why_it_matters: 2048, current_state: 1024,
  decision: 2048, next_action: 2048, to_session: 256, to_worker: 256,
  task_ref: 256, handoff_id: 256, continuation_of: 256,
};
const lists = ['evidence_refs', 'supersedes', 'depends_on', 'unresolved', 'do_not_repeat'];
const topFields = new Set(['kind', 'text', 'summary', 'source_refs', 'supersedes', 'depends_on', 'milestone']);
export function validateNoteInput(input) {
  for (const key of Object.keys(input)) {
    if (!topFields.has(key)) throw new Error(`trace_note: unknown field ${key}; use text for the note body`);
  }
  if (!Object.hasOwn(input, 'milestone')) return;
  const ms = input.milestone;
  if (!ms || typeof ms !== 'object' || Array.isArray(ms)) throw new Error('trace_note: milestone must be an object');
  const allowed = new Set(['kind', ...Object.keys(textLimits), ...lists]);
  for (const key of Object.keys(ms)) {
    if (!allowed.has(key)) throw new Error(`trace_note: unknown milestone field ${key}`);
  }
  for (const [key, max] of Object.entries(textLimits)) {
    if (!Object.hasOwn(ms, key)) continue;
    if (typeof ms[key] !== 'string') throw new Error(`trace_note: milestone.${key} must be a string`);
    if ([...ms[key]].length > max) throw new Error(`trace_note: milestone.${key} exceeds ${max} Unicode characters`);
  }
  for (const key of lists) {
    if (!Object.hasOwn(ms, key)) continue;
    if (!Array.isArray(ms[key]) || ms[key].length > 16 || ms[key].some(x => typeof x !== 'string')) {
      throw new Error(`trace_note: milestone.${key} must be an array of up to 16 strings`);
    }
    if (key === 'do_not_repeat' && ms[key].some(x => [...x].length > 256)) {
      throw new Error('trace_note: milestone.do_not_repeat items exceed 256 Unicode characters');
    }
  }
}

export function isAffirmativeState(state) {
  const words = String(state ?? '').replace(/_/g, ' ');
  return /\b(verified|pass|passed)\b/i.test(words)
    && !/\b(unverified|not|no|never|fail(?:ed|ure|ing)?|blocked|pending|unknown|unconfirmed|claimed|partial|unproven)\b/i.test(words);
}

// Host completion is transport completion, not necessarily command success.
// Only inspect result envelopes; arbitrary text remains evidence for the worker
// to interpret rather than a source of synthetic success.
export function hasExplicitFailure(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.error || value.isError === true || value.ok === false) return true;
  if (['failed', 'failure', 'error', 'timeout', 'timed_out', 'killed', 'cancelled', 'canceled'].includes(String(value.status ?? '').toLowerCase())) return true;
  if ([value.exit, value.exitCode, value.exit_code].some(code =>
    (typeof code === 'number' || (typeof code === 'string' && /^-?\d+$/.test(code))) && Number(code) !== 0)) return true;
  return ['result', 'metadata', 'output', 'raw', 'structuredContent'].some(key => hasExplicitFailure(value[key]));
}
