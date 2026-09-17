import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Trace } from '../src/trace.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-recall-budget-'));
  const trace = new Trace({ location: { directory: dir } }, { storeRoot: path.join(dir, 'store') });
  await trace.ready;
  t.after(async () => { trace.store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return trace;
}
const parse = text => JSON.parse(text.split('\n')[2]);

test('compact peer recall preserves own memory and current peer refs; full provenance remains retrievable', async t => {
  const trace = await fixture(t);
  const own = await trace.note({ kind: 'unresolved', text: 'Own blocker and next action', source_refs: [] }, { sessionID: 'worker' });
  const old = await trace.note({ kind: 'unresolved', text: 'PEER_PRIVATE_PROSE', source_refs: [] }, { sessionID: 'peer' });
  const replacement = await trace.note({ kind: 'correction', text: 'Verified resolution', source_refs: [old.ref], supersedes: [old.ref] }, { sessionID: 'peer' });
  await trace.intent({ summary: 'PEER_INTENT_PROSE', paths: ['file.txt'], resources: ['gpu'], status: 'active' }, { sessionID: 'peer' });
  const text = trace.recall('worker'), view = parse(text), peer = view.peers[0];
  assert.ok(view.unresolved.some(n => n.ref === own.ref && n.text === 'Own blocker and next action'));
  assert.deepEqual(peer.note_refs, [replacement.ref]);
  assert.ok(peer.intent.paths.some(p => p.endsWith('file.txt')));
  assert.ok(!text.includes('PEER_PRIVATE_PROSE') && !text.includes('PEER_INTENT_PROSE'));
  assert.equal(peer.note_history, undefined);
  const full = trace.projection('worker').peers[0];
  assert.ok(full.note_history.superseded_refs.includes(old.ref));
  assert.ok((await trace.store.expand(old.ref, 0, 24000)).exact_utf8.includes('PEER_PRIVATE_PROSE'));
  assert.ok(Buffer.byteLength(JSON.stringify(peer)) < Buffer.byteLength(JSON.stringify(full)) / 2);
});

test('byte-trimmed peer page resumes at the first omitted peer without skipping peers', async t => {
  const trace = await fixture(t);
  trace.options.recallBytes = 8192;
  for (let i = 0; i < 12; i++) await trace.store.record('session.lifecycle', { sessionID: `peer-${i}` }, {}, { lifecycle: 'observed' });
  await trace.note({ kind: 'unresolved', text: 'x'.repeat(4096), source_refs: [] }, { sessionID: 'worker' });
  // Increase own memory until the first peer page must be reduced by the cap.
  let view;
  for (let length = 100; length <= 1800; length += 100) {
    trace.store.session('worker').notes[0].text = 'x'.repeat(4096 + length);
    view = parse(trace.recall('worker'));
    if (view.peers.length < 8) break;
  }
  assert.ok(view.peers.length < 8);
  assert.equal(view.peer_next_offset, view.peers.length);
  const all = trace.projection('worker', 0, 64).peers.map(p => p.sessionID);
  const next = trace.projection('worker', view.peer_next_offset, 64).peers.map(p => p.sessionID);
  assert.deepEqual([...view.peers.map(p => p.sessionID), ...next], all);
  assert.ok(Buffer.byteLength(trace.recall('worker')) <= 8192);
});

test('coverage reports incomplete when an oversized unresolved note is reduced to a ref', async t => {
  const trace = await fixture(t);
  const note = await trace.note({ kind: 'unresolved', text: 'blocker', source_refs: [] }, { sessionID: 'worker' });
  // Defensive replay of historical data larger than the current tool limit.
  trace.store.session('worker').notes[0].text = '中'.repeat(10000);
  const view = parse(trace.recall('worker'));
  assert.equal(view.unresolved[0].ref, note.ref);
  assert.equal(view.unresolved[0].omitted, true);
  assert.equal(view.coverage.notes_complete, false);
  assert.equal(view.coverage.unresolved_shown, 1);
});
