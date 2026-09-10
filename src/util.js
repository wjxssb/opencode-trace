import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

export function stable(value) {
  const visit = v => {
    if (v === undefined) return null;
    if (v === null || typeof v !== 'object') return v;
    if (v instanceof Error) return { name: v.name, message: v.message };
    if (Array.isArray(v)) return v.map(visit);
    return Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, visit(v[k])]));
  };
  return JSON.stringify(visit(value));
}
export const hash = value => createHash('sha256').update(value).digest('hex');
export const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : stable(value));
export const refPattern = /^(evt|blob)_[a-f0-9]{64}$/;
export const unwrap = value => value?.data ?? value;
export const messageID = m => m?.id ?? m?.messageID ?? m?.info?.id ?? null;
export const messageRole = m => m?.role ?? m?.info?.role ?? (['user', 'assistant'].includes(m?.type) ? m.type : null);
export const textFromMessage = m => typeof m?.text === 'string' ? m.text : typeof m?.content === 'string' ? m.content :
  (m?.parts ?? m?.content ?? m?.info?.parts ?? []).filter(p => p?.type === 'text').map(p => p.text ?? '').join('');

// Resolve existing ancestors too, so two new files under a symlinked directory match.
export async function canonical(filename) {
  const absolute = path.resolve(filename);
  try { return await fs.realpath(absolute); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    return path.join(await canonical(parent), path.basename(absolute));
  }
}

export async function atomic(filename, data, immutable = false) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close(); handle = null;
    if (immutable) {
      try { await fs.link(temporary, filename); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!Buffer.from(data).equals(await fs.readFile(filename))) throw new Error('Immutable content mismatch');
      }
    } else await fs.rename(temporary, filename);
    const dir = await fs.open(path.dirname(filename), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } finally {
    await handle?.close();
    await fs.unlink(temporary).catch(() => {});
  }
}

export function identity(event = {}) {
  return Object.fromEntries(['sessionID', 'messageID', 'agent', 'role', 'persona', 'parentID'].filter(k => event[k] !== undefined).map(k => [k, event[k]]));
}
export function callKey(event) {
  return hash(stable([event.sessionID ?? null, event.messageID ?? null, event.id ?? null]));
}

export function locator(input = {}) {
  return Object.fromEntries(['filePath', 'path', 'paths', 'directory', 'url', 'uri', 'offset', 'limit', 'startLine', 'endLine', 'page', 'range', 'query', 'pattern']
    .filter(k => input[k] !== undefined).map(k => [k, input[k]]));
}

// Tool names and explicit schema fields only. Never parse shell or patch text.
export async function mutationPaths(tool, input, workspace) {
  if (!['edit', 'write', 'patch', 'apply_patch'].includes(tool)) return null;
  const fields = [input?.filePath, input?.path, ...(Array.isArray(input?.paths) ? input.paths : [])];
  const paths = await Promise.all(fields.filter(x => typeof x === 'string' && x.length > 0).map(x => canonical(path.resolve(workspace, x))));
  return paths.length ? [...new Set(paths)].sort() : null;
}

export const overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
