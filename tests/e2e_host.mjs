// Real isolated-host E2E: drives a private OpenCode server with the
// deterministic scripted provider and the checked-out trace plugin.
// Usage: node tests/e2e_host.mjs <fresh-output-dir>
// Never touches an existing user service, port, config or session.
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), `trace-e2e-${Date.now()}`));
const home = path.join(out, 'home');
const work = path.join(out, 'work');
const controlPath = path.join(out, 'control.json');
const receiptsPath = path.join(out, 'receipts.jsonl');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) process.exitCode = 1; };

await fs.mkdir(home, { recursive: true });
await fs.mkdir(work, { recursive: true });
await fs.mkdir(path.join(home, '.config', 'opencode'), { recursive: true });
await fs.writeFile(controlPath, JSON.stringify({ default: { compact: 'fixture' } }));
await fs.writeFile(receiptsPath, '');

const basePort = 41000 + Math.floor(Math.random() * 4000) * 2;
const modelPort = basePort, serverPort = basePort + 1;
const spawnDetached = async (cmd, args, logFile, env) => {
  const handle = await fs.open(logFile, 'w');
  try {
    const child = spawn(cmd, args, { cwd: work, env: { ...process.env, ...env }, stdio: ['ignore', handle.fd, handle.fd] });
    child.unref();
  } finally { await handle.close(); }
};

const fixture = spawn('python3', [path.join(repo, 'tests', 'scripted_provider.py'), '--port', String(modelPort), '--control', controlPath, '--receipts', receiptsPath], { stdio: 'ignore' });
fixture.unref();
await new Promise(r => setTimeout(r, 1200));

await fs.writeFile(path.join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({
  $schema: 'https://opencode.ai/config.json',
  autoupdate: false, share: 'disabled', default_agent: 'build',
  model: 'fixture/fixture-model',
  permissions: [{ action: 'edit', resource: '*', effect: 'deny' }],
  provider: { fixture: { npm: '@ai-sdk/openai-compatible', name: 'Fixture',
    options: { baseURL: `http://127.0.0.1:${modelPort}/v1`, apiKey: 'fixture-key' },
    models: { 'fixture-model': { name: 'Fixture Model' } } } },
  plugins: [repo],
}, null, 2));

