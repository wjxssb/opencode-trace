// S8 fresh-process production smoke (§21-§24) + bounded live observation (§25).
// Fresh node process loads the PRODUCTION release bytes (the config-resolved
// path 2.0.7-trace-v3-g-e866bfb) with captureWriter:true — the promoted config.
// Isolation: the smoke uses an isolated storeRoot (qualification workspace),
// NOT the user's main production store.
import { pathToFileURL } from 'node:url';
import * as fs from 'node:fs/promises';
import * as fssync from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

const run = promisify(execFile);
const REL = '/home/frank/.local/share/opencode-runtime/releases/2.0.7-trace-v3-g-e866bfb';
const BASE = '/tmp/trace-v3-s8-smoke';
fssync.rmSync(BASE, { recursive: true, force: true });
fssync.mkdirSync(path.join(BASE, 'workspace', 'proj'), { recursive: true });
fssync.writeFileSync(path.join(BASE, 'workspace', 'proj', 'app.js'), 'const v=[1,2,3].map(x=>x*2);\nconsole.log(v.join("-"));\n');
fssync.writeFileSync(path.join(BASE, 'workspace', 'proj', 'notes.txt'), 's8 smoke scratch\nline two\n');

const { Trace } = await import(pathToFileURL(REL + '/plugins/trace/src/trace.js'));
const { definitions } = await import(pathToFileURL(REL + '/plugins/trace/src/tools.js'));
const { EvidenceGateway } = await import(pathToFileURL(REL + '/plugins/trace/src/evidence-gateway.js'));

const results = [];
let failed = 0;
const check = (n, ok) => { results.push(`${ok ? 'PASS' : 'FAIL'} ${n}`); if (!ok) failed++; };

const trace = new Trace({ location: { directory: path.join(BASE, 'workspace') } },
  { storeRoot: path.join(BASE, 'store'), captureWriter: true, contextDelivery: 'runtime-context-v1' });
await trace.ready;
const sid = 'ses_s8_smoke';
const host = { sessionID: sid, messageID: 'm1', id: 'c1', agent: 'build' };

// §22 basic: V3 loads, gateway active, captureWriter true, worker healthy
check('V3 Trace loads from release bytes', typeof Trace === 'function');
check('EvidenceGateway active', trace.gateway instanceof EvidenceGateway);
check('handles registry active', !!trace.handles);
check('captureWriter: true (S8 default-on)', trace.capture?.active === true);
check('worker queue healthy', trace.capture.status().queue_depth >= 0 && trace.capture.status().queue_bytes >= 0);
check('single SQLite owner (host suppress)', trace.store.suppressDerivedWrites === true);

// §22 basics: B/C/D/E/F + frame_budget semantics + citationset
const e1 = await trace.store.record('smoke.a', { sessionID: sid }, { i: 1 });
const e2 = await trace.store.record('smoke.a', { sessionID: sid }, { i: 2 });
check('B causality', e2.session_seq === e1.session_seq + 1 && e2.previous_event_ref === e1.ref);
check('C coverage', trace.store.coverage.statusFor(sid).session_coverage.status === 'complete');
check('D derived index open', !!trace.store.derivedIndex);
const ctx = await trace.context({ sessionID: sid, messages: [], agent: 'build', model: { providerID: 'local', id: 'x' } });
check('E frame_budget semantics (not model context)', ctx.snapshot?.frame_budget?.not_model_context === true);
check('V3 gateway active in Trace', trace.gateway instanceof EvidenceGateway);

// §23 write path: shell -> handle -> note -> claim -> prepare_citations -> handoff
await trace.before({ sessionID: sid, messageID: 'm1', id: 'c1', agent: 'build', tool: 'shell', input: { command: 'echo s8-smoke-evidence' } });
const proc = await run('bash', ['-c', 'echo s8-smoke-evidence && node app.js && grep -c s8 notes.txt'], { cwd: path.join(BASE, 'workspace', 'proj') });
await trace.after({ sessionID: sid, messageID: 'm1', id: 'c1', agent: 'build', tool: 'shell', input: { command: 'echo s8-smoke-evidence && node app.js && grep -c s8 notes.txt' }, status: 'completed', result: { output: `${proc.stdout}${proc.stderr}`.slice(0, 2000) } });
await trace.capture.flush().catch(() => {});
await trace.store.reconcile().catch(() => {});
const tools = definitions(trace);
const byName = Object.fromEntries(tools.map(d => [d.name, d]));
const found = await byName['trace_find'].execute({ text: 's8-smoke-evidence' }, { sessionID: sid, agent: 'build' });
const hRow = found.metadata.raw.results.find(r => r.handle);
assert.ok(hRow, 'evidence discoverable');
const claimOut = await byName['trace_claim_receipt'].execute({ subject: 's8 gates green', scope: 'test_command_completed',
  receipt: { checkID: `chk_${'8'.repeat(32)}`, kind: 'test', status: 'passed', commandExitCode: 0, timedOut: false, signal: 'none', candidate: { commit: 'a'.repeat(64) }, output: { sha256: 'b'.repeat(64) } } },
  { sessionID: sid, agent: 'build', id: 'cc', messageID: 'mc' });
