import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Trace } from '../src/trace.js';
import { stable, hash, atomic, callKey } from '../src/util.js';
import plugin from '../src/index.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-trace-regression-'));
  const trace = new Trace({ location: { directory: dir } }, { storeRoot: path.join(dir, 'store') });
  await trace.ready;
  t.after(async () => { trace.store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, trace, store: trace.store };
}

async function scanEvents(store) {
  const names = (await fs.readdir(path.join(store.root, 'events'))).filter(n => /^evt_[a-f0-9]{64}\.json$/.test(n));
  return Promise.all(names.map(n => store.readEvent(n.slice(0, -5))));
}

// Build a record()-shaped event with a controlled observation time, mirroring
// Store.record body layout so readEvent integrity checks would accept it.
async function craftEvent(store, type, host, payload, at, extra = {}) {
  const blob = await store.blob(payload);
  const body = { schema: 1, workspaceID: store.workspaceID, type, host, payload: blob, ...extra };
  const ref = `evt_${hash(stable(body))}`;
  return { ...body, ref, at };
}

async function craftToolEvent(store, kind, h, at, payloadMarker) {
  const key = callKey(h);
  const extra = kind === 'tool.before'
    ? { tool: h.tool, callID: h.id, callKey: key, source: {}, paths: 'unknown' }
    : { tool: h.tool, callID: h.id, callKey: key, source: {}, status: 'completed', outputs: [] };
  return craftEvent(store, kind, { sessionID: h.sessionID, messageID: h.messageID, id: h.id, agent: h.agent }, { marker: payloadMarker }, at, extra);
}

test('P1a: same message ID with revised completed content keeps every distinct version; identical replay does not duplicate', async t => {
  const { trace, store } = await fixture(t);
  const v1 = { id: 'msg_r1', type: 'assistant', role: 'assistant', time: { created: 1, completed: 2 }, content: [{ type: 'text', text: 'version one' }] };
  const uncompleted = { id: 'msg_r0', type: 'assistant', role: 'assistant', time: { created: 1 }, content: [{ type: 'text', text: 'streaming' }] };
  await trace.observeMessages('s1', [uncompleted]);
  await trace.observeMessages('s1', [v1]);
  await trace.observeMessages('s1', [structuredClone(v1)]);
  // Replay carrying different volatile envelope fields is the same version.
  await trace.observeMessages('s1', [{ ...structuredClone(v1), metadata: { noise: 'volatile' } }]);
  const v2 = { ...structuredClone(v1), content: [{ type: 'text', text: 'version two' }] };
  await trace.observeMessages('s1', [v2]);
  const rows = (await scanEvents(store)).filter(e => e.type === 'message.persisted' && e.host.messageID === 'msg_r1');
  assert.equal(rows.length, 2, 'exactly the two distinct completed versions are persisted');
  assert.equal((await scanEvents(store)).filter(e => e.type === 'message.persisted' && e.host.messageID === 'msg_r0').length, 0, 'uncompleted assistant stays unpersisted');
  const texts = [];
  for (const row of rows) texts.push(JSON.parse((await store.readBlob(row.payload.ref)).toString()).content[0].text);
  assert.deepEqual(texts.sort(), ['version one', 'version two'], 'both observed versions remain exactly recoverable');
});

const intentEvent = (ref, at, summary) => ({ ref, at, type: 'trace.intent', host: { sessionID: 's1' }, intent: { summary, status: 'active', paths: [], resources: [], related_refs: [] } });

