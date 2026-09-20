// P5 install/rollback drill, fully isolated: private config, store root and
// host instance. Proves: narrow config merge preserves unrelated settings,
// the installed bundle (not the repo) activates in a real host, evidence
// written after install stays readable after rollback.
// Usage: node tests/p5_install_drill.mjs <fresh-output-dir>
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), `trace-p5-${Date.now()}`));
const home = path.join(out, 'home'), work = path.join(out, 'work');
const configPath = path.join(home, '.config', 'opencode', 'opencode.json');
const installRoot = path.join(out, 'versions-root');
const storeBase = path.join(out, 'trace-store');
const results = [];
const basePort = 41000 + Math.floor(Math.random() * 4000) * 2;
const modelPort = basePort, serverPort = basePort + 1;
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) process.exitCode = 1; };

await fs.mkdir(path.join(home, '.config', 'opencode'), { recursive: true });
await fs.mkdir(work, { recursive: true });
// Pre-existing config that must survive install and rollback untouched.
// It already carries the provider/model a real user config would have.
await fs.writeFile(configPath, JSON.stringify({
  $schema: 'https://opencode.ai/config.json',
  share: 'disabled',
  model: 'fixture/fixture-model',
  provider: { fixture: { npm: '@ai-sdk/openai-compatible', name: 'Fixture',
    options: { baseURL: `http://127.0.0.1:${modelPort}/v1`, apiKey: 'fixture-key' },
    models: { 'fixture-model': { name: 'Fixture Model' } } } },
  plugins: [{ package: '/nonexistent/unrelated-plugin', options: { keep: true } }],
  command: { drill: { description: 'user command', template: 'hello' } },
}, null, 2));

