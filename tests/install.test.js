import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { install, rollback } from '../install/cli.js';
import { parseConfig, addEntry, removeEntry } from '../install/config.js';

const entry = { package: '/local/plugin', options: { _opencodeTraceInstaller: 'opencode-trace-v1' } };
test('JSONC preserves comments, foreign tools and permissions including deny', () => {
  for (const text of ['{}', '{// note\n "permissions":[{"tool":"shell","action":"deny"}],}', '{"plugins":["foreign",],"provider":{"x":"https://example.org/a//b"}}', '{"plugins": [], "agents": {"build":{}}, "mcp":{"x":{}}}']) {
    const before = parseConfig(text).value, after = addEntry(text, entry);
    assert.deepEqual(parseConfig(after).value, { ...before, plugins: [...(before.plugins ?? []), entry] });
    assert.deepEqual(parseConfig(removeEntry(after, entry, 'plugins' in before)).value, before);
    if (text.includes('// note')) assert.ok(after.includes('// note'));
  }
});

test('installer backups verified, narrow rollback preserves subsequent changes and history', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-install-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'opencode.jsonc'), root = path.join(dir, 'data');
  const original = '{\n// keep this comment\n"plugins": ["foreign"], "permissions": [{"tool":"shell","action":"deny"}]\n}\n';
  await fs.writeFile(config, original);
  const first = await install({ config, root });
  assert.equal((await fs.readFile(path.join(path.dirname(first.manifest), 'before-config'))).toString(), original);
  assert.equal((await rollback(first.manifest)).exact, true);
  assert.equal(await fs.readFile(config, 'utf8'), original);
  const second = await install({ config, root });
  let changed = await fs.readFile(config, 'utf8');
  changed = changed.replace('"foreign"', '"foreign", "new-unrelated"');
  await fs.writeFile(config, changed);
  await fs.mkdir(path.join(root, 'workspaces', 'history'), { recursive: true });
  await fs.writeFile(path.join(root, 'workspaces', 'history', 'keep'), 'evidence');
  const result = await rollback(second.manifest);
  assert.equal(result.exact, false);
  const restored = await fs.readFile(config, 'utf8');
  assert.ok(restored.includes('// keep this comment'));
  assert.deepEqual(parseConfig(restored).value.plugins, ['foreign', 'new-unrelated']);
  assert.equal(await fs.readFile(path.join(root, 'workspaces', 'history', 'keep'), 'utf8'), 'evidence');
});

test('absent config restored to absent, invalid config unchanged and edited managed entry preserved', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-install-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'opencode.json'), root = path.join(dir, 'data');
  const receipt = await install({ config, root });
  await rollback(receipt.manifest);
  await assert.rejects(fs.access(config));
  await fs.writeFile(config, '{bad');
  await assert.rejects(install({ config, root }));
  assert.equal(await fs.readFile(config, 'utf8'), '{bad');
  const text = addEntry('{}', entry).replace('"_opencodeTraceInstaller":', '"custom":true,"_opencodeTraceInstaller":');
  assert.throws(() => removeEntry(text, entry, false), /changed/);
});
