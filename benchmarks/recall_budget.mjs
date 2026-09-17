// Read-only census and paired end-state replay. Never initializes a live Store.
// Usage: node benchmarks/recall_budget.mjs STORE_ROOT BEFORE_PACKAGE OUTPUT_DIR
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Trace } from '../src/trace.js';
import { Store } from '../src/store.js';
import { definitions } from '../src/tools.js';
import { hash, stable } from '../src/util.js';

const [root, beforePath, output] = process.argv.slice(2).map(p => path.resolve(p));
const { Trace: Before } = await import(pathToFileURL(path.join(beforePath, 'src/trace.js')));
const { definitions: beforeDefinitions } = await import(pathToFileURL(path.join(beforePath, 'src/tools.js')));
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : stable(value));
const stats = values => {
  const sorted = values.toSorted((a, b) => a - b);
  return { count: sorted.length, total: sorted.reduce((a, b) => a + b, 0),
    mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0,
    median: sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 : 0,
    min: sorted[0] ?? 0, max: sorted.at(-1) ?? 0 };
};
const parse = text => JSON.parse(text.split('\n')[2]);
const census = { events: 0, checkpoints: 0, applied: 0, prepared_without_applied: 0, notes: 0, superseding_notes: 0 };
const noteSessions = new Set(), appliedSessions = new Set(), checkpointSessions = new Set(), manifest = [], snapshots = [], pairs = [], appliedBytes = [], preparedBytes = [];
const appliedPerSession = new Map();
for (const workspaceID of (await fs.readdir(path.join(root, 'workspaces'))).sort()) {
  const directory = path.join(root, 'workspaces', workspaceID);
  const names = (await fs.readdir(path.join(directory, 'events'))).filter(n => /^evt_[a-f0-9]{64}\.json$/.test(n)).sort();
  const events = [];
  for (const name of names) events.push(JSON.parse(await fs.readFile(path.join(directory, 'events', name), 'utf8')));
  events.sort((a, b) => a.at - b.at || a.ref.localeCompare(b.ref));
  manifest.push({ workspaceID, event_refs: events.map(e => e.ref) });
  const payload = async event => {
    const digest = event.payload.ref.slice(5);
    const raw = await fs.readFile(path.join(directory, 'blobs', digest.slice(0, 2), digest));
    if (hash(raw) !== digest) throw new Error('Payload hash mismatch');
    return JSON.parse(raw);
  };
  const appliedRefs = new Set();
  const store = new Store(workspaceID, root); // No init/watch/write.
  store.root = directory; store.workspaceID = workspaceID;
  store.watcherState = { mode: 'read_only_replay', error: null };
  for (const event of events) {
    census.events++;
    const hostCreated = event.type === 'compaction' && event.compact?.host_created_at === undefined
      ? (await payload(event)).time?.created ?? null : event.compact?.host_created_at;
    store.reduce(event, hostCreated);
    store.index.set(event.ref, { ref: event.ref, type: event.type, sessionID: event.host?.sessionID, at: event.at });
    if (event.type === 'trace.note') {
      census.notes++; noteSessions.add(`${workspaceID}/${event.host.sessionID}`);
      if (event.note?.supersedes?.length) census.superseding_notes++;
    }
    if (event.type === 'context.checkpoint') {
      census.checkpoints++; checkpointSessions.add(`${workspaceID}/${event.host.sessionID}`);
      preparedBytes.push(event.recallBytes ?? bytes((await payload(event)).recall ?? ''));
    }
    if (event.type === 'context.applied') {
      const data = await payload(event), key = `${workspaceID}/${event.host.sessionID}`;
      census.applied++; appliedRefs.add(data.checkpoint); appliedSessions.add(key); appliedBytes.push(data.recallBytes);
      appliedPerSession.set(key, (appliedPerSession.get(key) ?? 0) + data.recallBytes);
    }
  }
  census.prepared_without_applied += events.filter(e => e.type === 'context.checkpoint' && !appliedRefs.has(e.ref)).length;
  for (const name of (await fs.readdir(path.join(directory, 'recall'))).filter(n => n.endsWith('.json'))) {
    const snapshot = JSON.parse(await fs.readFile(path.join(directory, 'recall', name), 'utf8'));
    const view = parse(snapshot.text);
    snapshots.push({ bytes: bytes(snapshot.text), peers: bytes(view.peers ?? []), static: bytes(snapshot.text) - bytes(view) });
    store.workspace = view.workspace ?? store.workspace;
  }
  const fake = Class => Object.assign(Object.create(Class.prototype), { store, options: {}, errors: 0, droppedObservations: 0 });
  const before = fake(Before), after = fake(Trace);
  for (const sessionID of [...store.sessions.keys()]) {
    const oldText = before.recall(sessionID), newText = after.recall(sessionID), oldView = parse(oldText), newView = parse(newText);
    const lostOwnRefs = ['notes', 'unresolved'].flatMap(k => (oldView[k] ?? []).filter(n => !(newView[k] ?? []).some(m => m.ref === n.ref)).map(n => n.ref));
    if (lostOwnRefs.length) throw new Error('Candidate lost previously visible own notes');
    if (bytes(newText) > 12288) throw new Error('Recall exceeded ceiling');
    pairs.push({ workspaceID, sessionID, before: bytes(oldText), after: bytes(newText),
      before_truncated: oldView.recall_truncated === true, after_truncated: newView.recall_truncated === true,
      own_notes_before: (oldView.notes?.length ?? 0) + (oldView.unresolved?.length ?? 0),
      own_notes_after: (newView.notes?.length ?? 0) + (newView.unresolved?.length ?? 0),
      peers_before: bytes(oldView.peers ?? []), peers_after: bytes(newView.peers ?? []),
      static_before: bytes(oldText) - bytes(oldView), static_after: bytes(newText) - bytes(newView) });
  }
}
const surface = defs => bytes(defs({}).map(({ name, description, input }) => ({ name, description, input })));
const measuredPairs = pairs.filter(p => checkpointSessions.has(`${p.workspaceID}/${p.sessionID}`));
const report = { measured_at: new Date().toISOString(), census: { ...census, note_sessions: noteSessions.size, applied_sessions: appliedSessions.size, checkpoint_sessions: checkpointSessions.size, all_observed_sessions: pairs.length },
  historical: { hook_applied_bytes: stats(appliedBytes), prepared_bytes: stats(preparedBytes), applied_bytes_per_session: stats([...appliedPerSession.values()]), latest_snapshot_bytes: stats(snapshots.map(s => s.bytes)) },
  paired_end_state_replay: Object.fromEntries(['before', 'after', 'peers_before', 'peers_after', 'static_before', 'static_after'].map(k => [k, stats(measuredPairs.map(p => p[k]))])),
  tool_surface: { count: definitions({}).length, before_bytes: surface(beforeDefinitions), after_bytes: surface(definitions), measurement: 'JSON name/description/input; excludes host framing, inline review and tokenizer costs' },
  limitations: ['Hook applied is not proof of model consumption or billing.', 'Prepared bytes are separate and must not be added to applied bytes.', 'Paired replay renders identical final event state, not counterfactual historical prompts or model-quality acceptance.', 'Live event lists are captured per workspace; concurrent writes after each listing are excluded.'] };
await fs.mkdir(output, { recursive: true, mode: 0o700 });
await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
await fs.writeFile(path.join(output, 'pairs.json'), JSON.stringify(pairs, null, 2), { mode: 0o600 });
await fs.writeFile(path.join(output, 'measurements.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
