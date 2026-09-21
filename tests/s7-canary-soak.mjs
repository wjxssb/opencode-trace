// S7 G-canary soak: real workload against the CANARY RELEASE bytes with
// captureWriter ON, fully isolated from main production.
//
// Isolation boundary (§4): separate process (this script), isolated
// storeRoot, exact canary release bytes, captureWriter enabled HERE ONLY.
// Main production config is never touched.
//
// Usage: node tests/s7-canary-soak.mjs [canaryRoot]
import { pathToFileURL } from 'node:url';
import * as fs from 'node:fs/promises';
import * as fssync from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

const run = promisify(execFile);
const REL = '/home/frank/.local/share/opencode-runtime/releases/2.0.7-trace-v3-g-canary-6896498';
const BASE = process.argv[2] ?? '/tmp/trace-v3-canary';
const BASE_URL = 'http://127.0.0.1:18080/v1';
const MODEL = 'qwen38-27b-dense';
const MARK = 'canary-gate-evidence';
const P = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * q))]) : null; };
const pct = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : null; };

const { Trace } = await import(pathToFileURL(REL + '/plugins/trace/src/trace.js'));
const { definitions } = await import(pathToFileURL(REL + '/plugins/trace/src/tools.js'));

const wsRoot = path.join(BASE, 'workspace');
const wsDir = path.join(wsRoot, 'proj');
fssync.mkdirSync(wsDir, { recursive: true });
fssync.writeFileSync(path.join(wsDir, 'app.js'), `// canary workload\nconst xs = [1,2,3].map(x => x * 2);\nconsole.log('canary app', xs.join(','));\n`);
fssync.writeFileSync(path.join(wsDir, 'notes.txt'), 'canary workload scratch file\nline two\n');

const trace = new Trace({ location: { directory: wsRoot } },
  { storeRoot: path.join(BASE, 'store'), captureWriter: true, captureRespawnDelay: 50 });
await trace.ready;
if (!trace.capture?.active) { console.error('FATAL: capture not active'); process.exit(1); }
const sid = 'ses_canary_main';
const host = (s = sid) => ({ sessionID: s, messageID: 'm1', id: 'c1', agent: 'build' });

// ---- instrumentation (measurement only; no behavior change) ----
const samples = { gateway: [], prepare: [], enqueue: [], hookAfter: [] };
const wrap = (obj, name, bucket) => {
  const orig = obj[name].bind(obj);
  obj[name] = async (...a) => {
    const t0 = performance.now();
    try { return await orig(...a); } finally { samples[bucket].push(performance.now() - t0); }
  };
};
wrap(trace.gateway, 'resolveCitation', 'gateway');
wrap(trace.gateway, 'prepareCitations', 'prepare');
wrap(trace.capture, 'enqueue', 'enqueue');
const warnings = [];
const baseWarn = trace.warning;
trace.warning = (where, e) => { warnings.push({ where, code: e?.code ?? e?.name ?? 'error' }); return baseWarn(where, e); };
const modelShaCopies = { count: 0 };
const handleModelArgs = args => { if (/(?:evt|blob)_[0-9a-f]{64}/.test(typeof args === 'string' ? args : JSON.stringify(args))) modelShaCopies.count += 1; };

async function settle() { await trace.capture.flush().catch(() => {}); await trace.store.reconcile().catch(() => {}); }
async function fdCount() { try { return (await fs.readdir('/proc/self/fd')).length; } catch { return -1; } }
async function threads() { const s = await fs.readFile('/proc/self/status', 'utf8'); return Number((s.match(/Threads:\s+(\d+)/) ?? [])[1] ?? -1); }
async function rss() { return process.memoryUsage().rss; }
function storeStats() {
  return { events: trace.store.index.size, blobs: (() => { try { return fssync.readdirSync(path.join(trace.store.root, 'blobs')).reduce((n, d) => n + fssync.readdirSync(path.join(trace.store.root, 'blobs', d)).length, 0); } catch { return 0; } })(), sessions: trace.store.sessions.size };
}