test('P1b: same-millisecond concurrent intents converge deterministically in any arrival order and keep the conflict visible', async t => {
  const { store, dir } = await fixture(t);
  const mkIntent = async (summary) => {
    const intent = { summary, status: 'active', paths: ['x'], resources: [], related_refs: [] };
    // Real trace.intent events carry the intent both as the payload blob and inline.
    return craftEvent(store, 'trace.intent', { sessionID: 's1' }, intent, 1000, { intent });
  };
  const a = await mkIntent('A plan');
  const b = await mkIntent('B plan');
  const expected = a.ref > b.ref ? 'A plan' : 'B plan';
  const bothRefs = [a.ref, b.ref].sort();
  const results = [];
  for (const order of [[a, b], [b, a]]) {
    const s = await new Store(dir, path.join(dir, 'store')).init(); t.after(() => s.close());
    for (const e of order) await s.ingest(structuredClone(e));
    results.push({ summary: s.session('s1').intent.summary, conflicts: s.session('s1').intent_conflicts });
  }
  assert.equal(results[0].summary, expected, 'forward order');
  assert.equal(results[1].summary, expected, 'reverse order converges to the same deterministic winner');
  for (const r of results) {
    assert.deepEqual(r.conflicts.map(c => c.refs).flat().sort(), bothRefs, 'concurrent intents stay visible as a conflict, not a silent winner');
  }
  // Recovery reads events in (at, ref) order and must converge identically.
  for (const e of [a, b]) await atomic(path.join(store.root, 'events', `${e.ref}.json`), stable(e), true);
  const recovered = await new Store(dir, path.join(dir, 'store')).init(); t.after(() => recovered.close());
  assert.equal(recovered.session('s1').intent.summary, expected);
  assert.deepEqual(recovered.session('s1').intent_conflicts.map(c => c.refs).flat().sort(), bothRefs);
});

test('P1b: same-millisecond identity and lifecycle observations converge deterministically', async t => {
  const { store, dir } = await fixture(t);
  const mk = async (agent, at) => craftEvent(store, 'session.lifecycle', { sessionID: 's1', agent }, { lifecycle: 'observed' }, at, { lifecycle: 'observed' });
  const a = await mk('agent-a', 2000);
  const b = await mk('agent-b', 2000);
  const expected = a.ref > b.ref ? 'agent-a' : 'agent-b';
  for (const order of [[a, b], [b, a]]) {
    const s = await new Store(dir, path.join(dir, 'store')).init(); t.after(() => s.close());
    for (const e of order) await s.ingest(structuredClone(e));
    assert.equal(s.session('s1').agent, expected);
    assert.equal(s.session('s1').observation.ref, expected === 'agent-a' ? a.ref : b.ref);
  }
});

test('P1c: late tool.before never reopens an evicted terminal call, live out-of-order and after restart', async t => {
  const { store: live, dir } = await fixture(t);
  const old = { sessionID: 's1', messageID: 'm1', id: 'old', agent: 'build', tool: 'read', input: { filePath: 'doc' } };
  const oldKey = callKey(old);
  // Craft the real event sequence directly on disk: the before is older than
  // its after; 130 later calls evict the terminal entry from the display window.
  const before1 = await craftToolEvent(live, 'tool.before', old, 999, 'old-before');
  const after1 = await craftToolEvent(live, 'tool.after', old, 1000, 'old-after');
  const others = [];
  for (let i = 0; i < 130; i++) {
    const h = { sessionID: 's1', messageID: 'm1', id: `c${i}`, agent: 'build', tool: 'read', input: { n: i } };
    others.push(await craftToolEvent(live, 'tool.before', h, 1001 + i * 2, `b${i}`));
    others.push(await craftToolEvent(live, 'tool.after', h, 1002 + i * 2, `a${i}`));
  }
  // Live out-of-order arrival (watch/reconcile order), before_1 still unseen.
  await live.ingest(structuredClone(after1));
  for (const e of others) await live.ingest(structuredClone(e));
  assert.ok(!live.session('s1').pending[oldKey], 'terminal entry evicted from display window');
  await live.ingest(structuredClone(before1));
  assert.ok(!live.session('s1').pending[oldKey], 'late out-of-order before must not reopen the call');
  // Persist every crafted event, then restart: recovery ingests in (at, ref)
  // order; the guard must survive and also stop a genuinely new unseen before
  // event with the same call identity.
  for (const e of [before1, after1, ...others]) await atomic(path.join(live.root, 'events', `${e.ref}.json`), stable(e), true);
  const restarted = await new Store(dir, path.join(dir, 'store')).init(); t.after(() => restarted.close());
  assert.ok(!restarted.session('s1').pending[oldKey]);
  const lateNew = await craftToolEvent(restarted, 'tool.before', { ...old, agent: undefined }, 5000, 'late-new-before');
  await restarted.ingest(structuredClone(lateNew));
  assert.ok(!restarted.session('s1').pending[oldKey], 'durable terminal evidence outlives the display window');
  // The late before is still ingested as evidence; only pending state is guarded.
  assert.ok(restarted.seen.has(lateNew.ref));
});

