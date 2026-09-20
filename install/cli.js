#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { atomic, hash, stable, canonical } from '../src/util.js';
import { parseConfig, addEntry, removeEntry } from './config.js';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const marker = 'opencode-trace-v1';
const readOptional = async filename => {
  try { return await fs.readFile(filename); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
};
const digest = data => data === null ? null : hash(data);

export async function install({ config, root = path.join(os.homedir(), '.local/share/opencode-trace'), storeRoot }) {
  config = await canonical(config); root = path.resolve(root);
  const before = await readOptional(config), text = before?.toString('utf8') ?? '{}\n';
  const parsed = parseConfig(text);
  const mode = before ? (await fs.stat(config)).mode & 0o777 : 0o600;
  const pkg = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
  const files = ['package.json', 'server.js', ...(await fs.readdir(path.join(source, 'src'))).filter(f => f.endsWith('.js')).sort().map(f => `src/${f}`)];
  const content = await Promise.all(files.map(async f => [f, await fs.readFile(path.join(source, f))]));
  const bundleHash = hash(stable(content.map(([f, data]) => [f, hash(data)])));
  const version = path.join(root, 'versions', `${pkg.version}-${bundleHash.slice(0, 16)}`);
  for (const [f, data] of content) await atomic(path.join(version, f), data, true);
  const entry = { package: version, options: { _opencodeTraceInstaller: marker, ...(storeRoot ? { storeRoot: path.resolve(storeRoot) } : {}) } };
  const after = Buffer.from(addEntry(text, entry));
  const expected = structuredClone(parsed.value); (expected.plugins ??= []).push(entry);
  if (stable(parseConfig(after.toString()).value) !== stable(expected)) throw new Error('Narrow merge verification failed');
  const id = new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8);
  const directory = path.join(root, 'installations', id);
  const receipt = { schema: 1, id, config, beforeExisted: before !== null, beforeHash: digest(before), afterHash: hash(after), mode,
    originalHadPlugins: Object.hasOwn(parsed.value, 'plugins'), entry, version: pkg.version, bundleHash, installedPath: version, status: 'prepared' };
  if (before) await atomic(path.join(directory, 'before-config'), before, true);
  await atomic(path.join(directory, 'after-config'), after, true);
  const manifest = path.join(directory, 'receipt.json');
  await atomic(manifest, stable(receipt));
  if (digest(await readOptional(config)) !== receipt.beforeHash) throw new Error('Config changed concurrently; no config written');
  await atomic(config, after); await fs.chmod(config, mode);
  receipt.status = 'installed'; await atomic(manifest, stable(receipt));
  return { ...receipt, manifest };
}

export async function rollback(manifest) {
  manifest = path.resolve(manifest);
  const receipt = JSON.parse(await fs.readFile(manifest, 'utf8'));
  if (receipt.schema !== 1 || receipt.entry?.options?._opencodeTraceInstaller !== marker) throw new Error('Invalid receipt');
  const current = await readOptional(receipt.config);
  if (current === null) return { status: 'already_absent', config: receipt.config, historyPreserved: true };
  let restored;
  if (hash(current) === receipt.afterHash) {
    restored = receipt.beforeExisted ? await fs.readFile(path.join(path.dirname(manifest), 'before-config')) : null;
    if (digest(restored) !== receipt.beforeHash) throw new Error('Backup hash mismatch');
  } else restored = Buffer.from(removeEntry(current.toString('utf8'), receipt.entry, receipt.originalHadPlugins));
  if (digest(await readOptional(receipt.config)) !== hash(current)) throw new Error('Config changed concurrently; no config written');
  if (restored === null) await fs.unlink(receipt.config);
  else { parseConfig(restored.toString()); await atomic(receipt.config, restored); await fs.chmod(receipt.config, receipt.mode); }
  const result = { status: 'rolled_back', config: receipt.config, restoredHash: digest(restored), exact: digest(restored) === receipt.beforeHash, historyPreserved: true };
  await atomic(path.join(path.dirname(manifest), 'rollback.json'), stable(result));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--config', '--root', '--store-root', '--manifest'].includes(args[i]) || !args[i + 1]) throw new Error('Invalid arguments');
      options[args[i].slice(2).replace('-root', 'Root')] = args[i + 1];
    }
    if (command === 'install' && options.config) console.log(JSON.stringify(await install(options), null, 2));
    else if (command === 'rollback' && options.manifest) console.log(JSON.stringify(await rollback(options.manifest), null, 2));
    else throw new Error('Usage: node install/cli.js install --config PATH [--root PATH] [--store-root PATH] | rollback --manifest PATH');
  } catch (error) { console.error(`opencode-trace installer: ${error.message}`); process.exitCode = 1; }
}