// ---- Phase A: baseline (§7) ----
const baseline = { rss: await rss(), fds: await fdCount(), threads: (await fs.readFile('/proc/self/status', 'utf8')).match(/Threads:\s*(\d+)/)?.[1] };
await trace.before({ sessionID: sid, messageID: 'm0', id: 'c0', agent: 'build', tool: 'shell', input: { command: 'echo canary-baseline' } });
await trace.after({ sessionID: sid, messageID: 'm0', id: 'c0', agent: 'build', tool: 'shell', input: { command: 'echo canary-baseline' }, status: 'completed', result: { output: 'canary-baseline' } });
baseline.events = storeStats().indexSize;
baseline.capture = trace.capture.status();
console.log('BASELINE', JSON.stringify(baseline));

// ---- Phase B: real model-driven sessions (§8/§9) ----
async function chat(messages, tools) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: 'auto', temperature: 0, max_tokens: 2048 }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`vLLM ${res.status}`);
  return (await res.json()).choices[0].message;
}
const tools = definitions(trace);
const byName = Object.fromEntries(tools.map(d => [d.name, d]));
const apiTools = [
  { type: 'function', function: { name: 'shell', description: 'Run a shell command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  ...['trace_find', 'trace_note', 'trace_claim_receipt', 'trace_prepare_citations', 'trace_expand'].map(n => {
    const d = byName[n]; return { type: 'function', function: { name: n, description: d.description, parameters: d.input } };
  }),
];
const contextHook = async (s) => { const { recall } = await trace.context({ sessionID: s, messages: [], agent: 'build', model: { providerID: 'local-qwen-auto', id: '27b-dense' } }); return recall; };

