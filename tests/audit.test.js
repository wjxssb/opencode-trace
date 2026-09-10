import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Trace } from '../src/trace.js';
import { Store } from '../src/store.js';
import { hash, stable } from '../src/util.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-audit-'));
  const trace = new Trace({ location: { directory: dir }, session: { context: async () => [] } }, { storeRoot: path.join(dir, 'store') });
  await trace.ready;
  t.after(async () => { trace.store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { trace, store: trace.store, dir };
}

test('metadata inspection omits payload; every selectable page preserves exact bytes and hash', async t => {
  const { trace, store } = await fixture(t);
  const original = '中文abc'.repeat(1500);
  const event = await trace.after({ sessionID: 's', id: 'call', tool: 'read', status: 'completed', result: { content: [{ type: 'text', text: original }] } });
  const meta = await store.expand(event.ref, 0, 2048, true);
  assert.equal(meta.returned_bytes, 0); assert.equal(meta.exact_utf8, undefined); assert.equal(meta.exact_base64, undefined);
  assert.deepEqual(meta.text_blobs, event.outputs); assert.equal(meta.hash_verified, true);
  assert.equal((await store.expand(event.outputs[0].ref)).returned_bytes, 2048);
  let offset = 0; const pages = [];
  do {
    const page = await store.expand(event.outputs[0].ref, offset, 997);
    pages.push(Buffer.from(page.exact_base64, 'base64')); offset = page.next_offset;
    assert.equal(page.sha256, hash(Buffer.from(original)));
  } while (offset !== null);
  assert.equal(Buffer.concat(pages).toString(), original);
  assert.equal((await store.expand(event.outputs[0].ref, 0, 24000)).exact_utf8, original);
  const blob = event.outputs[0];
  await fs.writeFile(path.join(store.root, 'blobs', blob.sha256.slice(0, 2), blob.sha256), 'changed');
  await assert.rejects(store.expand(blob.ref, 0, 2048, true), /hash mismatch/);
});

test('cumulative checkpoint is bounded while exact original message survives restart', async t => {
  const { trace, store, dir } = await fixture(t);
  const messages = Array.from({ length: 1000 }, (_, n) => ({ id: `user_${n}`, type: 'user', content: `original ${n}` }));
  await trace.context({ sessionID: 's', messages });
  const events = await Promise.all((await fs.readdir(path.join(store.root, 'events'))).map(n => store.readEvent(n.slice(0, -5))));
  const checkpoint = events.find(e => e.type === 'context.checkpoint');
  const payload = JSON.parse((await store.readBlob(checkpoint.payload.ref)).toString());
  assert.equal(payload.messageIDs, undefined); assert.equal(payload.messageCount, 1000);
  assert.deepEqual(payload.messageIDsTail, messages.slice(-8).map(m => m.id));
  assert.equal(payload.messageIDsSha256, hash(stable(messages.map(m => m.id))));
  const original = events.find(e => e.host.messageID === 'user_0');
  const restart = await new Store(dir, path.join(dir, 'store')).init(); t.after(() => restart.close());
  assert.deepEqual(JSON.parse((await restart.expand(original.ref)).exact_utf8), messages[0]);
});

test('intent stays active across completion and deletion; observations remain factual', async t => {
  const { trace, store, dir } = await fixture(t);
  await trace.intent({ summary: 'planned', status: 'active', paths: ['x'] }, { sessionID: 'owner', id: 'intent' });
  const emit = type => trace.lifecycle({ id: `host-${type}`, type, location: { directory: dir }, data: { sessionID: 'owner' } });
  await emit('session.execution.started');
  let peer = trace.projection('peer').peers[0];
  assert.equal(peer.observation.session_lifecycle, 'session.execution.started');
  assert.equal(peer.observation.liveness_unknown, true);
  await emit('session.execution.succeeded');
  peer = trace.projection('peer').peers[0];
  assert.equal(peer.intent.status, 'active'); assert.equal(peer.observation.host_deleted_evidence, null);
  await emit('session.deleted');
  await emit('session.updated');
  peer = trace.projection('peer').peers[0];
  assert.equal(peer.intent.status, 'active'); assert.ok(peer.observation.host_deleted_evidence.ref);
  assert.equal(peer.observation.liveness_unknown, false);
  const advisory = await trace.intent({ summary: 'overlap', status: 'active', paths: ['x'] }, { sessionID: 'peer', id: 'intent2' });
  assert.ok(advisory.advisories[0].observation.host_deleted_evidence);
  assert.equal(store.session('owner').intent.status, 'active');
});

test('on-demand telemetry counts actual files and exposes available filesystem bytes', async t => {
  const { store } = await fixture(t);
  await store.record('test', { sessionID: 's' }, { exact: 'data' });
  const usage = await store.storageUsage();
  assert.equal(usage.groups.events.objects, 1); assert.equal(usage.groups.blobs.objects, 1);
  assert.ok(usage.total_bytes > 0); assert.ok(usage.filesystem_available_bytes > 0);
  assert.equal(usage.object_count, Object.values(usage.groups).reduce((n, g) => n + g.objects, 0));
});
