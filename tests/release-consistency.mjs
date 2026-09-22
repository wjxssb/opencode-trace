#!/usr/bin/env node
// P3-B release consistency checker (campaign 2026-09-21, final closure).
// Authority map (mission §20–21): every component has ONE explicit authority;
// `current` is informational (OpenCode bundle convenience), never the
// plugin-identity authority. Statuses:
//   CONSISTENT | EXPECTED_SKEW | UNEXPLAINED_SKEW | MISSING_PROVENANCE
// Exit 1 on UNEXPLAINED_SKEW / MISSING_PROVENANCE (promotion gate §23).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const RUNTIME = process.env.OPENCODE_CONSISTENCY_RUNTIME ?? '/home/frank/.local/share/opencode-runtime';
const CFG_PATH = process.env.OPENCODE_CONSISTENCY_CONFIG ?? '/home/frank/.config/opencode/opencode.jsonc';

function stripJsonc(s) {
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    if (inStr) { out += c; if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i + 1 < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return out;
}
const cfg = JSON.parse(stripJsonc(fs.readFileSync(CFG_PATH, 'utf8')));
const current = fs.readlinkSync(path.join(RUNTIME, 'current'));
const results = [];

const pinOf = (needle) => (cfg.plugins ?? []).find(p => String(p.package ?? '').includes(`/plugins/${needle}`))?.package ?? null;

function checkPlugin(name, pkg) {
  if (!pkg || !fs.existsSync(pkg)) { results.push({ component: name, status: 'MISSING_PROVENANCE', configured: pkg, error: 'config pin missing or path absent' }); return; }
  const releaseDir = path.dirname(path.dirname(pkg));
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(releaseDir, 'manifest.json'), 'utf8'));
    const journalPath = path.join(RUNTIME, 'promotions', `${manifest.release}.json`);
    const journal = fs.existsSync(journalPath) ? JSON.parse(fs.readFileSync(journalPath, 'utf8')) : null;
    const payloadFiles = Object.keys(manifest.payload_files ?? {});
    const missingBytes = payloadFiles.filter(rel => !fs.existsSync(path.join(pkg, rel)));
    const wrongHash = payloadFiles.filter(rel => {
      try { return createHash('sha256').update(fs.readFileSync(path.join(pkg, rel))).digest('hex') !== manifest.payload_files[rel]; }
      catch { return true; }
    });
    const status = missingBytes.length || wrongHash.length ? 'UNEXPLAINED_SKEW' : (journal ? 'CONSISTENT' : 'MISSING_PROVENANCE');
    results.push({ component: name, status, configured_release: manifest.release, source_commit: manifest.source_commit,
      payload_files: payloadFiles.length, manifest_bytes_match: missingBytes.length === 0 && wrongHash.length === 0,
      journal: journal ? 'present' : 'MISSING', config_pin: pkg });
  } catch (e) { results.push({ component: name, status: 'MISSING_PROVENANCE', configured: pkg, error: String(e.message ?? e) }); }
}

checkPlugin('trace-plugin', pinOf('trace'));
const reviewerViaCurrent = path.join(current, 'plugins', 'inline-reviewer');
if (fs.existsSync(reviewerViaCurrent)) {
  try {
    const binding = JSON.parse(fs.readFileSync(path.join(current, 'source-binding.json'), 'utf8'));
    results.push({ component: 'inline-reviewer', status: binding.producers?.['inline-reviewer']?.commit ? 'CONSISTENT' : 'MISSING_PROVENANCE',
      source_commit: binding.producers?.['inline-reviewer']?.commit ?? null, loaded_via: 'current bundle' });
  } catch (e) { results.push({ component: 'inline-reviewer', status: 'MISSING_PROVENANCE', error: String(e.message ?? e) }); }
}
const curTarget = path.basename(current);
const tracePin = pinOf('trace');
const traceRel = tracePin ? path.basename(path.dirname(path.dirname(tracePin))) : null;
results.push({ component: 'current-symlink', status: traceRel && curTarget !== traceRel ? 'EXPECTED_SKEW' : 'CONSISTENT',
  current: curTarget, trace_release: traceRel,
  semantics: 'current = informational OpenCode bundle; config pins are the plugin authorities (mission §20–21); documented skew passes, unexplained skew fails' });

for (const r of results) console.log(JSON.stringify(r));
const blocked = results.some(r => r.status === 'UNEXPLAINED_SKEW' || r.status === 'MISSING_PROVENANCE');
console.log(JSON.stringify({ gate: 'release-consistency', pass: !blocked }));
process.exit(blocked ? 1 : 0);