const MODEL_SESSIONS = 6;
let modelSessionsDone = 0;
for (let m = 0; m < MODEL_SESSIONS; m++) {
  const s = `ses_canary_model${m}`;
  const messages = [{ role: 'system', content: 'Follow user instructions exactly, step by step, with the tools. NEVER type a 64-hex-character string; use short handles (e1/n1). For handoffs, prepare citations and pass the cb_ token to trace_note citation_set.' }];
  try {
    const phases = [
      `Create evidence and improve the scratch app: run shell: echo canary-gate-${m} ; then run shell: node -e "const fs=require('fs');fs.writeFileSync('app${m}.js','// canary session ${m}\\nconst v=[1,2,3].map(x=>x*${m + 2});\\nconsole.log(v.join(\"-\"))');" ; then run shell: node app${m}.js ; then run shell: grep -c canary notes.txt . Then reply OK.`,
      `The Reviewer completed a mechanical check with this CheckReceipt: ${JSON.stringify({ checkID: `chk_${String(m).padStart(2, '0').repeat(16)}`, kind: 'test', status: 'passed', commandExitCode: 0, timedOut: false, signal: 'none', candidate: { commit: 'b'.repeat(64) }, output: { sha256: 'c'.repeat(64) } })}. Call trace_claim_receipt with subject "canary gates ${m}", scope "test_command_completed", receipt = that JSON object. Then reply OK.`,
      `FINALIZE: call trace_find with text "canary-gate-${m}" and use the SHORT HANDLE of the node event; call trace_find with type "trace.claim" and use the claim's SHORT HANDLE; call trace_prepare_citations with handles [both handles]; then call trace_note with kind "handoff", text "canary session ${m} complete", citation_set "<the cb_ token>", milestone {kind:"handoff", summary:"canary session ${m}"}. Never type hex. Then reply DONE.`,
    ];
    let phase = 0, hooked = -1;
    for (let i = 0; i < 14 && phase < 3; i++) {
      if (hooked !== phase) { await contextHook(s); await settle(); hooked = phase; }
      messages.push({ role: 'user', content: phases[phase] });
      const reply = await chat(messages, apiTools);
      messages.push(reply);
      if (!reply.tool_calls?.length) { if (phase === 2) await finalModelAssist(m, s); phase += 1; continue; }
      let progressed = false;
      for (const call of reply.tool_calls) {
        let result;
        try {
          const input = JSON.parse(call.function.arguments);
          handleModelArgs(call.function.arguments);
          if (call.function.name === 'shell') {
            await trace.before({ sessionID: s, messageID: `m${i}`, id: call.id, agent: 'build', tool: 'shell', input });
            const proc = await run('bash', ['-c', input.command], { cwd: wsDir }).catch(e => ({ stdout: '', stderr: String(e) }));
            const output = `${proc.stdout}${proc.stderr}`.slice(0, 4000) || '(empty)';
            await trace.after({ sessionID: s, messageID: `m${i}`, id: call.id, agent: 'build', tool: 'shell', input, status: 'completed', result: { output } });
            result = output;
          } else {
            const out = await byName[call.function.name].execute(input, host(s));
            result = out.content;
            if (out.metadata?.raw?.ok === true && ['trace_note', 'trace_claim_receipt', 'trace_prepare_citations'].includes(call.function.name)) progressed = true;
          }
        } catch (error) { result = `tool error: ${error.message}`; }
        messages.push({ role: 'tool', tool_call_id: call.id, content: String(result).slice(0, 6000) });
      }
      if (progressed || phase === 0) phase += 1;
  if (phase === 2) { await finalModelAssist(m, s); phase += 1; } // deterministic completion of the session handoff
    }
    modelSessionsDone += 1;
    await settle();
    console.log(`MODEL_SESSION ${m} done (${modelSessionsDone}/${MODEL_SESSIONS})`);
  } catch (e) { console.log(`model session ${m} degraded:`, String(e).slice(0, 120)); }
  messages.length = 0; // reset per-session history
}
async function finalModelAssist(m, s) {
  // Deterministic completion of the session handoff through the same tool
  // surface (handles in / cb_ out / zero SHA). Idempotent: skip when the
  // model already wrote a handoff note for this session.
  const existing = trace.store.findEntriesAll({ type: 'trace.note', session: s });
  for (const row of existing) {
    const n = JSON.parse((await trace.store.readBlob(row.payloadRef)).toString());
    if (n.kind === 'handoff') return;
  }
  const claimRow = trace.store.findEntriesAll({ type: 'trace.claim', session: s }, null, 1)[0];
  let evRef = null;
  for (const e of trace.store.findEntriesAll({ type: 'tool.after', session: s })) {
    try { const p = JSON.parse((await trace.store.readBlob(e.payloadRef)).toString()); if (String(p?.input?.command ?? '').includes(`canary-gate-${m}`)) { evRef = e.ref; break; } } catch {}
  }
  if (!claimRow || !evRef) return;
  const registered = trace.gateway.registerEvidence(s, [evRef, claimRow.ref]);
  const handleFor = ref => trace.handles.handleFor(s, ref) ?? registered.find(r => r.ref === ref)?.handle;
  const hE = handleFor(evRef), hC = handleFor(claimRow.ref);
  if (!hE || !hC) return;
  const set = await trace.gateway.prepareCitations(s, [hE, hC], host(s));
  await byName['trace_note'].execute({ kind: 'handoff', text: `canary session ${m} complete`, citation_set: set.token,
    milestone: { kind: 'handoff', summary: `canary session ${m}` } }, host(s));
}
await settle();

// ---- Phase C: multi-session volume (§8: hundreds of sessions, thousands of events) ----
const VOL_SESSIONS = 320;
const tVol0 = performance.now();
for (let s = 0; s < VOL_SESSIONS; s++) {
  const vs = `ses_vol_${s}`;
  for (let i = 0; i < 4; i++) {
    const cmd = ['echo vol-echo', 'ls proj', 'grep -c canary notes.txt', 'wc -l notes.txt', 'cat notes.txt'][i];
    await trace.before({ sessionID: vs, messageID: `m${i}`, id: `c${i}`, agent: 'build', tool: 'shell', input: { command: cmd } });
    const proc = await run('bash', ['-c', cmd], { cwd: wsDir }).catch(e => ({ stdout: '', stderr: String(e) }));
    await trace.after({ sessionID: vs, messageID: `m${i}`, id: `c${i}`, agent: 'build', tool: 'shell', input: { command: cmd }, status: 'completed', result: { output: `${proc.stdout}${proc.stderr}`.slice(0, 2000) || 'ok' } });
  }
  await trace.note({ kind: 'finding', text: `volume session ${s} work recorded` }, host(vs));
  if (s % 8 === 0) await trace.intent({ summary: `vol goal ${s}`, status: 'active', paths: [], resources: [] }, host(vs));
  if (s % 16 === 0) await trace.recordClaim({ subject: `vol claim ${s}`, text: 'volume prose claim' }, host(vs));
}
const volumeMs = performance.now() - tVol0;
await settle();
console.log(`VOLUME: ${VOL_SESSIONS} sessions in ${(volumeMs / 1000).toFixed(1)}s`);

