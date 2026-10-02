// Validate before normalization so malformed fields cannot silently disappear.
const textLimits = {
  summary: 2048, what_changed: 2048, why_it_matters: 2048, current_state: 1024,
  decision: 2048, next_action: 2048, to_session: 256, to_worker: 256,
  task_ref: 256, handoff_id: 256, continuation_of: 256,
};
const lists = ['evidence_refs', 'supersedes', 'depends_on', 'unresolved', 'do_not_repeat'];
const topFields = new Set(['kind', 'text', 'summary', 'source_refs', 'supersedes', 'depends_on', 'milestone']);

/** Note kind -> the milestone kind it stands for, and back. One table for note() and coerce. */
export const MILESTONE_KIND_FOR_NOTE = {
  fact: 'baseline', finding: 'state_change', decision: 'decision', unresolved: 'blocker', correction: 'correction', handoff: 'handoff',
};
export const NOTE_KIND_FOR_MILESTONE = {
  decision: 'decision', state_change: 'finding', verification: 'finding', blocker: 'unresolved', correction: 'correction', handoff: 'handoff', baseline: 'fact',
};
const isNoteKind = kind => typeof kind === 'string' && Object.hasOwn(MILESTONE_KIND_FOR_NOTE, kind);
const isMilestoneKind = kind => typeof kind === 'string' && Object.hasOwn(NOTE_KIND_FOR_MILESTONE, kind);
const line = (key, value) => `${key}: ${value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value).trim()}`;
const present = value => value !== undefined && value !== null && String(value).trim() !== '';

/**
 * trace_note's coerce, the host's pre-validation repair (Claude Code's coerceInput). The host
 * validates trace_note against its schema, which rejects unknown kinds and silently strips
 * unknown fields, so the shapes note() has always accepted from models are repaired here first:
 * kind mix-ups map through the tables above, and unknown fields become `key: value` lines of the
 * text instead of disappearing. `fields`/`milestoneFields` are the schema's property names.
 * Returns null when nothing applies; never mutates `raw` (host tool-call state is frozen).
 */
export function coerceNoteInput(raw, fields, milestoneFields) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = { ...raw }, repairs = [], notes = [], lines = [];
  const ms = input.milestone && typeof input.milestone === 'object' && !Array.isArray(input.milestone) ? { ...input.milestone } : null;
  if (input.kind === 'milestone' && ms) { delete input.kind; repairs.push('kind_milestone_dropped'); }
  if (isMilestoneKind(input.kind) && !isNoteKind(input.kind)) {
    notes.push(`kind "${input.kind}" is a milestone kind, saved as note kind "${NOTE_KIND_FOR_MILESTONE[input.kind]}"`);
    input.kind = NOTE_KIND_FOR_MILESTONE[input.kind];
    repairs.push('note_kind_from_milestone_kind');
  }
  if (ms) {
    if (ms.kind === undefined && isNoteKind(input.kind)) {
      ms.kind = MILESTONE_KIND_FOR_NOTE[input.kind];
      repairs.push('milestone_kind_from_note_kind');
    } else if (!isMilestoneKind(ms.kind) && isNoteKind(ms.kind)) {
      notes.push(`milestone.kind "${ms.kind}" is a note kind, saved as milestone kind "${MILESTONE_KIND_FOR_NOTE[ms.kind]}"`);
      ms.kind = MILESTONE_KIND_FOR_NOTE[ms.kind];
      repairs.push('milestone_kind_note_alias');
    }
    const extra = Object.keys(ms).filter(key => !milestoneFields.includes(key));
    for (const key of extra) { if (present(ms[key])) lines.push(line(`milestone.${key}`, ms[key])); delete ms[key]; }
    if (extra.length) notes.push(`milestone has no field ${extra.map(k => `\`${k}\``).join(', ')}, kept as text lines`);
    input.milestone = ms;
  }
  const extra = Object.keys(input).filter(key => !fields.includes(key));
  lines.unshift(...extra.filter(key => present(input[key])).map(key => line(key, input[key])));
  for (const key of extra) delete input[key];
  if (extra.length) notes.push(`trace_note has no field ${extra.map(k => `\`${k}\``).join(', ')}, kept as text lines`);
  if (extra.length || lines.length) repairs.push('extra_fields_to_text');
  if (lines.length) {
    const body = typeof input.text === 'string' && input.text.trim() ? input.text
      : typeof input.summary === 'string' && input.summary.trim() ? input.summary : '';
    input.text = body ? `${body}\n${lines.join('\n')}` : lines.join('\n');
  }
  if (!repairs.length) return null;
  return {
    input,
    shapeClass: repairs.join('+'),
    ...(notes.length ? { note: `Note: trace_note input was repaired: ${notes.join('; ')}.` } : {}),
  };
}
/**
 * Extra simple top-level fields (string, number, boolean) become `key: value` lines of the note
 * body instead of failing the whole note: nothing is dropped and no retry is needed. Production
 * 2026-09-28 21:30: a worker's handoff with `status: "waiting"` was rejected and cost a retry on a
 * local model. Objects and arrays are still refused, since a line would not carry them faithfully.
 * Returns a new input (the caller's object is left as it was) and the folded keys.
 */
export function foldExtraFields(input) {
  const extra = Object.keys(input).filter(key => !topFields.has(key));
  if (extra.length === 0) return { input, folded: [] };
  for (const key of extra) {
    const v = input[key];
    // A misspelled note field is a mistake to correct, not extra content to keep.
    const near = [...topFields].find(f => editDistance(f, key) <= 2);
    if (near) throw new Error(`trace_note: unknown field ${key}; did you mean ${near}?`);
    if (v !== null && typeof v === 'object') throw new Error(`trace_note: unknown field ${key}; use text for the note body`);
  }
  const lines = extra.filter(key => input[key] !== undefined && input[key] !== null && String(input[key]).trim() !== '').map(key => `${key}: ${String(input[key]).trim()}`);
  const out = { ...input };
  for (const key of extra) delete out[key];
  if (lines.length) {
    const body = typeof out.text === 'string' && out.text.trim() ? out.text : typeof out.summary === 'string' && out.summary.trim() ? out.summary : '';
    out.text = body ? `${body}\n${lines.join('\n')}` : lines.join('\n');
  }
  return { input: out, folded: extra };
}

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

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
