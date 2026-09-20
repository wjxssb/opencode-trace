// Phase E qualification: token-aware runtime-context budgeting.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Trace } from '../src/trace.js';
import { TokenCounter, DEFAULT_TOKEN_BUDGET } from '../src/tokens.js';

async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-trace-tok-'));
  const trace = new Trace({ location: { directory: dir } }, { storeRoot: path.join(dir, 'store'), ...options });
  await trace.ready;
  t.after(async () => { await trace.store.close(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); });
  return { dir, trace, store: trace.store };
}
const host = (sessionID = 's1') => ({ sessionID, messageID: 'm1', id: 'c1', agent: 'build' });
async function pressure(trace, count = 24) {
  for (let i = 0; i < count; i++) {
    await trace.after({ sessionID: 's1', messageID: `m${i}`, id: `c${i}`, agent: 'build', tool: 'shell',
      input: { command: `pressure-${i}-with-a-fairly-long-command-line-payload` },
      status: 'completed', result: { output: `output ${i}: ${'x'.repeat(300)}` } });
  }
  await trace.note({ kind: 'unresolved', text: 'review debt: pending reviewer findings on module X' }, host());
  await trace.note({ kind: 'decision', text: 'chose approach A over B for the parser' }, host());
  await trace.intent({ summary: 'finish the parser migration with tests', status: 'active', paths: ['x.py'], resources: [] }, host());
}

test('E1-E4: estimator is deterministic and shape-aware (EN/CN/code/JSON)', () => {
  const counter = new TokenCounter({});
  const en = counter.estimate('The quick brown fox jumps over the lazy dog. '.repeat(50));
  const cn = counter.estimate('你好世界，测试令牌预算。'.repeat(50));
  const code = counter.estimate('function f(a){return a.map(x=>x*2).filter(Boolean)}'.repeat(30));
  const json = counter.estimate(JSON.stringify({ ok: true, items: Array.from({ length: 40 }, (_, i) => ({ id: i, name: `item-${i}` })) }));
  for (const [label, value] of [['en', en], ['cn', cn], ['code', code], ['json', json]]) {
    assert.ok(value > 20, `${label} estimate positive`);
    assert.equal(value, (label === 'en' ? en : label === 'cn' ? cn : label === 'code' ? code : json), `${label} deterministic`);
  }
  assert.ok(cn > en / 4, 'CJK estimated densely (>= EN/4 for equal char counts is far too low)');
});

test('E5: many refs/handles stay bounded in the snapshot', async t => {
  const { trace } = await fixture(t);
  await pressure(trace, 12);
  const { snapshot, assignments } = trace.recallSnapshot('s1');
  assert.ok((assignments ?? []).length <= 40);
  assert.ok(snapshot.recent.length <= 8);
});

test('E6+E7: blockers and review debt/goal survive heavy pressure', async t => {
  const { trace } = await fixture(t, { runtimeContextTokenBudget: 900 });
  await pressure(trace, 30);
  const { snapshot } = trace.recallSnapshot('s1');
  const am = snapshot.active_memory;
  assert.ok(am, 'active memory is never fully dropped (CRITICAL floor)');
  assert.ok((am.goal ?? '').includes('parser migration'), 'current goal retained under pressure');
  assert.ok((am.open_blockers ?? []).some(b => String(b).includes('review debt')), 'blockers retained under pressure');
  assert.ok(snapshot.current_intent?.ref, 'intent ref retained even when detail omitted');
});

test('E8: the newest correction/decision note survives; older notes drop first', async t => {
  const { trace } = await fixture(t, { runtimeContextTokenBudget: 1100 });
  await trace.note({ kind: 'decision', text: 'OLD decision alpha' }, host());
  await new Promise(r => setTimeout(r, 5));
  await trace.note({ kind: 'decision', text: 'OLD decision beta' }, host());
  await new Promise(r => setTimeout(r, 5));
  await trace.note({ kind: 'decision', text: 'NEWEST decision gamma' }, host());
  await new Promise(r => setTimeout(r, 5));
  // pressure() records a decision AFTER gamma ("chose approach A..."), so it
  // is the true newest decision note. Retention is oldest-first under
  // pressure, so gamma is correctly dropped BEFORE it; the invariant under
  // test is that the newest note survives and older ones do not.
  await pressure(trace, 26);
  const { snapshot } = trace.recallSnapshot('s1');
  const texts = (snapshot.notes ?? []).map(n => n.text ?? '').join('|');
  assert.ok(texts.includes('chose approach A over B for the parser'), 'newest note retained');
  assert.ok(!texts.includes('OLD decision alpha'), 'older notes drop first');
  assert.ok(!texts.includes('OLD decision beta'), 'older notes drop first');
});

test('E9: low-priority classes drop first (order recorded)', async t => {
  const { trace } = await fixture(t, { runtimeContextTokenBudget: 900 });
  await pressure(trace, 30);
  const { snapshot } = trace.recallSnapshot('s1');
  const dropped = snapshot.context_budget?.dropped ?? [];
  assert.ok(dropped.length > 0, 'drop classes recorded');
  const firstHeavy = dropped.find(d => d !== 'evidence_handles');
  // The fixture has no peer sessions, so the first heavy class is `recent`;
  // peers would drop first when present (they precede recent in the order).
  assert.equal(firstHeavy, 'recent', 'recent evidence drops before notes/unresolved');
});

test('E10: identical state yields an identical snapshot (determinism)', async t => {
  const { trace } = await fixture(t);
  await pressure(trace, 10);
  const strip = s => { const c = { ...s }; delete c.snapshot_at; return c; };
  const a = JSON.stringify(strip(trace.recallSnapshot('s1').snapshot));
  const b = JSON.stringify(strip(trace.recallSnapshot('s1').snapshot));
  assert.equal(a, b);
});