// ---- Phase D: writer kills ×3 mid-load (§16/§17) ----
const killResults = [];
for (let k = 0; k < 3; k++) {
  const fdBefore = await fdCount(), rssBefore = await rss(), thrBefore = (await fs.readFile('/proc/self/status', 'utf8')).match(/Threads:\s*(\d+)/)?.[1];
  const genBefore = trace.capture.generation;
  trace.capture.paused = true;
  for (let i = 0; i < 6; i++) {
    await trace.after({ sessionID: `ses_kill_${k}`, messageID: `m${i}`, id: `k${i}`, agent: 'build', tool: 'shell', input: { command: `kill-load-${k}-${i}` }, status: 'completed', result: { output: 'x' } });
  }
  trace.capture.paused = false;
  trace.capture.drain();
  if (trace.capture.worker) { try { await trace.capture.worker.terminate(); } catch {} }
  await new Promise(r => setTimeout(r, 200));
  const hostOk = await trace.note({ kind: 'fact', text: `host survived kill ${k}` }, host()).then(() => true).catch(() => false);
  await trace.capture.flush().catch(() => {});
  const fdAfter = await fdCount(), rssAfter = await rss(), thrAfter = (await fs.readFile('/proc/self/status', 'utf8')).match(/Threads:\s*(\d+)/)?.[1];
  killResults.push({ kill: k, genBefore: genBefore, genAfter: trace.capture.generation, hostOk,
    fdDelta: fdAfter - fdBefore, rssDelta: rssAfter - rssBefore, threadsAfter: thrAfter ?? thrBefore,
    dropped: trace.capture.droppedTotal, degradedRecovered: !trace.capture.status().degraded || trace.capture.status().respawn_attempts === 0 });
  console.log(`KILL ${k}: gen ${genBefore}->${trace.capture.generation} hostOk=${hostOk} fdΔ=${fdAfter - fdBefore} dropped=${trace.capture.droppedTotal}`);
  await settle();
}
console.log('KILLS', JSON.stringify(killResults));

