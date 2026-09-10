// Bounded, synthetic measurements of the checked-out runtime. Not a model benchmark.
// Usage: node --expose-gc benchmarks/storage.mjs /absolute/output-directory
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { Trace } from '../src/trace.js';
import { Store } from '../src/store.js';
import { stable, hash } from '../src/util.js';

const script = fileURLToPath(import.meta.url);
const root = path.resolve(process.argv[2]);
if (process.argv[3] === 'replay') {
  global.gc?.(); const before = process.memoryUsage(); const start = performance.now();
  const store = await new Store(process.argv[4], root).init();
  global.gc?.();
  console.log(JSON.stringify({ milliseconds: performance.now() - start, events: store.seen.size,
    sessions: store.sessions.size, heap_delta_bytes: process.memoryUsage().heapUsed - before.heapUsed,
    rss_bytes: process.memoryUsage().rss }));
  store.close();
} else {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  async function usage(directory) {
    const result = { files: 0, apparent: 0, allocated: 0, groups: {} };
    async function walk(dir, group = '') {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const filename = path.join(dir, entry.name), category = group || entry.name;
        if (entry.isDirectory()) await walk(filename, category);
        else { const s = await fs.stat(filename); const g = result.groups[category] ??= { files: 0, apparent: 0, allocated: 0 };
          for (const target of [result, g]) { target.files++; target.apparent += s.size; target.allocated += s.blocks * 512; }
        }
      }
    }
    await walk(directory); return result;
  }
  const specs = [
    { name: 'identical_replay_1k', count: 1000, size: 1024, replay: true },
    { name: 'distinct_calls_repeated_1k', count: 1000, size: 1024 },
    { name: 'distinct_calls_unique_64k', count: 500, size: 65536, unique: true },
    { name: 'growing_context_1k', count: 1000, size: 1024, context: true },
    { name: 'windowed_context_1k', count: 1000, size: 1024, context: true, window: 50 },
    { name: 'expand_chain_24k', count: 50, size: 65536, chain: true }
  ];
  const results = [];
  for (const spec of specs) {
    const base = path.join(root, spec.name), workspace = path.join(base, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    if (await fs.stat(path.join(base, 'store')).catch(() => null)) throw new Error(`Use an empty output directory: ${spec.name}`);
    const trace = new Trace({ location: { directory: workspace } }, { storeRoot: path.join(base, 'store') });
    await trace.ready;
    const rows = [], timings = []; let messages = [], previous, checkpointIDBytes = 0, maxRecallBytes = 0, maxOutputBytes = 0;
    const start = performance.now();
    for (let n = 1; n <= spec.count; n++) {
      const index = spec.replay ? 1 : n;
      const host = { sessionID: 'synthetic-session', messageID: `msg_${String(index).padStart(28, '0')}`, id: `call_${index}`, agent: 'build' };
      const text = ((spec.unique ? hash(String(index)) : 'x'.repeat(64))).repeat(Math.ceil(spec.size / 64)).slice(0, spec.size);
      const operation = { ...host, tool: spec.chain && previous ? 'trace_expand' : 'read',
        input: spec.chain && previous ? { ref: previous, limit: 24000 } : { filePath: path.join(workspace, 'document.txt') } };
      const started = performance.now();
      await trace.before(operation);
      const output = spec.chain && previous ? JSON.stringify(await trace.store.expand(previous, 0, 24000)) : text;
      maxOutputBytes = Math.max(maxOutputBytes, Buffer.byteLength(output));
      const after = await trace.after({ ...operation, status: 'completed', result: { content: [{ type: 'text', text: output }] } });
      previous = after.ref;
      if (spec.context) {
        messages.push({ id: `user_${String(n).padStart(27, '0')}`, type: 'user', content: 'Read the next document.' },
          { id: host.messageID, type: 'assistant', finish: 'stop', content: 'Read completed.' });
        if (spec.window && n % spec.window === 0) messages = messages.slice(-2);
        checkpointIDBytes += Buffer.byteLength(stable(messages.map(m => m.id)));
        const recall = await trace.context({ ...host, messages });
        maxRecallBytes = Math.max(maxRecallBytes, Buffer.byteLength(recall));
      }
      timings.push(performance.now() - started);
      if ([1, 50, 100, 250, 500, 1000].includes(n) || n === spec.count) {
        await trace.store.flush();
        const row = { calls: n, elapsed_ms: performance.now() - start, checkpoint_id_bytes_cumulative: checkpointIDBytes,
          events: trace.store.seen.size, ...await usage(trace.store.root) };
        rows.push(row);
        console.log(JSON.stringify({ scenario: spec.name, calls: n, apparent: row.apparent, allocated: row.allocated, files: row.files }));
      }
    }
    await trace.store.flush(); trace.store.close(); timings.sort((a, b) => a - b);
    const replay = spawnSync(process.execPath, ['--expose-gc', script, path.join(base, 'store'), 'replay', workspace], { encoding: 'utf8', timeout: 60000 });
    if (replay.status !== 0) throw new Error(`Replay failed: ${replay.stderr}`);
    const result = { ...spec, rows, max_recall_bytes: maxRecallBytes, max_output_bytes: maxOutputBytes,
      operation_ms: { median: timings[Math.floor(timings.length * .5)], p95: timings[Math.floor(timings.length * .95)] },
      replay: JSON.parse(replay.stdout), errors: trace.errors };
    results.push(result);
    await fs.writeFile(path.join(root, 'storage-results.json'), JSON.stringify({ schema: 1, kind: 'synthetic_component_measurement', results }, null, 2));
  }
}
