import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Trace } from '../src/trace.js';

// Before a file mutation runs, Trace keeps the target's previous bytes in the
// blob store, so an overwritten version stays recoverable without git.
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-preimage-'));
  const trace = new Trace({ location: { directory }, session: {} }, { storeRoot: path.join(directory, 'store') });
  await trace.ready;
  t.after(async () => { await trace.store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { trace, directory };
}
const call = (id, tool, input) => ({ sessionID: 'worker', messageID: 'm1', id, agent: 'build', tool, input });
const beforeEvent = (trace, id) => trace.store.findEntriesAll({ type: 'tool.before', session: 'worker' }).find(e => e.callID === id);

test('write keeps the overwritten bytes, recoverable by ref', async t => {
  const { trace, directory } = await fixture(t);
  const file = path.join(directory, 'a.txt');
  await fs.writeFile(file, 'version one\n');
  const event = await trace.before(call('c1', 'write', { filePath: 'a.txt', content: 'version two\n' }));
  const [pre] = event.preimages;
  assert.equal(pre.path, await fs.realpath(file));
  assert.equal(pre.existed, true);
  assert.equal(pre.captured, true);
  assert.equal(pre.bytes, 12);
  assert.equal((await trace.store.expand(pre.ref)).exact_utf8, 'version one\n');
  // The pre-image is a relation of the tool.before event, for trace_expand and trace_find(related=...).
  assert.ok((await trace.store.expand(event.ref, 0, 16, true)).related_refs.includes(pre.ref));
  assert.equal(trace.store.findEntriesAll({ related: pre.ref })[0].ref, beforeEvent(trace, 'c1').ref);
});

test('successive edits keep one pre-image per version; identical bytes share a blob', async t => {
  const { trace, directory } = await fixture(t);
  const file = path.join(directory, 'b.txt');
  await fs.writeFile(file, 'alpha\n');
  const first = await trace.before(call('c1', 'edit', { filePath: file, oldString: 'alpha', newString: 'beta' }));
  await fs.writeFile(file, 'beta\n');
  const second = await trace.before(call('c2', 'edit', { filePath: file, oldString: 'beta', newString: 'alpha' }));
  await fs.writeFile(file, 'alpha\n');
  const third = await trace.before(call('c3', 'edit', { filePath: file, oldString: 'alpha', newString: 'gamma' }));
  assert.equal((await trace.store.expand(first.preimages[0].ref)).exact_utf8, 'alpha\n');
  assert.equal((await trace.store.expand(second.preimages[0].ref)).exact_utf8, 'beta\n');
  assert.equal(third.preimages[0].ref, first.preimages[0].ref);
});

test('a file the tool creates is recorded as not existing before', async t => {
  const { trace } = await fixture(t);
  const event = await trace.before(call('c1', 'write', { filePath: 'new.txt', content: 'x' }));
  assert.equal(event.preimages.length, 1);
  assert.equal(event.preimages[0].existed, false);
  assert.equal(event.preimages[0].ref, undefined);
});

test('bytes read after the observer deadline are not stored as a pre-image', async t => {
  const { trace, directory } = await fixture(t);
  await fs.writeFile(path.join(directory, 'late.txt'), 'old');
  const event = await trace.before(call('c1', 'write', { filePath: 'late.txt', content: 'new' }), undefined, Date.now() - 1);
  assert.deepEqual({ ...event.preimages[0], path: null }, { path: null, existed: true, captured: false, reason: 'observer_deadline' });
});

test('the host hook path passes the observer deadline through safe()', async t => {
  const { trace, directory } = await fixture(t);
  await fs.writeFile(path.join(directory, 'c.txt'), 'kept');
  let seen;
  await trace.safe('before', deadline => { seen = deadline; return trace.before(call('c1', 'edit', { filePath: 'c.txt', oldString: 'kept', newString: 'k' }), undefined, deadline); });
  assert.ok(Number.isFinite(seen) && seen > Date.now() - 5000);
  assert.equal(beforeEvent(trace, 'c1').rels.length, 1);
});

test('directories and non-mutating tools get no pre-image', async t => {
  const { trace, directory } = await fixture(t);
  await fs.mkdir(path.join(directory, 'dir'));
  const dir = await trace.before(call('c1', 'write', { filePath: 'dir', content: 'x' }));
  assert.equal(dir.preimages[0].reason, 'not_regular_file');
  const read = await trace.before(call('c2', 'read', { filePath: 'dir' }));
  assert.equal(read.preimages, undefined);
});