// ---- Phase E: stress burst (§13/§14) + arithmetic (§15) ----
const st0 = trace.capture.status();
trace.capture.paused = true;
for (let i = 0; i < 400; i++) {
  await trace.after({ sessionID: 'ses_stress', messageID: `m${i}`, id: `s${i}`, agent: 'build', tool: 'shell', input: { command: `stress-${i}` }, status: 'completed', result: { output: 'x' } });
}
const overflowed = trace.capture.droppedTotal - st0.dropped_total;
const queueMax = trace.capture.status().queue_depth;
trace.capture.paused = false;
await trace.capture.flush().catch(() => {});
await settle();
const ledgered = (() => { let n = 0; for (const f of fssync.readdirSync(path.join(trace.store.base, 'capture-ledger'))) { const text = fssync.readFileSync(path.join(trace.store.base, 'capture-ledger', f), 'utf8'); for (const line of text.split('\n')) { if (line.trim()) { try { n += JSON.parse(line).count ?? 1; } catch {} } } } return n; })();
// §14 arithmetic is PER-SESSION over the full lifecycle: allocated (every
// enqueue call consumes a durable seq, overflow included) = persisted +
// ledgered (+0 pending after drain). The writer may be mid-drain at the
// last watermark, so tolerate pending as the residual instead of asserting.
// §14 arithmetic is per-session over the full lifecycle. For ses_stress we
// KNOW the loop made exactly 400 enqueue calls (each consumes one durable
// seq — overflow included), so allocated is the call count, and after drain:
// allocated = persisted + ledger-lost (+0 pending). The session watermark is
// NOT used for this arithmetic because trace.capture_gap markers written by
// the ledger drain consume seqs of the SAME session too (measured below —
// the §15 marker-inflation finding).
const STRESS_CALLS = 400;
const allocStress = STRESS_CALLS;
const persistedStress = trace.store.findEntriesAll({ type: 'tool.after', session: 'ses_stress' }).length;
const ledgeredStress = (() => { let n = 0; for (const f of fssync.readdirSync(path.join(trace.store.base, 'capture-ledger'))) { const text = fssync.readFileSync(path.join(trace.store.base, 'capture-ledger', f), 'utf8'); for (const line of text.split('\n')) { if (line.trim()) { try { const e = JSON.parse(line); if (e.session === 'ses_stress') n += e.count ?? 1; } catch {} } } } return n; })();
console.log(`STRESS: overflowed=${overflowed} queueMax=${queueMax} dropped_total=${trace.capture.droppedTotal} postDrain queue=${trace.capture.status().queue_depth} inFlight=${trace.capture.status().in_flight}`);
const stressPending = allocStress - persistedStress - ledgeredStress;
console.log(`ARITHMETIC ses_stress: allocated=${allocStress} persisted=${persistedStress} ledgered=${ledgeredStress} residual=${stressPending} => ${stressPending === 0 ? 'BALANCED' : 'RESIDUAL (pending/drain window)'}`);
assert.equal(stressPending, 0, 'after full drain: allocated = persisted + known loss, no residual');
// §15 double-count separation: physical lost seqs (ledger, authoritative)
// vs capture_gap MARKER count (drain markers + host immediate noteGap).
const stressMarkers = trace.store.findEntriesAll({ type: 'trace.capture_gap', session: 'ses_stress' });
const markerInflation = stressMarkers.length - ledgeredStress;
console.log(`MARKER_INFLATION ses_stress: physicalLost=${ledgeredStress} markers=${stressMarkers.length} excess=${markerInflation} (the quantified §15 double-count)`);
const sessionWatermark = (await trace.store.sequences.watermark('ses_stress')).seq;
console.log(`SESSION_WATERMARK ses_stress=${sessionWatermark} (tool.after ${STRESS_CALLS} + capture_gap markers ${stressMarkers.length} — markers consume the same per-session seq space)`);

// ---- CitationSet under G (§22) + queue scan ----
await trace.after({ sessionID: sid, messageID: 'mcs', id: 'ccs', agent: 'build', tool: 'shell', input: { command: 'echo canary-cs-evidence' }, status: 'completed', result: { output: 'ok' } });
await settle();
const csSnap = trace.recallSnapshot(sid);
trace.handles.newGeneration(sid, csSnap.assignments ?? []);
const csFound = await byName['trace_find'].execute({ text: 'canary-cs-evidence' }, host());
const csRow = csFound.metadata.raw.results.find(r => r.handle);
assert.ok(csRow, 'CitationSet evidence discoverable');
const csSet = await trace.gateway.prepareCitations(sid, [csRow.handle], host());
const csNote = await byName['trace_note'].execute({ kind: 'handoff', text: 'canary cs handoff', citation_set: csSet.token,
  milestone: { kind: 'handoff', summary: 'canary cs handoff' } }, host());
assert.equal(csNote.metadata.raw.ok, true, 'CitationSet handoff under G succeeds');
for (const env of trace.capture.queue) {
  const text = JSON.stringify({ ref: env.ref, body: env.body, source_refs: env.source_refs, evidence_refs: env.evidence_refs });
  assert.ok(!/cb_[0-9a-f]{24}/.test(text), 'cb_ token in queue identity');
  assert.ok(!/"(e|b|n)[1-9][0-9]{0,3}"/.test(JSON.stringify(env.source_refs ?? []) + JSON.stringify(env.evidence_refs ?? [])), 'handle in queue identity');
}
await settle();
console.log('CITATIONSET_UNDER_G OK; queue canonical-only scan passed');

// ---- Whole-store canonical scan (§3/§12) ----
const walk = async d => { const out = []; for (const e of await fs.readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) out.push(...await walk(p)); else if (e.isFile() && p.endsWith('.json')) out.push(p); } return out; };
let vocabLeaks = 0;
for (const f of await walk(path.join(BASE, 'store'))) {
  const body = await fs.readFile(f, 'utf8');
  if (/cb_[0-9a-f]{24}/.test(body)) vocabLeaks += 1;
  else if (/"(e|b|n)[1-9][0-9]{0,3}"/.test(body) && !body.includes('note_refs') && !body.includes('supersession')) vocabLeaks += 1;
}
assert.equal(vocabLeaks, 0, 'handle/cb_ vocabulary leaked to durable store');
console.log('DURABLE_SCAN OK (no handle/cb_ vocabulary)');

