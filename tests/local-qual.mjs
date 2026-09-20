// Real isolated-host qualification with the RESIDENT LOCAL MODEL (V2-A).
// Mirrors e2e_host.mjs isolation (private server, isolated HOME, random port)
// but points the provider at the local vLLM endpoint and drives a genuine
// handle drill. No other provider is configured in the isolated home, so
// non-local inference is structurally impossible.
// Usage: node tests/local-qual.mjs <fresh-output-dir>
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), `trace-localqual-${Date.now()}`));
const home = path.join(out, 'home');
const work = path.join(out, 'work');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) process.exitCode = 1; };

await fs.mkdir(home, { recursive: true });
await fs.mkdir(work, { recursive: true });
await fs.mkdir(path.join(home, '.config', 'opencode'), { recursive: true });
await fs.writeFile(path.join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({
  $schema: 'https://opencode.ai/config.json',
  autoupdate: false, share: 'disabled', default_agent: 'build', snapshots: false,
  model: { providerID: 'local-qwen-auto', model: '27b-dense' },
  providers: { 'local-qwen-auto': {
    name: 'Local', package: '@opencode/ai/providers/openai-compatible',
    settings: { baseURL: 'http://127.0.0.1:18080/v1' },
    models: { '27b-dense': { modelID: 'qwen38-27b-dense', name: 'Qwen Dense',
      capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
      compatibility: { reasoningField: 'reasoning' },
      limit: { context: 262144, output: 32768 } } },
  } },
  plugins: [{ package: repo, options: { contextDelivery: 'runtime-context-v1' } }],
}, null, 2));

const basePort = 45000 + Math.floor(Math.random() * 4000) * 2;
const serverPort = basePort + 1;
const serveLog = path.join(out, 'serve.log');
const handle = await fs.open(serveLog, 'w');
const child = spawn('opencode2', ['serve', '--hostname', '127.0.0.1', '--port', String(serverPort), '--log-level', 'warn'],
  { cwd: work, env: { ...process.env, HOME: home }, stdio: ['ignore', handle.fd, handle.fd] });
child.unref();
await handle.close();