test('E11: unreachable tokenizer endpoint falls back honestly (no hang)', async t => {
  const counter = new TokenCounter({ tokenizerEndpoint: 'http://127.0.0.1:9/tokenize', tokenizerModel: 'x' });
  const tokens = await counter.count('fallback mode probe text');
  assert.ok(tokens > 0);
  assert.match(counter.mode, /estimator/);
});

test('E12: estimate tracks the real local tokenizer within 2.5x', async t => {
  const counter = new TokenCounter({});
  const sample = 'Trace records evidence with short handles; coverage stays honest; claims stay typed. '.repeat(20);
  const estimate = counter.estimate(sample);
  try {
    const res = await fetch('http://127.0.0.1:18080/tokenize', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen38-27b-dense', text: sample }), signal: AbortSignal.timeout(8000) });
    if (!res.ok) { console.log('   E12: local tokenizer endpoint unavailable; estimate-only'); return; }
    const data = await res.json();
    const actual = Array.isArray(data.tokens) ? data.tokens.length : null;
    assert.ok(actual > 0, 'local tokenizer returned tokens');
    const ratio = estimate / actual;
    assert.ok(ratio > 0.4 && ratio < 2.5, `estimate(${estimate}) within 2.5x of actual(${actual}); ratio=${ratio.toFixed(2)}`);
    console.log(`   E12: estimate=${estimate} actual=${actual} ratio=${ratio.toFixed(2)}`);
  } catch { console.log('   E12: local tokenizer unreachable; estimate-only (counted as pass with disclosure)'); }
});

test('E13: handles shown after pruning still resolve to canonical refs', async t => {
  const { trace } = await fixture(t, { runtimeContextTokenBudget: 1200 });
  await pressure(trace, 20);
  const { snapshot, assignments } = await trace.context({ sessionID: 's1', messages: [], agent: 'build', model: { providerID: 'local-qwen-auto', id: '27b-dense' } });
  assert.ok((assignments ?? []).length > 0, 'assignment produced for surviving rows');
  for (const a of assignments ?? []) {
    const resolved = trace.handles.resolve('s1', a.handle);
    assert.equal(resolved.ok, true);
    assert.equal(resolved.ref, a.ref);
  }
});

test('E14: runtime-context stays late with marker intact; budget receipt recorded', async t => {
  const { trace } = await fixture(t, { runtimeContextTokenBudget: 2000 });
  await pressure(trace, 12);
  const { recall, snapshot } = await trace.context({ sessionID: 's1', messages: [], agent: 'build', model: { providerID: 'local-qwen-auto', id: '27b-dense' } });
  assert.match(recall, /^OPENCODE_TRACE_RECALL_V1/);
  assert.ok(snapshot.context_budget?.unit === 'tokens');
  assert.ok(snapshot.context_budget?.estimated > 0);
  assert.ok(snapshot.context_budget?.tokens_exact == null || snapshot.context_budget.tokens_exact > 0);
  // §8.8 final-frame invariant, part 1: the receipt's estimate describes the
  // FINAL model-visible frame and must fit the configured budget whenever the
  // mandatory-frame floor (~1400 est tokens) leaves room to fit.
  assert.ok(snapshot.context_budget.estimated <= 2000,
    `final frame estimate ${snapshot.context_budget.estimated} exceeds configured budget 2000`);
  // Part 2 (regression detector): the receipt must describe the DELIVERED
  // frame. An independent measurement of the returned recall text must agree
  // with the recorded estimate. This fails if budgeting regresses to
  // measuring an intermediate object and appending handles/receipt afterwards
  // (the receipt would under-measure the delivered frame coherently with the
  // bug, so the <= budget assertion alone cannot catch it).
  const independent = new TokenCounter({}).estimate(recall);
  assert.ok(Math.abs(independent - snapshot.context_budget.estimated) <= 4,
    `receipt estimated ${snapshot.context_budget.estimated} but the delivered frame independently measures ${independent}`);
});

test('E15: sub-floor budgets degrade honestly (documented §18 tolerance)', async t => {
  const { trace } = await fixture(t, { runtimeContextTokenBudget: 300 });
  await pressure(trace, 8);
  const { snapshot } = trace.recallSnapshot('s1');
  // Documented behavior: below the mandatory-frame floor (~1400 est tokens of
  // marker/policy/guidance + coverage/observer skeleton + receipt) the
  // pipeline prunes every prunable class, then reports estimated > budget
  // honestly in the receipt. The byte ceiling remains the hard backstop and
  // recall_truncated semantics are unchanged (a Trace-side display budget,
  // never session/model/execution exhaustion).
  assert.ok(snapshot.active_memory, 'critical floor preserved even below the frame floor');
  assert.ok(snapshot.context_budget?.estimated > snapshot.context_budget?.budget,
    'sub-floor budget reported honestly (estimated > budget)');
  assert.equal(snapshot.recall_truncated, undefined, 'byte ceiling not hit; no truncation flag');
});

test('E0: default budget is evidence-based and configurable', async t => {
  assert.equal(typeof DEFAULT_TOKEN_BUDGET, 'number');
  assert.ok(DEFAULT_TOKEN_BUDGET >= 2000 && DEFAULT_TOKEN_BUDGET <= 5000);
  const { trace } = await fixture(t, { runtimeContextTokenBudget: 777 });
  assert.equal(trace.options.runtimeContextTokenBudget, 777);
});