const runCli = async (args) => {
  const res = await spawnOutput(process.execPath, [path.join(repo, 'install', 'cli.js'), ...args]);
  return { code: res.code, json: (() => { try { return JSON.parse(res.stdout); } catch { return null; } })(), stdout: res.stdout, stderr: res.stderr };
};
const spawnOutput = (cmd, args, options = {}) => new Promise(resolve => {
  const child = spawn(cmd, args, { cwd: options.cwd ?? work, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => stdout += d);
  child.stderr.on('data', d => stderr += d);
  child.on('close', code => resolve({ code, stdout, stderr }));
});

const controlPath = path.join(out, 'control.json'), receiptsPath = path.join(out, 'receipts.jsonl');
await fs.writeFile(controlPath, JSON.stringify({ default: { compact: 'fixture' } }));
await fs.writeFile(receiptsPath, '');
const fixture = spawn('python3', [path.join(repo, 'tests', 'scripted_provider.py'), '--port', String(modelPort), '--control', controlPath, '--receipts', receiptsPath], { stdio: 'ignore' });
fixture.unref();
await new Promise(r => setTimeout(r, 1200));

try {
  // 1. Install through the real CLI into the isolated root.
  const install = await runCli(['install', '--config', configPath, '--root', installRoot, '--store-root', path.join(storeBase, 'scoped')]);
  check('installer exit 0', install.code === 0, install.stderr.slice(0, 200));
  const receipt = install.json;
  check('receipt prepared->installed', receipt?.status === 'installed' && receipt.beforeHash, receipt?.id);
  const after = JSON.parse(await fs.readFile(configPath, 'utf8'));
  check('unrelated plugin preserved', JSON.stringify(after.plugins?.[0]) === JSON.stringify({ package: '/nonexistent/unrelated-plugin', options: { keep: true } }));
  check('user command preserved', after.command?.drill?.template === 'hello');
  check('trace entry appended last with scoped store', after.plugins?.at(-1)?.package === receipt.installedPath && after.plugins.at(-1).options.storeRoot === path.join(storeBase, 'scoped'));

  // 2. Boot a real isolated host from the installed config itself: the
  // installer entry (with scoped store) is the only trace registration.
  const serveLog = path.join(out, 'serve.log');
  {
    const handle = await fs.open(serveLog, 'w');
    const child = spawn('opencode2', ['serve', '--hostname', '127.0.0.1', '--port', String(serverPort), '--log-level', 'warn'],
      { cwd: work, env: { ...process.env, HOME: home }, stdio: ['ignore', handle.fd, handle.fd] });
    child.unref();
    await handle.close();
  }
  let password = null;
  for (let i = 0; i < 40 && !password; i++) {
    await new Promise(r => setTimeout(r, 500));
    try { password = (await fs.readFile(serveLog, 'utf8')).match(/server password (\S+)/)?.[1] ?? null; } catch {}
  }
  const auth = { Authorization: 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64') };
  let healthy = false;
  for (let i = 0; i < 40 && !healthy; i++) {
    try { healthy = (await fetch(`http://127.0.0.1:${serverPort}/api/health`, { headers: auth })).ok; } catch {}
    if (!healthy) await new Promise(r => setTimeout(r, 500));
  }
  check('isolated host healthy on installed bundle', healthy);
  const api = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${serverPort}${p}`, { method, headers: { ...auth, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(180000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };
  await api('POST', '/api/plugin/await-activation', { location: { directory: work } }).catch(() => null);
  const plugins = await api('GET', '/api/plugin');
  check('installed bundle activated in real host', (plugins.data ?? []).some(p => p.id === 'opencode-trace'));

  // 3. Write real evidence through the host (basic tool roundtrip). The
  // installer entry scoped the plugin's store base to <storeBase>/scoped.
  const session = (await api('POST', '/api/session', {})).data ?? (await api('POST', '/api/session', {}));
  await fs.writeFile(controlPath, JSON.stringify({ basic: { operations: [
    { name: 'trace_note', arguments: { kind: 'finding', text: 'P5 pre-rollback evidence', source_refs: [] } },
  ] } }));
  await api('POST', `/api/session/${session.id}/prompt`, { text: 'TRACE_CASE=basic record the note, then finish.' });
  try { await api('POST', `/api/session/${session.id}/wait`); } catch {}
  const store = await new Store(work, path.join(storeBase, 'scoped')).init();
  const notes = [...store.index.values()].filter(e => e.type === 'trace.note');
  check('evidence written through installed bundle', notes.length === 1);
  const noteRef = notes[0]?.ref;
  const expandedBefore = noteRef ? await store.expand(noteRef) : null;
  store.close();

  // 4. Rollback by receipt: config restored, everything else untouched.
  const rollback = await runCli(['rollback', '--manifest', receipt.manifest]);
  check('rollback exit 0', rollback.code === 0, rollback.stderr.slice(0, 200));
  const restored = JSON.parse(await fs.readFile(configPath, 'utf8'));
  check('rollback removed exactly the trace entries', Array.isArray(restored.plugins) && restored.plugins.length === 1 && restored.plugins[0].package === '/nonexistent/unrelated-plugin');
  check('rollback preserved user command', restored.command?.drill?.template === 'hello');
  check('rollback kept scoped store contents', await fs.stat(path.join(storeBase, 'scoped')).then(() => true).catch(() => false));
  const reopened = await new Store(work, path.join(storeBase, 'scoped')).init();
  const expandedAfter = noteRef ? await reopened.expand(noteRef) : null;
  check('post-rollback evidence still exact', !!expandedAfter && expandedAfter.sha256 === expandedBefore.sha256 && expandedAfter.exact_utf8 === expandedBefore.exact_utf8);
  const foundAfterRollback = reopened.findEntries({ text: 'P5 pre-rollback evidence' }, null, 8);
  check('post-rollback evidence still discoverable', foundAfterRollback.length >= 1 && foundAfterRollback.some(e => e.type === 'trace.note'),
    `${foundAfterRollback.length} matching events`);
  reopened.close();
  const rb = JSON.parse((await fs.readFile(path.join(path.dirname(receipt.manifest), 'rollback.json'), 'utf8')));
  check('rollback receipt recorded', rb.status === 'rolled_back');
} catch (error) {
  check('P5 drill completed', false, String(error?.stack ?? error).slice(0, 400));
} finally {
  try { fixture.kill(); } catch {}
  try { const { execSync } = await import('node:child_process'); execSync(`pkill -f "opencode2.*--port ${serverPort}"`, { stdio: 'ignore' }); } catch {}
}
await fs.writeFile(path.join(out, 'p5-receipt.json'), JSON.stringify({ at: new Date().toISOString(), serverPort, modelPort, results }, null, 2));
const failed = results.filter(r => !r.ok);
console.log(`\nP5 summary: ${results.length - failed.length}/${results.length} checks passed${failed.length ? `; FAILURES: ${failed.map(f => f.name).join('; ')}` : ''}`);
process.exit(process.exitCode ?? 0);
