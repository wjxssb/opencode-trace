import { messageID, unwrap, bytes } from './util.js';

export const MAP_START = '<opencode-trace-map-v1>';
export const MAP_END = '</opencode-trace-map-v1>';
const fields = ['current_refs', 'unresolved_refs', 'important_refs', 'recent_refs', 'retrieve_if_needed', 'supersedes', 'depends_on'];

export const compactGuidance = `During native compaction, keep OpenCode's normal human summary. You may append ${MAP_START}{"current_refs":[],"unresolved_refs":[],"important_refs":[],"recent_refs":[],"retrieve_if_needed":[],"supersedes":[],"depends_on":[]}${MAP_END}. Use only existing trace evt_/blob_ refs, at most 8 per field and 4096 bytes total. Never invent refs. Missing or invalid maps only reduce trace recovery; native compaction proceeds normally.`;

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

export async function saveCompact(store, sid, row) {
  let map = null, gap = null;
  try { map = await parseMap(row.summary, store); }
  catch (error) { gap = error instanceof SyntaxError ? 'invalid_json' : error.code === 'ENOENT' ? 'missing_ref' : error.message; }
  const refs = [...new Set(Object.values(map ?? {}).flat())];
  const event = await store.record('compaction', { sessionID: sid, messageID: row.id }, row, { compact: { map, refs, recovery_gap: gap } });
  if (gap) await store.record('recovery_gap', { sessionID: sid, messageID: row.id }, { reason: gap, source_ref: event.ref });
  return event;
}