test('P1d: context recall distinguishes prepared from hook_applied; timeout records prepared but never applied', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-trace-stage-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const hooks = {};
  const ctx = { options: { storeRoot: path.join(dir, 'store') }, location: { directory: dir },
    session: { hook: async (name, fn) => { hooks[name] = fn; } },
    tool: { hook: async (name, fn) => { hooks[name] = fn; }, transform: async fn => fn({ add: () => {} }) },
    agent: { transform: async fn => fn({ list: () => [] }) }, event: { async *subscribe() {} } };
  const cleanup = await plugin.setup(ctx);
  const event = sessionID => ({ sessionID, agent: 'build', messages: [{ id: 'msg_1', type: 'user', role: 'user', text: 'hi', time: { created: 1 } }], system: [] });
  await hooks.context(event('s1'));
  const store = await new Store(dir, path.join(dir, 'store')).init();
  t.after(() => store.close());
  const count = async () => {
    const rows = await scanEvents(store);
    return {
      prepared: rows.filter(e => e.type === 'context.checkpoint'),
      applied: rows.filter(e => e.type === 'context.applied'),
    };
  };
  let stages = await count();
  assert.equal(stages.prepared.length, 1);
  assert.equal(stages.prepared[0].stage, 'prepared');
  assert.equal(stages.applied.length, 1, 'hook that actually appended recall records hook_applied');
  assert.equal(stages.applied[0].stage, 'hook_applied');
  assert.equal(stages.applied[0].checkpoint, stages.prepared[0].ref, 'applied links to its exact checkpoint');
  assert.equal(stages.applied[0].host.sessionID, 's1');
  // Observer timeout: the checkpoint is still prepared in the background, but
  // nothing was appended and no applied record may exist for it. The delay is
  // injected on the Store prototype because the plugin owns its store instance.
  const originalReconcile = Store.prototype.reconcile;
  Store.prototype.reconcile = function () { return new Promise(r => setTimeout(r, 1150)); };
  const second = event('s2');
  await hooks.context(second);
  assert.equal(second.system.length, 1, 'missing recall is explicitly reported without injecting late data');
  assert.match(second.system[0].text, /OPENCODE_TRACE_RECALL_UNAVAILABLE/);
  assert.match(second.system[0].text, /does not mean there is no history/);
  await new Promise(r => setTimeout(r, 1350));
  Store.prototype.reconcile = originalReconcile;
  stages = await count();
  assert.equal(stages.applied.length, 1, 'no hook_applied without a real append');
  assert.equal(stages.prepared.length, 2, 'the timed-out preparation is still recorded as prepared only');
  assert.ok(stages.prepared.some(p => p.host.sessionID === 's2' && !stages.applied.some(a => a.checkpoint === p.ref)),
    'prepared without applied stays distinguishable');
  await cleanup();
});


test('automatic recall labels model claims and exposes observation age and capture degradation', async t => {
  const { trace } = await fixture(t);
  await trace.note({ kind: 'fact', text: 'Service was healthy yesterday', source_refs: [] }, { sessionID: 'worker' });
  trace.errors = 2; trace.droppedObservations = 1;
  const started = Date.now();
  const recall = trace.recall('worker');
  assert.match(recall, /not independently verified facts/);
  assert.match(recall, /Recheck time-sensitive claims/);
  const view = JSON.parse(recall.split('\n')[2]);
  assert.ok(view.snapshot_at >= started);
  assert.equal(view.observer.errors, 2);
  assert.equal(view.observer.dropped_observations, 1);
  assert.match(view.observer.meaning, /Zero errors does not prove complete/);
  assert.equal(view.notes[0].text, 'Service was healthy yesterday');
});