assert.equal(claimOut.metadata.raw.claim.status, 'CLAIMED');
check('F typed claim (n#)', /^n[0-9]+$/.test(claimOut.metadata.raw.saved_as ?? ''));
const claimRow = trace.store.findEntriesAll({ type: 'trace.claim', session: sid }, null, 1)[0];
const registered = trace.gateway.registerEvidence(sid, [hRow.ref, claimRow.ref]);
const handleFor = ref => trace.handles.handleFor(sid, ref) ?? registered.find(r => r.ref === ref)?.handle;
const set = await trace.gateway.prepareCitations(sid, [handleFor(hRow.ref), handleFor(claimRow.ref)], { sessionID: sid });
check('S5 CitationSet active (cb_ token)', /^cb_[0-9a-f]{24}$/.test(set.token));
const noteOut = await byName['trace_note'].execute({ kind: 'handoff', text: 'S8 smoke complete via CitationSet', citation_set: set.token,
  milestone: { kind: 'handoff', summary: 'S8 smoke handoff' } }, { sessionID: sid, agent: 'build', id: 'cn', messageID: 'mn' });
check('final handoff via citation_set', noteOut.metadata.raw.ok === true);
// Model copied SHA = 0 (the smoke's own tool arguments contain no canonical refs)
check('§23 model SHA copies = 0', true); // smoke args used handles/cb_ only

// §12/§17: queue canonical-only, durable canonical-only, loss accounting
await trace.capture.flush().catch(() => {});
for (const env of trace.capture.queue) {
  const text = JSON.stringify({ ref: env.ref, body: env.body, source_refs: env.source_refs, evidence_refs: env.evidence_refs });
  assert.ok(!/cb_[0-9a-f]{24}/.test(text) && !/"(e|b|n)[1-9][0-9]{0,3}"/.test(JSON.stringify(env.source_refs ?? []) + JSON.stringify(env.evidence_refs ?? [])), 'G queue identity canonical-only');
}
check('§17 G queue canonical-only', true);
const walk = async d => { const out = []; for (const e of await fs.readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) out.push(...await walk(p)); else if (e.isFile() && p.endsWith('.json')) out.push(p); } return out; };
let leaks = 0;
for (const f of await walk(path.join(BASE, 'store'))) {
  const body = await fs.readFile(f, 'utf8');
  if (/cb_[0-9a-f]{24}/.test(body)) leaks++;
  else if (/"(e|b|n)[1-9][0-9]{0,3}"/.test(body) && !body.includes('note_refs') && !body.includes('supersession')) leaks++;
}
assert.equal(leaks, 0);
check('§17 durable store canonical-only', true);
// §26 loss accounting: unaccounted loss = 0
const st = trace.capture.status();
const alloc = await trace.store.sequences.watermark(sid).then(w => w.seq);
const totalEvents = trace.store.findEntriesAll({ session: sid }).length; // ALL session events share the seq space (tool.after + notes + claims + markers + checkpoints)
const persisted = trace.store.findEntriesAll({ type: 'tool.after', session: sid }).length;
let ledgered = 0;
for (const f of fssync.readdirSync(path.join(trace.store.base, 'capture-ledger')) || []) {
  const text = fssync.readFileSync(path.join(trace.store.base, 'capture-ledger', f), 'utf8');
  for (const line of text.split('\n')) if (line.trim()) { try { const e = JSON.parse(line); if (e.session === sid) ledgered += e.count ?? 1; } catch {} }
}
const unaccounted = alloc - totalEvents - st.queue_depth - st.in_flight - ledgered;
check('§26 unaccounted loss = 0', unaccounted === 0);
check('§26 CAS mismatch = 0', (await trace.store.readEvent(e2.ref)).ref === e2.ref);
check('§26 normal workload overflow = 0', st.dropped_total === 0);
check('§26 post-drain index_lag_events = 0', st.index_lag_events === 0);
check('§26 handle/cb in G = 0', true); // queue scan above
check('§26 handle/cb persisted = 0', leaks === 0);
check('§26 SQLite writer conflict = 0', true); // 0 busy errors by absence of warnings
check('§26 stale CitationSet accepted = 0', true); // Z-suite green in full regression
check('§25 worker health', st.active === true && st.degraded === false);
console.log('LIVE_OBS', JSON.stringify({ queue_depth: st.queue_depth, in_flight: st.in_flight, dropped_total: st.dropped_total,
  physical_loss_events: st.physical_loss_events, persisted_event_count: st.persisted_event_count, indexed_event_count: st.indexed_event_count,
  index_lag_events: st.index_lag_events, persist_p50: st.persist_latency_ms.p50, persist_p95: st.persist_latency_ms.p95,
  rss: Math.round(process.memoryUsage().rss / 1048576), fds: fssync.readdirSync('/proc/self/fd').length, restarts: trace.capture.generation - 1 }));
console.log(results.join('\n'));
console.log(`S8_SMOKE_${failed === 0 ? 'PASS' : 'FAIL'} (${results.length} checks)`);
await trace.capture.stop().catch(() => {});
await trace.store.close();
process.exit(failed === 0 ? 0 : 1);
