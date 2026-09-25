import { messageID, unwrap, bytes, refPattern } from './util.js';

export const MAP_START = '<opencode-trace-map-v1>';
export const MAP_END = '</opencode-trace-map-v1>';
const fields = ['current_refs', 'unresolved_refs', 'important_refs', 'recent_refs', 'retrieve_if_needed', 'supersedes', 'depends_on'];

export const compactGuidance = `Compaction: keep the native summary; optionally append ${MAP_START}{"current_refs":[],"unresolved_refs":[],"important_refs":[],"recent_refs":[],"retrieve_if_needed":[],"supersedes":[],"depends_on":[]}${MAP_END}. Existing evt_/blob_ refs only; <=8/field, <=4096 bytes. Invalid/missing maps reduce recovery only.`;

export async function parseMap(summary, store) {
  const start = summary.indexOf(MAP_START), end = summary.indexOf(MAP_END, start + MAP_START.length);
  if (start < 0 || end < 0) throw new Error('missing_map');
  if (summary.indexOf(MAP_START, start + MAP_START.length) >= 0) throw new Error('multiple_maps');
  const raw = summary.slice(start + MAP_START.length, end);
  if (bytes(raw) > 4096) throw new Error('map_too_large');
  const map = JSON.parse(raw);
  if (!map || Array.isArray(map) || typeof map !== 'object' || Object.keys(map).some(k => !fields.includes(k))) throw new Error('invalid_map_schema');
  for (const [key, refs] of Object.entries(map)) {
    if (!Array.isArray(refs) || refs.length > 8 || refs.some(r => typeof r !== 'string')) throw new Error('invalid_map_refs');
    for (const ref of refs) await store.exists(ref);
  }
  return map;
}

export function compactions(messages) {
  return (unwrap(messages) ?? []).flatMap(m => {
    const v = [m, m?.info, m?.data, m?.message].find(x => x?.type === 'compaction');
    return v?.status === 'completed' && typeof v.summary === 'string' && messageID(v) ? [{ ...v, id: messageID(v) }] : [];
  });
}

/**
 * The native summarizer never sees the Trace recall frame (runtime context is
 * primary-request only), so a model-authored map is optional. The fact layer
 * binds the summary to its own evidence instead: the session's intent,
 * unsuperseded notes and latest tool results observed up to the compaction.
 */
export function structuralMap(store, sid, cutoff) {
  const s = store.session(sid);
  const upTo = item => typeof item?.ref === 'string' && refPattern.test(item.ref) && (!Number.isFinite(cutoff) || (item.at ?? 0) <= cutoff);
  const superseded = new Set((s.notes ?? []).flatMap(n => (n.supersedes ?? []).concat(n.milestone?.supersedes ?? [])));
  const notes = (s.notes ?? []).filter(n => upTo(n) && !superseded.has(n.ref));
  const map = {
    current_refs: upTo(s.intent) ? [s.intent.ref] : [],
    unresolved_refs: notes.filter(n => n.kind === 'unresolved').slice(-8).map(n => n.ref),
    important_refs: notes.filter(n => n.kind !== 'unresolved').slice(-8).map(n => n.ref),
    recent_refs: (s.recentTools ?? []).filter(upTo).slice(-8).map(e => e.ref),
  };
  return Object.values(map).some(refs => refs.length) ? map : null;
}

export async function saveCompact(store, sid, row) {
  let map = null, modelGap = null;
  try { map = await parseMap(row.summary, store); }
  catch (error) { modelGap = error instanceof SyntaxError ? 'invalid_json' : error.code === 'ENOENT' ? 'missing_ref' : error.message; }
  const hostCreated = Number.isFinite(row.time?.created) ? row.time.created : null;
  let source = map ? 'model' : null;
  if (!map) { map = structuralMap(store, sid, hostCreated ?? undefined); if (map) source = 'structural'; }
  // A gap now means neither the summary nor Trace's own facts could bind this compaction.
  const gap = map ? null : modelGap ?? 'no_evidence';
  const refs = [...new Set(Object.values(map ?? {}).flat())];
  const event = await store.record('compaction', { sessionID: sid, messageID: row.id }, row,
    { compact: { map, refs, map_source: source, model_map_gap: modelGap, recovery_gap: gap, host_created_at: hostCreated } });
  if (gap) await store.record('recovery_gap', { sessionID: sid, messageID: row.id }, { reason: gap, source_ref: event.ref });
  return event;
}
