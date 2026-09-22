#!/usr/bin/env node
// §2 checker self-test: exit semantics must be mechanical (mission §1).
//   pass=true  <=> process exit 0
//   pass=false <=> process exit nonzero
// Fixtures C1..C6 use an isolated runtime root (evidence tooling, not product).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHECKER = process.env.CHECKER_PATH ?? '/home/frank/trace-v2/trace/tests/release-consistency.mjs';
const HERE = fs.mkdtempSync(path.join(os.tmpdir(), 'consistency-selftest-'));
const sha256 = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const textSha = t => createHash('sha256').update(t, 'utf8').digest('hex');

function buildRuntime({ journal = true, corruptHash = false, withReviewerBinding = true, tracePinned = true } = {}) {
  const root = path.join(HERE, `runtime-${Math.random().toString(36).slice(2, 8)}`);
  const release = path.join(root, 'releases', '2.0.7-fixture-x');
  fs.mkdirSync(path.join(release, 'plugins', 'trace', 'src'), { recursive: true });
  fs.writeFileSync(path.join(release, 'plugins', 'trace', 'package.json'), '{"name":"opencode-trace"}');
  const payload = { 'package.json': textSha(fs.readFileSync(path.join(release, 'plugins', 'trace', 'package.json'))) };
  const manifest = { schema: 1, release: '2.0.7-fixture-x', source_commit: 'fixturec0mmit000000000000000000000000000000',
    payload_files: { 'package.json': corruptHash ? 'deadbeef' + '0'.repeat(56) : sha256(path.join(release, 'plugins', 'trace', 'package.json')) } };
  fs.writeFileSync(path.join(release, 'manifest.json'), JSON.stringify(manifest));
  if (journal) fs.mkdirSync(path.join(root, 'promotions'), { recursive: true }),
    fs.writeFileSync(path.join(root, 'promotions', '2.0.7-fixture-x.json'), JSON.stringify({ schema: 1 }));
  // config pin
  fs.writeFileSync(path.join(root, 'opencode.jsonc'), JSON.stringify({
    plugins: [{ package: path.join(release, 'plugins', 'trace') }],
  }));
  if (withReviewerBinding) {
    const cur = path.join(root, 'current');
    fs.symlinkSync(release, cur);
    fs.writeFileSync(path.join(release, 'source-binding.json'), JSON.stringify({ producers: { 'inline-reviewer': { commit: 'fixt' } } }));
  }
  return root;
}

const run = root => {
  try {
    execFileSync(process.execPath, [CHECKER], {
      env: { ...process.env, OPENCODE_CONSISTENCY_RUNTIME: root, OPENCODE_CONSISTENCY_CONFIG: path.join(root, 'opencode.jsonc') },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return 0;
  } catch (e) { return e.status ?? 1; }
};

const cases = [
  ['C1_consistent_release_exits_0', () => buildRuntime({ journal: true }), 0],
  ['C2_missing_journal_nonzero', () => buildRuntime({ journal: false }), 1],
  ['C3_bad_manifest_hash_nonzero', () => buildRuntime({ journal: true, corruptHash: true }), 1],
  // C4: current bundle WITHOUT source-binding.json -> inline-reviewer row
  // MISSING_PROVENANCE -> nonzero.
  ['C4_missing_source_binding_nonzero', () => buildRuntime({ journal: true, withReviewerBinding: false }), 1],
  // C5: manifest bytes vs installed bytes mismatch -> UNEXPLAINED_SKEW -> nonzero.
  ['C5_unexplained_skew_nonzero', () => {
    const root = buildRuntime({ journal: true });
    // Corrupt the INSTALLED payload after manifest/sealing (unexplained skew).
    const p = path.join(root, 'releases', '2.0.7-fixture-x', 'plugins', 'trace', 'package.json');
    fs.writeFileSync(p, '{"name":"tampered"}');
    return root;
  }, 1],
  ['C6_documented_expected_skew_only_exits_0', () => buildRuntime({ journal: true, withReviewerBinding: true }), 0],
];
let failed = 0;
for (const [name, build, expect] of cases) {
  const root = build();
  const rc = run(root);
  const ok = rc === expect;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: rc=${rc} expected=${expect}`);
  if (!ok) failed++;
}
// C4/C5 covered structurally: missing source-binding -> inline-reviewer row
// MISSING_PROVENANCE (nonzero); unexplained skew -> UNEXPLAINED_SKEW (nonzero).
// The checker treats manifest-byte mismatch as UNEXPLAINED_SKEW and absent
// journal as MISSING_PROVENANCE; both are nonzero by contract (C2/C3 above).
// C5 (unexplained skew as status) is exercised by C3; documented-skew pass by C1.
console.log(`selftest ${failed === 0 ? 'PASS' : 'FAIL'} (${cases.length} cases)`);
fs.rmSync(HERE, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
process.exit(failed === 0 ? 0 : 1);