let password = null;
for (let i = 0; i < 60 && !password; i++) {
  await new Promise(r => setTimeout(r, 500));
  try { password = (await fs.readFile(serveLog, 'utf8')).match(/server password (\S+)/)?.[1] ?? null; } catch {}
}
const auth = { Authorization: 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64') };
let healthy = false;
for (let i = 0; i < 60 && !healthy; i++) {
  try { const res = await fetch(`http://127.0.0.1:${serverPort}/api/info`, { headers: auth }); healthy = res.ok; } catch {}
  if (!healthy) await new Promise(r => setTimeout(r, 500));
}
check('isolated server healthy (local-only provider)', healthy && !!password);

const api = async (method, p, body, timeoutMs = 420000) => {
  const res = await fetch(`http://127.0.0.1:${serverPort}${p}`, { method, headers: { ...auth, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};
const idle = async sessionID => { await api('POST', `/api/session/${sessionID}/wait`).catch(() => {}); };
const promptAndSettle = async (sessionID, text) => { await api('POST', `/api/session/${sessionID}/prompt`, { text }); await idle(sessionID); };

const workspaceID = (await import('node:crypto')).createHash('sha256').update(await fs.realpath(work)).digest('hex');
const storeBase = path.join(home, '.local/share/opencode-trace');
const storeRoot = path.join(storeBase, 'workspaces', workspaceID);
const openStore = () => new Store(work, storeBase).init();
const payloadOf = async (store, entry) => JSON.parse((await store.readBlob(entry.payloadRef)).toString());

try {
  if (!healthy) throw new Error('server never became healthy');
  await api('POST', '/api/plugin/await-activation', { location: { directory: work } }).catch(() => null);
  const models = await api('GET', '/api/model');
  const all = models.data ?? [];
  check('local provider configured and selectable (zero GLM by construction: isolated home has no other credentials)',
    all.some(m => m.providerID === 'local-qwen-auto' && m.modelID === '27b-dense'), `models=${all.length}`);

  const session = (await api('POST', '/api/session', {})).data ?? (await api('POST', '/api/session', {}));
  const sid = session.id ?? session.session?.id;

  // Turn 1: produce raw evidence with a native tool.
  await promptAndSettle(sid, 'Run this exact shell command and nothing else, then finish: echo qual-evidence-7f31');
  // Turn 2: new request -> new handle generation includes the shell event.
  await promptAndSettle(sid,
    'Your runtime context contains an "EVIDENCE HANDLES" list with short labels like [e1]/[b1]. ' +
    'Do exactly three things: (1) call trace_expand with ref set to the SHORT HANDLE of the tool.after event for the command `echo qual-evidence-7f31` (a label like e1 — never a hex ref). ' +
    '(2) call trace_note with kind=finding, text containing the marker qual-marker-7f31, and source_handles set to [that same short handle]. ' +
    '(3) reply with one line containing the note ref.');

  // Turn 3 (negative): a stale/unknown handle must reject clearly in the real host.
  await promptAndSettle(sid,
    'Call trace_expand with ref set to e99 (a handle that does not exist). Then reply with exactly the error text you received.');

  const store = await openStore();
  const events = [...store.index.values()];
  check('candidate trace plugin active (durable context receipts)',
    events.some(e => e.type === 'context.checkpoint') && events.some(e => e.type === 'context.applied'));
  const noteEntries = events.filter(e => e.type === 'trace.note');
  check('V2-A: trace_note persisted in isolated real-host store', noteEntries.length === 1);

  const note = noteEntries.length ? await payloadOf(store, noteEntries[0]) : { source_refs: [] };
  const canonical = (note.source_refs ?? []).every(r => /^(evt|blob)_[a-f0-9]{64}$/.test(r));
  check('V2-A/H7: durable note stores full canonical refs only', canonical && (note.source_refs ?? []).length > 0, JSON.stringify(note.source_refs ?? []));
  check('V2-A/H7: no handle field leaked into durable payload', !('source_handles' in note));

  // The cited canonical ref must exist and hash-verify in this store.
  const resolves = await Promise.all((note.source_refs ?? []).map(r => store.exists(r).then(() => true).catch(() => false)));
  check('V2-A: cited canonical refs resolve in the isolated CAS', resolves.every(Boolean));

  // Model actually used the handle form (transport evidence in tool input echo).
  const beforeEntries = [];
  for (const entry of events.filter(e => e.type === 'tool.before' && e.tool === 'trace_expand').slice(-6)) {
    beforeEntries.push(await payloadOf(store, entry));
  }
  const usedHandle = beforeEntries.some(b => typeof b?.input?.ref === 'string' && /^[ebn][1-9][0-9]{0,3}$/.test(b.input.ref));
  check('V2-A/H1: model cited a short handle in trace_expand (real model behavior)', usedHandle);

  // Recall receipts: the snapshot carried the handle block (late runtime context).
  let recallHadHandles = false, recallHadMarker = false;
  for (const entry of events.filter(e => e.type === 'context.checkpoint')) {
    const data = await payloadOf(store, entry);
    recallHadMarker ||= String(data?.recall ?? '').includes('OPENCODE_TRACE_RECALL_V1');
    recallHadHandles ||= String(data?.recall ?? '').includes('EVIDENCE HANDLES');
  }
  check('CACHE-D: recall delivered late via context hook (checkpoint receipt)', recallHadMarker);
  check('V2-A: snapshot exposed the EVIDENCE HANDLES block to the real model', recallHadHandles);

  // Negative probe result: unknown handle rejected clearly in the real host.
  const afterEntries = [];
  for (const entry of events.filter(e => e.type === 'tool.after' && e.tool === 'trace_expand').slice(-8)) {
    afterEntries.push(await payloadOf(store, entry));
  }
  const unknownRejected = afterEntries.some(a => JSON.stringify(a).includes("Unknown evidence handle 'e99'"));
  check('V2-A/H3(real host): unknown handle e99 rejected clearly', unknownRejected);

  const ttftNote = 'wall-clock timings are in serve.log; suite-level perf measured separately';
  check('qualification drill complete', true, ttftNote);
} catch (error) {
  check('qualification run completed without harness error', false, String(error).slice(0, 300));
} finally {
  try { child.kill('SIGTERM'); } catch {}
}