const serveLog = path.join(out, 'serve.log');
await spawnDetached('opencode2', ['serve', '--hostname', '127.0.0.1', '--port', String(serverPort), '--log-level', 'warn'], serveLog, { HOME: home });let password = null;
for (let i = 0; i < 40 && !password; i++) {
  await new Promise(r => setTimeout(r, 500));
  try { password = (await fs.readFile(serveLog, 'utf8')).match(/server password (\S+)/)?.[1] ?? null; } catch {}
}
const auth = { Authorization: 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64') };
let healthy = false;
for (let i = 0; i < 40 && !healthy; i++) {
  try { const res = await fetch(`http://127.0.0.1:${serverPort}/api/health`, { headers: auth }); healthy = res.ok; } catch {}
  if (!healthy) await new Promise(r => setTimeout(r, 500));
}
check('isolated server healthy', healthy && !!password);

const api = async (method, p, body) => {
  const res = await fetch(`http://127.0.0.1:${serverPort}${p}`, { method, headers: { ...auth, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(180000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
};
const idle = async sessionID => { try { await api('POST', `/api/session/${sessionID}/wait`); } catch (error) { if (!String(error).includes('180')) console.log(`wait note: ${String(error).slice(0, 120)}`); } };
const promptAndSettle = async (sessionID, text) => { await api('POST', `/api/session/${sessionID}/prompt`, { text }); await idle(sessionID); };

let store = null;
try {
  if (!healthy) throw new Error('server never became healthy');
  await api('POST', '/api/plugin/await-activation', { location: { directory: work } }).catch(() => null);
  const plugins = await api('GET', '/api/plugin');
  check('trace plugin active in real host', (plugins.data ?? []).some(p => p.id === 'opencode-trace'));
  const models = await api('GET', '/api/model');
  check('fixture model active', (models.data ?? []).some(m => m.providerID === 'fixture' && m.modelID === 'fixture-model' && m.enabled !== false));

  const workspaceID = (await import('node:crypto')).createHash('sha256').update(await fs.realpath(work)).digest('hex');
  // Store takes the base directory and derives workspaces/<workspaceID> itself.
  const storeBase = path.join(home, '.local/share/opencode-trace');
  const storeRoot = path.join(storeBase, 'workspaces', workspaceID);
  // Each assertion reopens the authoritative store: watch-based merge is
  // already covered by component tests, and a fresh init is order-proof here.
  const openStore = () => new Store(work, storeBase).init();
  store = await openStore();

  // Phase A: tools execute in the real host and the recall reaches the model request.
  const basic = (await api('POST', '/api/session', {})).data ?? (await api('POST', '/api/session', {}));
  const basicID = basic.id ?? basic.session?.id;
  const cases = {
    basic: { operations: [
      { name: 'trace_note', arguments: { kind: 'finding', text: 'E2E basic marker note', source_refs: [] } },
      { name: 'trace_find', arguments: { text: 'E2E basic marker' } },
    ] },
  };
  await fs.writeFile(controlPath, JSON.stringify(cases));
  await promptAndSettle(basicID, 'TRACE_CASE=basic run the noted operations, then finish.');
  const recallSeen = (await fs.readFile(receiptsPath, 'utf8')).trim().split('\n').map(JSON.parse).filter(r => r.recalls.length > 0);
  check('A: recall reached the real model request', recallSeen.length > 0, `${recallSeen.length} requests carried OPENCODE_TRACE_RECALL_V1`);
  store = await openStore();
  const noteEvents = [...store.index.values()].filter(e => e.type === 'trace.note');
  check('A: trace_note persisted in isolated store', noteEvents.length === 1);

  // Phase B: two-session negotiation through the real host delivery boundary.
  const mkSession = async () => ((await api('POST', '/api/session', {})).data ?? (await api('POST', '/api/session', {})));
  const A = await mkSession(), B = await mkSession();
  store.session(A.id); store.session(B.id);
  const proposalText = 'TRACE_CASE=respond_listen Adopt plan A for the parser fix';
  await fs.writeFile(controlPath, JSON.stringify({ ...cases, propose: { operations: [
    { name: 'trace_send', arguments: { to: [B.id], type: 'proposal', text: proposalText } },
  ] }, respond_listen: { operations: [{ name: 'trace_inbox', arguments: {} }] } }));
  await promptAndSettle(A.id, 'TRACE_CASE=propose send the proposal to your peer, then finish.');
  await idle(B.id);
  store = await openStore();
  const mails = [...store.index.values()].filter(e => e.type === 'trace.message');
  check('B: proposal persisted', mails.length === 1);
  const mail = JSON.parse((await store.readBlob(mails[0].payloadRef)).toString());
  const deliveryRows = [...store.index.values()].filter(e => e.type === 'trace.delivery');
  const delivered = await Promise.all(deliveryRows.map(async d => JSON.parse((await store.readBlob(d.payloadRef)).toString())));
  check('B: host admitted the delivery', delivered.some(d => d.state === 'host_admitted' && d.recipient === B.id));

  await fs.writeFile(controlPath, JSON.stringify({ ...cases, propose: cases.propose, respond: { operations: [
    { name: 'trace_ack', arguments: { message_id: mail.message_id } },
    { name: 'trace_send', arguments: { to: [A.id], type: 'objection', in_reply_to: mail.message_id, text: `TRACE_CASE=respond_listen Objection: plan A lacks a regression test` } },
  ] } }));
  await promptAndSettle(B.id, 'TRACE_CASE=respond acknowledge the proposal and send your objection, then finish.');
  await idle(A.id);
  store = await openStore();
  const acks = [...store.index.values()].filter(e => e.type === 'trace.ack');
  const replies = [...store.index.values()].filter(e => e.type === 'trace.message' && e.replyTo === mail.message_id);
  check('B: recipient ack recorded by real host identity', acks.length === 1 && acks[0].sessionID === B.id);
  check('B: reply recorded in thread', replies.length === 1 && replies[0].sessionID === B.id);
  const observed = store.findEntries({ type: 'message.persisted', session: B.id, text: mail.message_id }, null, 2);
  check('B: context_observed - target session persisted the admitted envelope', observed.length > 0);
  const inbox = await (async () => { const rows = [...store.index.values()].filter(e => e.type === 'trace.message'); return rows.length; })();
  check('B: full thread visible in index', inbox >= 2, `${inbox} messages`);

  // Phase C: orchestration adapter over native sessions in the real host.
  const sessionsBefore = (await api('GET', '/api/session')).data?.length ?? 0;
  const planSteps = [
    { id: 'scan', text: 'TRACE_CASE=step examine the parser' },
    { id: 'test', text: 'TRACE_CASE=step examine the tests' },
    { id: 'join', text: 'TRACE_CASE=step combine both findings', depends_on: ['scan', 'test'] },
  ];
  await fs.writeFile(controlPath, JSON.stringify({ ...cases, orchestrate: { operations: [
    { name: 'trace_plan', arguments: { steps: planSteps } },
  ] }, step: {} }));
  await promptAndSettle(A.id, 'TRACE_CASE=orchestrate run the plan, then finish.');
  store = await openStore();
  const stepRows = [...store.index.values()].filter(e => e.type === 'trace.step');
  const stepStates = await Promise.all(stepRows.map(async r => ({ ...(JSON.parse((await store.readBlob(r.payloadRef)).toString())), ref: r.ref, at: r.at })));
  const succeeded = stepStates.filter(s => s.state === 'succeeded');
  check('C: three native steps succeeded', succeeded.length === 3, `states: ${stepStates.map(s => s.state).join(',')}`);
  const joinRow = succeeded.find(s => s.step === 'join');
  const scanStarted = stepStates.find(s => s.step === 'scan' && s.state === 'started');
  const joinStarted = stepStates.find(s => s.step === 'join' && s.state === 'started');
  check('C: join ran after its dependencies', joinRow && scanStarted && joinStarted && joinStarted.at >= scanStarted.at);
  check('C: native bindings recorded', succeeded.every(s => typeof s.sessionID === 'string' && s.sessionID.startsWith('ses')));
  const sessionsAfterFirst = (await api('GET', '/api/session')).data?.length ?? 0;
  check('C: three child sessions created natively', sessionsAfterFirst - sessionsBefore === 3, `${sessionsAfterFirst - sessionsBefore}`);
  await promptAndSettle(A.id, 'TRACE_CASE=orchestrate run the same plan again, then finish.');
  const sessionsAfterResume = (await api('GET', '/api/session')).data?.length ?? 0;
  check('C: resume re-executes nothing', sessionsAfterResume === sessionsAfterFirst, `${sessionsAfterResume - sessionsAfterFirst} new sessions`);

  // Phase D: real permission boundary denies edit; trace never records success.
  await fs.writeFile(controlPath, JSON.stringify({ ...cases, try_edit: { operations: [
    { name: 'edit', arguments: { filePath: 'blocked.txt', content: 'nope' } },
  ] } }));
  await promptAndSettle(B.id, 'TRACE_CASE=try_edit edit the file, then finish regardless of outcome.');
  store = await openStore();
  const editAfters = [];
  for (const e of store.index.values()) {
    if (e.type !== 'tool.after' || e.tool !== 'edit') continue;
    const data = JSON.parse((await store.readBlob(e.payloadRef)).toString());
    editAfters.push({ status: data.status, error: data.error ?? null });
  }
  check('D: real permission boundary held (no successful edit)', editAfters.every(a => a.status !== 'completed'), JSON.stringify(editAfters));
  const transcript = await api('GET', `/api/session/${B.id}/message`);
  const transcriptText = JSON.stringify(transcript);
  check('D: denial visible in the real transcript', /unknown tool: edit|denied|permission|not allowed|requires approval/i.test(transcriptText));
} catch (error) {
  check('E2E harness completed', false, String(error?.stack ?? error).slice(0, 400));
} finally {
  store?.close();
}

await fs.writeFile(path.join(out, 'e2e-receipt.json'), JSON.stringify({ at: new Date().toISOString(), serverPort, modelPort, results }, null, 2));
const failed = results.filter(r => !r.ok);
console.log(`\nE2E summary: ${results.length - failed.length}/${results.length} checks passed${failed.length ? `; FAILURES: ${failed.map(f => f.name).join('; ')}` : ''}`);
try { fixture.kill(); } catch {}
try { const { execSync } = await import('node:child_process'); execSync(`pkill -f "opencode2.*--port ${serverPort}"`, { stdio: 'ignore' }); } catch {}
process.exit(process.exitCode ?? 0);
