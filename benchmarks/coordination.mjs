// Cross-process component probe, distinct from real OpenCode/model receipts.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Trace } from '../src/trace.js';

const root = path.resolve(process.argv[2]), workspace = path.join(root, 'workspace');
if (process.argv[3] === 'worker') {
  const trace = new Trace({ location: { directory: workspace } }, { storeRoot: path.join(root, 'store') });
  await trace.ready;
  process.on('message', async ({ id, method, args }) => {
    try {
      let result;
      if (method === 'intent') result = await trace.intent(args.input, args.host);
      if (method === 'note') result = await trace.note(args.input, args.host);
      if (method === 'status') result = trace.projection(args.sid, args.offset ?? 0, args.limit ?? 8);
      if (method === 'expand') result = await trace.store.expand(args.ref);
      if (method === 'source') {
        const e = { ...args.host, tool: 'read', input: { filePath: path.join(workspace, 'source.txt') } };
        await trace.before(e);
        result = await trace.after({ ...e, status: 'completed', result: { content: [{ type: 'text', text: args.text }] } });
      }
      if (method === 'close') { trace.store.close(); process.send({ id, result: true }, () => process.exit(0)); return; }
      process.send({ id, result });
    } catch (error) { process.send({ id, error: String(error.code ?? error.message) }); }
  });
  process.send({ ready: true });
} else {
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
  if (await fs.stat(path.join(root, 'store')).catch(() => null)) throw new Error('Use an empty output directory');
  let serial = 0;
  const workers = [];
  function worker() {
    const child = fork(fileURLToPath(import.meta.url), [root, 'worker'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const pending = new Map();
    const ready = new Promise(resolve => child.on('message', m => { if (m.ready) resolve(); }));
    child.on('message', m => {
      const job = pending.get(m.id);
      if (!job) return;
      pending.delete(m.id); clearTimeout(job.timer);
      m.error ? job.reject(new Error(m.error)) : job.resolve(m.result);
    });
    return { child, ready, rpc(method, args = {}) {
      const id = ++serial;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('RPC deadline')); }, 15000);
        pending.set(id, { resolve, reject, timer }); child.send({ id, method, args });
      });
    } };
  }
  const pause = () => new Promise(resolve => setTimeout(resolve, 5));
  const host = (sid, id) => ({ sessionID: sid, messageID: `message-${id}`, id: `call-${id}`, agent: 'build' });
  const intent = (sid, id, file, status = 'active') => ({ host: host(sid, id), input: { summary: `Work on ${file}`, paths: [file], status } });
  const result = { kind: 'synthetic_cross_process_component_measurement', processes: 4, sessions: 16 };
  try {
    for (let i = 0; i < 4; i++) workers.push(worker());
    await Promise.all(workers.map(w => w.ready));
    const visibility = [];
    for (let round = 0; round < 20; round++) {
      const writer = round % 4;
      const note = await workers[writer].rpc('note', { host: host(`s${writer}`, `note-${round}`), input: { kind: 'finding', text: `shared-${round}`, source_refs: [] } });
      const started = performance.now(); let attempts = 0;
      while (true) {
        const views = await Promise.all(workers.map(w => w.rpc('status', { sid: `s${writer}` })));
        if (views.every(v => v.notes.some(n => n.ref === note.ref))) break;
        if (performance.now() - started > 3000) throw new Error('Visibility deadline exceeded');
        await pause(); attempts++;
      }
      visibility.push({ milliseconds_after_writer_return: performance.now() - started, polling_retries: attempts });
    }
    result.visibility = visibility;
    const source = await workers[0].rpc('source', { host: host('s0', 'source'), text: 'COMPONENT_ORIGINAL_SOURCE_738291' });
    const note = await workers[0].rpc('note', { host: host('s0', 'source-note'), input: { kind: 'handoff', text: 'Inspect the saved original source.', source_refs: [source.ref] } });
    await fs.writeFile(path.join(workspace, 'source.txt'), 'CURRENT_FILE_REPLACED');
    const expanded = await workers[3].rpc('expand', { ref: source.ref });
    result.peer_exact_recovery = expanded.exact_utf8.includes('COMPONENT_ORIGINAL_SOURCE_738291');
    result.source_ref = source.ref; result.note_ref = note.ref;
    const raceRounds = [];
    for (let round = 0; round < 10; round++) {
      const pathName = `race-${round}.txt`;
      await Promise.all(workers.map((w, i) => w.rpc('intent', intent(`s${i}`, `race-${round}-${i}`, pathName))));
      await new Promise(resolve => setTimeout(resolve, 30));
      const views = await Promise.all(workers.map((w, i) => w.rpc('status', { sid: `s${i}` })));
      raceRounds.push({ round, peers_with_current_advisory: views.filter(v => v.advisories.some(a => a.paths.includes(path.join(workspace, pathName)))).length });
    }
    result.simultaneous_intent_rounds = raceRounds;
    for (let i = 0; i < 16; i++) await workers[i % 4].rpc('intent', intent(`s${i}`, `populate-${i}`, `file-${i}.txt`));
    await new Promise(resolve => setTimeout(resolve, 50));
    const pages = [await workers[0].rpc('status', { sid: 's0', offset: 0, limit: 8 }), await workers[0].rpc('status', { sid: 's0', offset: 8, limit: 8 })];
    result.peer_pagination = { total: pages[0].peer_total, page_sizes: pages.map(p => p.peers.length), unique: new Set(pages.flatMap(p => p.peers.map(x => x.sessionID))).size };
    await workers[3].rpc('close');
    const afterExit = await workers[0].rpc('status', { sid: 's15' });
    result.intent_after_owner_process_exit = afterExit.current_intent.status;
    const outsider = new Trace({ location: { directory: path.join(root, 'other-workspace') } }, { storeRoot: path.join(root, 'store') });
    await outsider.ready;
    try { await outsider.store.expand(source.ref); result.foreign_workspace_rejected = false; }
    catch (error) { result.foreign_workspace_rejected = error.code === 'ENOENT'; }
    outsider.store.close();
    result.passed = result.peer_exact_recovery && result.peer_pagination.unique === 15 && result.foreign_workspace_rejected;
    await fs.writeFile(path.join(root, 'coordination-results.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    for (const w of workers) if (w.child.exitCode === null) w.child.kill('SIGTERM');
  }
}
