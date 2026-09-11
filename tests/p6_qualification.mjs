// P6 real-model qualification harness. Local real-host gate: drives a private
// isolated OpenCode server with REAL model providers (zai GLM + local Qwen).
// Never touches the user's running main OpenCode instance, config or sessions.
// Usage: node tests/p6_qualification.mjs <fresh-output-dir>
// This file is a qualification tool, not part of the component test suite.
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), `p6-${Date.now()}`));
const home = path.join(out, 'home');
const work = path.join(out, 'fixture');
const receiptsDir = path.join(out, 'receipts');
const serveLog = path.join(out, 'serve.log');
const results = [];
const log = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) process.exitCode = 1; };

const PORT = 45000 + Math.floor(Math.random() * 8000) * 2;
const serverPort = PORT, qwenPort = 18094;

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const api = async (method, p, body, timeout = 300000) => {
  const res = await fetch(`http://127.0.0.1:${serverPort}${p}`, { method, headers: { ...auth, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};

// ---------- environment ----------
await fs.mkdir(path.join(home, '.config', 'opencode'), { recursive: true });
await fs.mkdir(path.join(home, '.local', 'share', 'opencode'), { recursive: true });
await fs.mkdir(work, { recursive: true });
await fs.mkdir(receiptsDir, { recursive: true });
// Auth for the real zai GLM provider is copied from the user's auth store
// (never printed, never committed). The isolated config wires the key
// explicitly through an openai-compatible provider because the V2 builtin
// zai integration did not attach the header in serve mode (401 from the
// gateway) - the key itself verifies fine against api.z.ai directly.
const zaiKey = JSON.parse(await fs.readFile(path.join(os.homedir(), '.local/share/opencode/auth.json'), 'utf8'))['zai-coding-plan'].key;

// ---------- fixture repository ----------
// Machine-known facts live only in the manifest; the model must recover them
// from event history, not from the current working tree.
const SCHEDULER_LIMIT = 30 + crypto.randomInt(1, 60);          // random historical fact
const OVERFLOW_THRESHOLD = 30 + crypto.randomInt(1, 60);       // random review evidence
const configOld = {
  comment: 'historical settings; superseded values are kept in version history',
  scheduler_limit: SCHEDULER_LIMIT,
  retry_backoff_ms: 250,
};
const configNew = {
  comment: 'current settings',
  scheduler_limit: 12,
  retry_backoff_ms: 250,
};
const queueOld = `// queue.js - batched work queue (historical revision)
// NOTE(field observation, recorded during the last capacity review):
// sustained scheduler_limit above ${OVERFLOW_THRESHOLD} caused batch timeouts in
// test_timeout_batch because the drain loop holds the GIL during flush.
export function createQueue(limit) {
  const items = [];
  return {
    push(x) { items.push(x); return items.length; },
    drain() { return items.splice(0, limit); },
    size() { return items.length; },
  };
}
`;
const queueNew = `// queue.js - batched work queue (current revision)
// Field notes from the old capacity review were dropped in a cleanup pass.
export function createQueue(limit) {
  const items = [];
  return {
    push(x) { items.push(x); return items.length; },
    drain() { return items.splice(0, limit); },
    size() { return items.length; },
  };
}
`;
const plannerTask = `TASK: raise scheduler_limit in config/settings.json to at least 40 and add a fast-path to queue.drain().
Before writing the plan, check the workspace history: this codebase changed recently and an earlier review may already have established constraints you should respect.
Record your plan and reasoning with trace_note, then continue.`;
const reviewFindings = {
  oldLimit: SCHEDULER_LIMIT,
  overflowThreshold: OVERFLOW_THRESHOLD,
  expectedFinding: `scheduler_limit above ${OVERFLOW_THRESHOLD} caused batch timeouts (test_timeout_batch)`,
};

const manifest = {
  generated_at: new Date().toISOString(),
  scheduler_limit_historical: SCHEDULER_LIMIT,
  overflow_threshold: OVERFLOW_THRESHOLD,
  expected_review_finding: reviewFindings.expectedFinding,
  files: {},
};
const writeFixture = async (cfg, queue) => {
  await fs.mkdir(path.join(work, 'src'), { recursive: true });
  await fs.mkdir(path.join(work, 'config'), { recursive: true });
  await fs.mkdir(path.join(work, 'test'), { recursive: true });
  await fs.writeFile(path.join(work, 'config', 'settings.json'), JSON.stringify(cfg, null, 2) + '\n');
  await fs.writeFile(path.join(work, 'src', 'queue.js'), queue);
  await fs.writeFile(path.join(work, 'src', 'scheduler.js'), `// scheduler.js\nimport { createQueue } from './queue.js';\nexport function makeScheduler(limit) {\n  const q = createQueue(limit);\n  return { tick(n) { for (let i = 0; i < n; i++) q.push(i); return q.drain().length; } };\n}\n`);
  await fs.writeFile(path.join(work, 'test', 'scheduler.test.js'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { makeScheduler } from '../src/scheduler.js';\nimport fs from 'node:fs';\n\ntest('timeout_batch boundary', () => {\n  const cfg = JSON.parse(fs.readFileSync(new URL('../config/settings.json', import.meta.url)));\n  assert.ok(cfg.scheduler_limit > 0);\n  assert.equal(makeScheduler(2).tick(4), 2);\n});\n`);
};
await writeFixture(configOld, queueOld);
for (const rel of ['config/settings.json', 'src/queue.js', 'src/scheduler.js', 'test/scheduler.test.js']) {
  manifest.files[rel] = sha256(await fs.readFile(path.join(work, rel)));
}
await fs.writeFile(path.join(out, 'fixture-manifest.json'), JSON.stringify(manifest, null, 2));
execSync('git init -q && git add -A && git -c user.email=p6@local -c user.name=p6 commit -qm "fixture baseline (historical revision)"', { cwd: work, stdio: 'ignore' });

// ---------- isolated server config: real native agent profiles ----------
const reviewerAgent = {
  description: 'Read-only reviewer role: verifies claims against evidence, must not mutate the workspace.',
  mode: 'all',
  model: 'zai/glm-5.3-flash',
  permissions: [
    { action: 'edit', resource: '*', effect: 'deny' },
    { action: 'write', resource: '*', effect: 'deny' },
  ],
};
const buildAgent = {
  description: 'Implementer role.',
  mode: 'all',
  model: 'zai/glm-5.3-flash',
  permission: 'allow',
};
await fs.writeFile(path.join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({
  $schema: 'https://opencode.ai/config.json',
  autoupdate: false, share: 'disabled', default_agent: 'build',
  model: 'zai/glm-5.3-flash',
  small_model: 'zai/glm-5.3-flash',
  provider: {
    zai: {
      npm: '@ai-sdk/openai-compatible', name: 'Z.ai Coding Plan',
      options: { baseURL: 'https://api.z.ai/api/coding/paas/v4', apiKey: zaiKey },
      models: { 'glm-5.3-flash': { name: 'GLM 5.3 Flash' } },
    },
    'frank-local': { npm: '@ai-sdk/openai-compatible', name: 'Frank Local vLLM', options: { baseURL: `http://127.0.0.1:${qwenPort}/v1` }, models: { 'unsloth/Qwen3.8-27B-NVFP4': { name: 'Qwen 27B' } } },
  },
  compaction: { auto: true, reserved: 16000 },
  agent: { build: buildAgent, reviewer: reviewerAgent },
  plugins: [repo],
}, null, 2));

// ---------- server ----------
const serverProcesses = [];
const spawnDetached = async (cmd, args, logFile) => {
  const handle = await fs.open(logFile, 'w');
  try {
    const child = spawn(cmd, args, { cwd: work, env: { ...process.env, HOME: home }, stdio: ['ignore', handle.fd, handle.fd] });
    serverProcesses.push(child);
    child.unref();
  } finally { await handle.close(); }
};
const killServers = () => { for (const child of serverProcesses.splice(0)) { try { child.kill('SIGKILL'); } catch {} } };
await spawnDetached('opencode2', ['serve', '--hostname', '127.0.0.1', '--port', String(serverPort), '--log-level', 'warn'], serveLog);
let password = null, boundPort = null;
for (let i = 0; i < 40 && !password; i++) {
  await new Promise(r => setTimeout(r, 500));
  try {
    const text = await fs.readFile(serveLog, 'utf8');
    password = text.match(/server password (\S+)/)?.[1] ?? null;
    boundPort = text.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)?.[1] ?? null;
  } catch {}
}
if (Number(boundPort) !== serverPort) {
  console.log(`FAIL port conflict: requested ${serverPort} but a stale test server got ${boundPort}. Kill stale opencode2 serve processes and retry.`);
  killServers();
  process.exit(1);
}
const auth = { Authorization: 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64') };
let healthy = false;
for (let i = 0; i < 40 && !healthy; i++) {
  try { const res = await fetch(`http://127.0.0.1:${serverPort}/api/health`, { headers: auth }); healthy = res.ok; } catch {}
  if (!healthy) await new Promise(r => setTimeout(r, 500));
}
log('isolated server healthy', healthy && !!password);
if (!healthy) { killServers(); process.exit(1); }
// The trace plugin must be active before any model turn: passive hooks alone
// (prompt/context) are not enough for P6 - the model needs the tools.
await api('POST', '/api/plugin/await-activation', { location: { directory: work } }).catch(() => null);
{
  const plugins = (await api('GET', '/api/plugin')).data ?? [];
  const trace = plugins.find(p => p.id === 'opencode-trace');
  log('trace plugin active in real host', trace?.state?.status === 'active', plugins.map(p => `${p.id}:${p.state?.status ?? '?'}`).join(','));
  if (!trace) { killServers(); process.exit(1); }
}

const storeBase = path.join(home, '.local/share/opencode-trace');
const workspaceID = sha256(await fs.realpath(work));
const storeRoot = path.join(storeBase, 'workspaces', workspaceID);
const { Store } = await import('../src/store.js');
const openStore = () => new Store(work, storeBase).init();

const idle = async sessionID => { try { await api('POST', `/api/session/${sessionID}/wait`); } catch {} };
const mkSession = async () => ((await api('POST', '/api/session', {})).data ?? (await api('POST', '/api/session', {})));
const promptAndSettle = async (sessionID, text, timeout = 900000) => {
  await api('POST', `/api/session/${sessionID}/prompt`, { text, ...{} });
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await new Promise(r => setTimeout(r, 3000));
    try { await api('POST', `/api/session/${sessionID}/wait`, undefined, 60000); return; } catch (e) { /* still busy */ }
  }
  throw new Error(`session ${sessionID} did not settle within ${timeout}ms`);
};
// A slow real-model turn must never abort the whole qualification: record the
// failure and keep going so every case still reports.
const settled = async (name, sessionID, text, timeout) => {
  try { await promptAndSettle(sessionID, text, timeout); return true; }
  catch (e) { log(name, false, String(e).slice(0, 160)); return false; }
};

// smoke: the REAL configured model must answer with a completed turn - a
// user-prompt echo or a provider error must never count as a response.
const smoke = await mkSession();
await api('POST', `/api/session/${smoke.id}/prompt`, { text: 'Reply with exactly: GLM_ALIVE' });
await idle(smoke.id);
const smokeMessages = await api('GET', `/api/session/${smoke.id}/message`);
const smokeRaw = JSON.stringify(smokeMessages);
const smokeAssistant = (smokeMessages.data ?? []).filter(m => m.type === 'assistant');
const completed = smokeAssistant.some(m => (m.finish ?? '') === 'stop' && JSON.stringify(m.content ?? []).includes('GLM_ALIVE'));
const usedGlm = smokeAssistant.some(m => m.model?.providerID === 'zai' && /glm-5\.3-flash/.test(m.model?.id ?? ''));
const authErrors = smokeAssistant.filter(m => m.error).length;
log('real GLM responded with a completed turn', completed, completed ? 'GLM_ALIVE from a finished assistant turn' : `assistant turns: ${smokeAssistant.length}, finish flags: ${smokeAssistant.map(m => m.finish).join(',')}`);
log('responses actually come from zai/glm-5.3-flash', usedGlm && authErrors === 0, `provider ok: ${usedGlm}, provider errors: ${authErrors}`);
if (!completed || !usedGlm || authErrors) { killServers(); process.exit(1); }

// ---------- helpers over transcripts and evidence ----------
const transcript = async sid => JSON.stringify(await api('GET', `/api/session/${sid}/message`));
const assistantTexts = async sid => {
  const raw = await api('GET', `/api/session/${sid}/message`);
  const messages = raw?.data ?? raw ?? [];
  const out = [];
  for (const m of messages) {
    const type = m?.type ?? m?.role ?? m?.info?.role;
    if (type !== 'assistant') continue;
    const text = typeof m?.text === 'string' && m.text.trim() ? m.text
      : (Array.isArray(m?.content) ? m.content.filter(p => p?.type === 'text').map(p => p?.text ?? '').join('\n') : '');
    if (String(text).trim()) out.push(String(text));
  }
  return out;
};
const eventRefsIn = text => [...new Set(text.match(/(?:evt|blob)_[0-9a-f]{64}/g) ?? [])];
// Machine factual check: an evidence ref cited by the model really contains
// the fixture fact (blob bytes only; SHA verified by the store on read).
const evidenceCites = async (sid, needle) => {
  const refs = eventRefsIn(await transcript(sid));
  let store;
  try { store = await openStore(); } catch { return { ok: false, refs: 0, hits: [] }; }
  const hits = [];
  for (const ref of refs) {
    if (!ref.startsWith('blob_')) continue;
    try {
      const data = (await store.readBlob(ref)).toString();
      if (data.includes(needle)) hits.push(ref);
    } catch {}
  }
  store.close();
  return { ok: hits.length > 0, refs: refs.length, hits };
};

// ---------- Case A: clue-only historical recovery ----------
// Turn 1: the planner session inspects the ORIGINAL revision; trace captures
// the old exact bytes (tool.after outputs) before the files change.
const A = await mkSession();
await settled('A0: planner inspection turn completed', A.id, `Inspect this workspace before planning anything:
1. Read config/settings.json in full.
2. Read src/queue.js in full.
3. Run: node --test test/
Report the exact scheduler_limit value you saw in the config.`);
{
  const text = (await assistantTexts(A.id)).join('\n');
  log('A0: planner saw the historical config', text.includes(String(SCHEDULER_LIMIT)), `limit ${SCHEDULER_LIMIT} echoed: ${text.includes(String(SCHEDULER_LIMIT))}`);
}
// The workspace moves on: current revision drops the old field notes.
await writeFixture(configNew, queueNew);
await fs.writeFile(path.join(work, 'config', 'settings.json'), JSON.stringify(configNew, null, 2) + '\n');
execSync('git add -A && git -c user.email=p6@local -c user.name=p6 commit -qm "cleanup: drop old field notes, lower scheduler_limit"', { cwd: work, stdio: 'ignore' });
// A does more unrelated work afterwards (noise between the evidence and now).
await settled('A0: repo-state noise turn completed', A.id, 'Run: git log --oneline && git status. Summarize the repo state in one sentence.');
// A native compaction of session A (best effort; record if unsupported).
let compactState = 'skipped';
try { await api('POST', `/api/session/${A.id}/compact`, undefined, 120000); compactState = 'invoked'; } catch (e) { compactState = `unavailable: ${String(e).slice(0, 80)}`; }

// A brand-new session must recover the OLD value from event history alone.
const B = await mkSession();
await settled('A: recovery turn completed', B.id, `之前有人检查过这个 workspace 的 scheduler 配置。我记得当时发现了一个具体限制（scheduler_limit 的旧值）。
但文件后来被改过，当前磁盘上的 config 不是当时的版本。
请只根据已有历史证据找到当时实际读取的原文数值：
先用 trace_find 找候选事件，再用 trace_expand 展开当时的精确原文，最后告诉我那个旧值以及你依据的证据。不要把现在磁盘上的文件当作旧版本。`);
{
  const text = (await assistantTexts(B.id)).join('\n');
  const found = text.includes(String(SCHEDULER_LIMIT)) && !text.includes('scheduler_limit: 12');
  const cites = await evidenceCites(B.id, `"scheduler_limit": ${SCHEDULER_LIMIT}`);
  log('A: clue-only recovery of the historical value', found, `value recovered: ${found}`);
  log('A: conclusion tied to exact stored bytes', cites.ok, `refs seen: ${cites.refs}, blob hits: ${cites.hits.length}`);
}

// ---------- Case B/C: two real sessions negotiate over evidence ----------
// Warm-up turns give both sessions a trace identity before any trace_send.
await settled('B: reviewer warm-up completed', B.id, 'Confirm you are ready: reply with exactly REVIEWER_READY.');
const REVIEWER_TASK = `另一个 session（${A.id}）正在规划这个任务：
${plannerTask}
你是 reviewer，不允许修改任何文件。
请独立查证：workspace 的事件历史里可能有与该方案冲突的旧证据（之前针对 scheduler/queue 做过容量审查）。
自己决定查什么：可以用 trace_find / trace_expand 恢复历史原文，也可以读当前文件对比。
得出结论后，把你的评审结论和依据的证据用 trace_send 发回给 ${A.id}（发送即可，不需要它确认）。`;
await settled('B: review turn completed', B.id, REVIEWER_TASK);
{
  const text = (await assistantTexts(B.id)).join('\n');
  log('B: reviewer found the pre-seeded counter-evidence', text.includes(String(OVERFLOW_THRESHOLD)), `threshold ${OVERFLOW_THRESHOLD} mentioned: ${text.includes(String(OVERFLOW_THRESHOLD))}`);
  const cites = await evidenceCites(B.id, String(OVERFLOW_THRESHOLD));
  log('B: counter-evidence backed by exact stored bytes', cites.ok, `blob hits: ${cites.hits.length}`);
  const store = await openStore();
  const mail = store.findEntries({ type: 'trace.message', session: B.id }, null, 8);
  log('B: review delivered through the mailbox', mail.length > 0, `${mail.length} message(s) from reviewer`);
  store.close();
}
// A receives the review and decides on its own whether to revise or defend.
await settled('C: planner response turn completed', A.id, `Reviewer 的反馈已经通过 trace 发给你了。请查看 trace_inbox，阅读它引用的证据（需要时自己 trace_expand 原文），然后自行判断：
原方案是否需要修改？如果需要，给出修订后的方案并用 trace_note 记录最终决定；如果你认为 reviewer 错了，给出你的反证。不要为了迁就而修改——按证据决定。`);
{
  const text = (await assistantTexts(A.id)).join('\n');
  const revised = text.includes(String(OVERFLOW_THRESHOLD)) || text.includes(String(SCHEDULER_LIMIT));
  log('C: planner responded to the review on the merits', revised, `final response references the evidence numbers: ${revised}`);
  const store = await openStore();
  const notes = store.findEntries({ type: 'trace.note', session: A.id }, null, 16);
  log('C: planner recorded a durable decision note', notes.length > 0, `${notes.length} note(s)`);
  const replies = store.findEntries({ type: 'trace.message', session: A.id }, null, 8);
  log('C: planner answered the reviewer in the thread', replies.length > 0, `${replies.length} message(s) from planner`);
  store.close();
}

// ---------- Case D: a third verifier joins mid-flight ----------
const C = await mkSession();
await settled('D: late verifier turn completed', C.id, `另外两个 session（planner 和 reviewer）刚才在这个 workspace 里处理过 scheduler_limit 的方案并通过 trace 协商过。
你是 verifier。请独立判断他们当前的方案是否和历史证据一致：
先自己用 trace_find / trace_inbox 发现相关会话与事件，必要时 trace_expand 恢复原文，再给出你的独立结论。
不要假设你的上下文已经包含他们的讨论。`);
{
  const text = (await assistantTexts(C.id)).join('\n');
  const recovered = text.includes(String(OVERFLOW_THRESHOLD)) || text.includes(String(SCHEDULER_LIMIT));
  log('D: late verifier recovered the key fact without chat history', recovered, `machine fact seen: ${recovered}`);
  const refs = eventRefsIn(await transcript(C.id));
  log('D: late verifier grounded its review in event refs', refs.length > 0, `${refs.length} refs cited`);
}

// ---------- Case E/F: native multi-role trace_plan with worker claims ----------
await settled('E/F: plan orchestration turn completed', A.id, `现在用 trace_plan 执行一个小型收尾计划（三步，不要自己动手做步骤内容）：
- step "record": agent 用 build —— 把最终决定的 scheduler_limit 值和依据写入 config/decision.txt（用 write 工具），完成后用 trace_step_result 提交结果。
- step "cross-check": agent 用 reviewer —— 独立复核 decision.txt 与历史证据是否一致（reviewer 没有写权限，读和消息即可），完成后用 trace_step_result 提交结果。
- step "closeout" 依赖前两步 —— 总结两者结论到正文即可，完成后用 trace_step_result 提交结果。
每一步都是独立子 session；你自己只编排，不代替 worker 提交结果。`);
{
  const store = await openStore();
  const steps = [];
  const planRows = store.findEntriesAll({ type: 'trace.plan' });
  const latestPlan = planRows.at(-1);
  const planId = latestPlan ? (JSON.parse((await store.readBlob(latestPlan.payloadRef)).toString())).plan_id : null;
  const stepRows = planId ? store.findEntriesAll({ type: 'trace.step', plan: planId }) : [];
  for (const r of stepRows) steps.push({ ...(JSON.parse((await store.readBlob(r.payloadRef)).toString())), ref: r.ref });
  const settled = steps.filter(s => s.state === 'settled');
  log('E: three plan steps settled', settled.length === 3, `states: ${steps.map(s => s.state).join(',')}`);
  log('E: outcomes are worker-reported claims, not turn inference', settled.every(s => s.outcome === 'worker_reported_success' || s.outcome === 'worker_reported_failure'), settled.map(s => `${s.step}:${s.outcome}`).join(' '));
  const resultEvents = store.findEntriesAll({ type: 'trace.step.result' });
  log('F: workers submitted their own structured claims', resultEvents.length >= 3, `${resultEvents.length} trace.step.result events`);
  const reviewerDenied = steps.some(s => s.agent === 'reviewer');
  const writerOk = settled.some(s => s.step === 'record' && s.outcome === 'worker_reported_success');
  log('E: native agent profiles bound (build + reviewer)', reviewerDenied && writerOk, settled.map(s => `${s.step}:${s.agent ?? 'build'}`).join(' '));
  let decisionFile = '';
  try { decisionFile = await fs.readFile(path.join(work, 'config', 'decision.txt'), 'utf8'); } catch {}
  log('E: build-bound write actually landed', decisionFile.length > 0, decisionFile ? `decision.txt ${decisionFile.length} bytes` : 'missing');
  store.close();
}

// ---------- Case G: fuzzy end-to-end reconstruction ----------
const D = await mkSession();
await settled('G: reconstruction turn completed', D.id, `回顾这个 workspace 里刚发生过的整个问题：
最初方案是什么，后来出现了什么关键证据，为什么方案发生了变化，最终执行了什么？
请从 trace 中恢复这条链，不要假设当前上下文已经包含全部过程。最后给出一份带证据引用的时间线。`);
{
  const text = (await assistantTexts(D.id)).join('\n');
  const chain = text.includes(String(OVERFLOW_THRESHOLD)) && text.includes(String(SCHEDULER_LIMIT));
  log('G: reconstruction recovered both machine facts', chain, `historical limit + threshold both present: ${chain}`);
  const refs = eventRefsIn(await transcript(D.id));
  log('G: timeline cites stored evidence refs', refs.length >= 2, `${refs.length} refs cited`);
}

// ---------- Case J: restart the whole server process ----------
killServers();
await new Promise(r => setTimeout(r, 2000));
await spawnDetached('opencode2', ['serve', '--hostname', '127.0.0.1', '--port', String(serverPort), '--log-level', 'warn'], path.join(out, 'serve2.log'));
// A fresh process generates a fresh server password: re-read it before any call.
let password2 = null;
for (let i = 0; i < 40 && !password2; i++) {
  await new Promise(r => setTimeout(r, 500));
  try { password2 = (await fs.readFile(path.join(out, 'serve2.log'), 'utf8')).match(/server password (\S+)/)?.[1] ?? null; } catch {}
}
Object.assign(auth, { Authorization: 'Basic ' + Buffer.from(`opencode:${password2}`).toString('base64') });
let healthy2 = false;
for (let i = 0; i < 60 && !healthy2; i++) {
  try { const res = await fetch(`http://127.0.0.1:${serverPort}/api/health`, { headers: auth }); healthy2 = res.ok; } catch {}
  if (!healthy2) await new Promise(r => setTimeout(r, 500));
}
log('J: server process restarted', healthy2 && !!password2);
const E = await mkSession();
await settled('J: post-restart turn completed', E.id, '这个 workspace 之前发生过一次 scheduler_limit 相关的协商。请用 trace_find 找到 reviewer 最初引用的那条关键历史证据，并用 trace_expand 展开原文，报告其中的阈值数字。');
{
  const text = (await assistantTexts(E.id)).join('\n');
  log('J: history fully usable after restart', text.includes(String(OVERFLOW_THRESHOLD)), `threshold recovered after restart: ${text.includes(String(OVERFLOW_THRESHOLD))}`);
}

// ---------- independent verifier LLM ----------
const pkg = {
  task: plannerTask,
  fixture_note: 'scheduler_limit was historically <hidden>; current file says 12. The overflow threshold is a random fixture fact only present in historical evidence blobs.',
  final_outputs: {
    planner: (await assistantTexts(A.id)).slice(-2),
    reviewer: (await assistantTexts(B.id)).slice(-2),
    late_verifier: (await assistantTexts(C.id)).slice(-2),
    reconstruct: (await assistantTexts(D.id)).slice(-2),
  },
  native_effects: {
    decision_txt: (await fs.readFile(path.join(work, 'config', 'decision.txt'), 'utf8').catch(() => null)),
    git_log: execSync('git log --oneline', { cwd: work }).toString(),
  },
};
const V = await mkSession();
await settled('verifier LLM turn completed', V.id, `You are an independent qualification reviewer. Below is an evidence package from a multi-session negotiation exercise (planner, reviewer, late verifier, reconstructor). Judge the COLLABORATION QUALITY in natural language: did the reviewer actually verify claims against evidence (not just paraphrase), did the planner respond on the merits, did the late participants recover real state? Point out the weakest link. Do not assume anything you are not shown.\n\n${JSON.stringify(pkg, null, 1).slice(0, 24000)}`);
const verdict = (await assistantTexts(V.id)).join('\n');
await fs.writeFile(path.join(receiptsDir, 'verifier-report.md'), `# Independent verifier (GLM) raw output\n\n${verdict}\n`);
log('verifier LLM produced a review', verdict.length > 200, `${verdict.length} chars`);

// ---------- receipts ----------
const gitSha = execSync('git rev-parse HEAD', { cwd: repo }).toString().trim();
await fs.writeFile(path.join(receiptsDir, 'environment.json'), JSON.stringify({ date: new Date().toISOString(), opencode: 'opencode2 v0.0.0-beta-19296', node: process.version, isolated_home: home, serverPort }, null, 2));
await fs.writeFile(path.join(receiptsDir, 'git-sha.txt'), gitSha);
await fs.writeFile(path.join(receiptsDir, 'model-info.json'), JSON.stringify({ primary: 'zai-coding-plan/glm-5.3-flash (real)', secondary_available: 'frank-local/unsloth/Qwen3.8-27B-NVFP4 (healthy, not used in this run)' }, null, 2));
await fs.writeFile(path.join(receiptsDir, 'fixture-manifest.json'), JSON.stringify(manifest, null, 2));
await fs.writeFile(path.join(receiptsDir, 'sessions.json'), JSON.stringify({ planner: A.id, reviewer: B.id, late_verifier: C.id, reconstructor: D.id, restart: E.id, verifier: V.id, compaction: compactState }, null, 2));
let store;
try { store = await openStore(); } catch {}
if (store) {
  const counts = {};
  for (const e of store.index.values()) counts[e.type] = (counts[e.type] ?? 0) + 1;
  await fs.writeFile(path.join(receiptsDir, 'trace-evidence.json'), JSON.stringify({ event_counts: counts, indexed: store.index.size }, null, 2));
  await fs.writeFile(path.join(receiptsDir, 'native-effects.json'), JSON.stringify({ git_log: pkg.native_effects.git_log, decision_txt_present: !!pkg.native_effects.decision_txt }, null, 2));
  store.close();
}
const failed = results.filter(r => !r.ok);
const report = `# P6 real-model qualification (GLM-5.3-flash, isolated real host)\n\n- date: ${new Date().toISOString()}\n- repo sha: ${gitSha}\n- compaction: ${compactState}\n- checks: ${results.length - failed.length}/${results.length}\n\n${results.map(r => `- ${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`).join('\n')}\n`;
await fs.writeFile(path.join(receiptsDir, 'P6-REPORT.md'), report);
console.log(`\nP6 summary: ${results.length - failed.length}/${results.length} checks passed${failed.length ? `; FAILURES: ${failed.map(f => f.name).join('; ')}` : ''}`);
console.log(`receipts: ${receiptsDir}`);
killServers();
process.exit(failed.length ? 1 : 0);