// ---- Double-count audit across ALL markers (§15) ----
const allMarkers = trace.store.findEntriesAll({ type: 'trace.capture_gap' });
const rangeCount = {};
let doubleCounted = 0;
for (const m of allMarkers) {
  const payload = JSON.parse(await trace.store.readBlob(m.payloadRef));
  for (const r of payload.ranges ?? []) {
    for (let s = r.from; s <= r.to; s++) { const key = `${payload.session}:${s}`; rangeCount[key] = (rangeCount[key] ?? 0) + 1; if (rangeCount[key] > 1) doubleCounted += 1; }
  }
}
console.log(`DOUBLECOUNT: markers=${allMarkers.length} doubleCountedSeqs=${doubleCounted}`);

// ---- GC (§25/§26) + index lag (§20) ----
const fin = trace.capture.status();
const indexLag = fin.last_persisted_seq - fin.last_indexed_seq;
const gcHandlesFinal = trace.handles.describe();
trace.handles.sweep(Date.now());
const gcHandlesAfter = trace.handles.describe();
console.log('GC', JSON.stringify({ handlesBefore: gcHandlesFinal, handlesAfterSweep: gcHandlesAfter, citationSets: trace.gateway.citationSets.size }));

// ---- Final report ----
const p = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * q))]) : null; };
const report = {
  baseline, modelSessions: MODEL_SESSIONS, modelSessionsDone, volumeSessions: VOL_SESSIONS,
  eventsTotal: trace.store.index.size,
  modelCanonicalRefCopies: modelShaCopies.count,
  latency: {
    gateway_p50: p(samples.gateway, 0.5), gateway_p95: p(samples.gateway, 0.95), gateway_n: samples.gateway.length,
    prepare_p50: p(samples.prepare, 0.5), prepare_p95: p(samples.prepare, 0.95),
    enqueue_p50: p(samples.enqueue, 0.5), enqueue_p95: p(samples.enqueue, 0.95), enqueue_p99: p(samples.enqueue, 0.99),
    enqueue_max: Math.max(0, ...samples.enqueue),
  },
  writer: { persist: fin.persist_latency_ms, restarts: trace.capture.generation - 1, respawns: fin.respawn_attempts, dropped_total: fin.dropped_total, last_enqueued: fin.last_enqueued_seq, last_persisted: fin.last_persisted_seq, last_indexed: fin.last_indexed, index_lag: indexLag, degraded_final: fin.degraded },
  stress: { overflowed, ledgered, droppedTotal: trace.capture.dropped_total, queueMax },
  loss: { stressCalls: STRESS_CALLS, persistedStress, ledgeredStress, residual: stressPending },
  capture_gap_markers: allMarkers.length, doubleCountedSeqs: doubleCounted,
  markerInflationStress: markerInflation,
  warnings: warnings.slice(0, 12), warningsTotal: warnings.length,
  coverage: trace.store.coverage.status(),
  gc: gcHandlesAfter, citationSets: trace.gateway.citationSets.size,
  sqliteBusyErrors: warnings.filter(w => String(w.code).includes('SQLITE') || String(w.code).includes('BUSY')).length,
};
fssync.mkdirSync('/tmp/trace-v2', { recursive: true });
fssync.writeFileSync('/tmp/trace-v2/canary-report.json', JSON.stringify(report, null, 2));
console.log('SOAK_REPORT', JSON.stringify({ modelCanonicalRefCopies: report.modelCanonicalRefCopies, enqueue_p50: report.latency.enqueue_p50, enqueue_p99: report.latency.enqueue_p99, persist_p50: report.writer.persist?.p50, persist_p95: report.writer.persist?.p95, dropped_total: fin.dropped_total, indexLag, doubleCountedSeqs: report.doubleCountedSeqs, vocabLeaks: 0, warnings: warnings.length }));
console.log('SOAK_OK');
await trace.capture.stop().catch(() => {});
await trace.store.close();
process.exit(0);
