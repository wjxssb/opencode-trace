import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Trace } from '../src/trace.js';

// Host synthetic notices carry a background command's outcome as structured metadata.
// Trace keeps those facts as their own searchable event instead of only message text.
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-background-'));
  const trace = new Trace({ location: { directory }, session: {} }, { storeRoot: path.join(directory, 'store') });
  await trace.ready;
  // The session is known to this workspace, as it is after its first prompt or tool call.
  await trace.after({ sessionID: 'worker', messageID: 'm1', id: 'c1', agent: 'build', tool: 'shell', input: { command: 'gs', background: true }, status: 'completed', result: { output: 'moved to background' } });
  t.after(async () => { await trace.store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return trace;
}
const synthetic = (metadata, text = '<shell id="sh_1">...</shell>') =>
  ({ type: 'session.synthetic', id: `evt_${Math.random()}`, properties: { sessionID: 'worker', text, description: 'gs -sDEVICE=txtwrite', metadata } });

test('a signal death is recorded with its signal as the searchable status', async t => {
  const trace = await fixture(t);
  await trace.lifecycle(synthetic({ source: 'shell', shellID: 'sh_1', jobID: 'sh_1', state: 'completed', signal: 'SIGKILL', truncated: false }));
  const [entry] = trace.store.findEntriesAll({ type: 'background.outcome', session: 'worker' });
  assert.equal(entry.tool, 'shell');
  assert.equal(entry.status, 'signal:SIGKILL');
  const payload = JSON.parse((await trace.store.expand(entry.payloadRef)).exact_utf8);
  assert.equal(payload.metadata.signal, 'SIGKILL');
  assert.equal(payload.description, 'gs -sDEVICE=txtwrite');
});

test('exit codes, cancellations and restart outcomes each keep a precise status', async t => {
  const trace = await fixture(t);
  await trace.lifecycle(synthetic({ source: 'shell', shellID: 'sh_2', state: 'completed', exit: 7 }));
  await trace.lifecycle(synthetic({ source: 'shell', shellID: 'sh_3', state: 'cancelled' }));
  await trace.lifecycle(synthetic({ source: 'shell', shellID: 'sh_4', state: 'cancelled', outcome: 'unknown', reason: 'server-stopped', pid: 9, process: 'gone' }));
  await trace.lifecycle(synthetic({ source: 'restart', shellID: 'sh_5', pid: 10, process: 'alive' }));
  const statuses = trace.store.findEntriesAll({ type: 'background.outcome', session: 'worker' }).map(e => e.status);
  assert.deepEqual(statuses, ['exit:7', 'cancelled', 'cancelled:server-stopped:gone', 'alive']);
});

test('unrelated synthetic notices are not recorded as background outcomes', async t => {
  const trace = await fixture(t);
  await trace.lifecycle(synthetic({ source: 'instructions' }));
  await trace.lifecycle(synthetic(undefined));
  assert.equal(trace.store.findEntriesAll({ type: 'background.outcome', session: 'worker' }).length, 0);
});
