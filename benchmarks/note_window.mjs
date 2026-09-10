// Show the difference between durable retention and automatic discoverability.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Trace } from '../src/trace.js';

const root = path.resolve(process.argv[2]);
await fs.mkdir(root, { recursive: true, mode: 0o700 });
if (await fs.stat(path.join(root, 'store')).catch(() => null)) throw new Error('Use an empty output directory');
const trace = new Trace({ location: { directory: path.join(root, 'workspace') } }, { storeRoot: path.join(root, 'store') });
await trace.ready;
try {
  const host = i => ({ sessionID: 'note-window-session', messageID: `m${i}`, id: `c${i}`, agent: 'build' });
  const old = await trace.note({ kind: 'unresolved', text: 'UNRESOLVED_ANCHOR_738291', source_refs: [] }, host(0));
  for (let i = 1; i <= 80; i++) await trace.note({ kind: 'finding', text: `Later finding ${i}`, source_refs: [] }, host(i));
  const status = trace.projection('note-window-session');
  const result = { total_saved_notes: 81, projection_note_window: trace.store.session('note-window-session').notes.length,
    old_unresolved_in_status: status.unresolved.some(n => n.ref === old.ref),
    old_unresolved_in_recall: trace.recall('note-window-session').includes(old.ref),
    old_ref_still_expandable: (await trace.store.expand(old.ref)).exact_utf8.includes('UNRESOLVED_ANCHOR_738291'), old_ref: old.ref };
  await fs.writeFile(path.join(root, 'note-window-results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { trace.store.close(); }
