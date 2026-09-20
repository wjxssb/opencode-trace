import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Trace } from '../src/trace.js';
import { definitions } from '../src/tools.js';

const host = (sessionID = 'worker', id = 'call') => ({ sessionID, messageID: 'turn', id, agent: 'build' });

async function fixture(t, session = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-milestone-test-'));
  const trace = new Trace({ location: { directory }, session }, { storeRoot: path.join(directory, 'store') });
  await trace.ready;
  t.after(async () => { await trace.store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { trace, directory };
}

const parseRecall = text => JSON.parse(text.split('\n')[2]);

test('Scenario 1: Decision - new decision appears in Active Memory', async t => {
  const { trace } = await fixture(t);
  const ev = await trace.after({ ...host(), tool: 'read', input: { path: 'kernel.cu' }, status: 'completed', result: { output: 'kernel v1' } });
  const note = await trace.note({
    kind: 'decision',
    text: 'Architecture decision: use radix sort',
    source_refs: [ev.ref],
    milestone: {
      kind: 'decision',
      summary: 'Adopt radix sort for deterministic sorting',
      decision: 'Radix sort instead of quicksort for reproducibility',
      evidence_refs: [ev.ref]
    }
  }, host());
  assert.ok(note.ref);
  const recall = trace.recall('worker');
  const view = parseRecall(recall);
  assert.ok(view.active_memory);
  assert.ok(view.active_memory.latest_decisions.some(d => d.includes('Radix sort instead of quicksort')));
  assert.ok(view.active_memory.evidence_refs.includes(ev.ref));
  assert.ok(recall.includes('Radix sort instead of quicksort'));
});

test('Scenario 2: Duplicate noise - consecutive ordinary tool calls do not create milestone spam', async t => {
  const { trace } = await fixture(t);
  const initialNotes = trace.store.session('worker').notes.length;
  for (let i = 0; i < 10; i++) {
    await trace.after({ ...host(), tool: 'read', input: { path: `file_${i}.txt` }, status: 'completed', result: { output: `content ${i}` } });
    await trace.after({ ...host(), tool: 'shell', input: { command: `echo ${i}` }, status: 'completed', result: { output: `${i}\n` } });
  }
  const afterNotes = trace.store.session('worker').notes.length;
  assert.equal(afterNotes, initialNotes, 'Ordinary tool calls must not produce any milestone notes');
});

test('Scenario 3: FAIL -> PASS - state transition automatically generates state_change milestone', async t => {
  const { trace } = await fixture(t);
  // Initial failure
  const failEv = await trace.after({
    ...host(),
    tool: 'shell',
    input: { command: 'node --test parser.test.js' },
    status: 'completed',
    result: { output: '✖ parser fails on zero input\nFAIL' }
  });
  const notesAfterFail = [...trace.store.session('worker').notes];
  
  // Later fix passes
  const passEv = await trace.after({
    ...host(),
    tool: 'shell',
    input: { command: 'node --test parser.test.js' },
    status: 'completed',
    result: { output: '✔ all 12 tests passed\nPASS' }
  });
  const notesAfterPass = trace.store.session('worker').notes;
  assert.ok(notesAfterPass.length > notesAfterFail.length, 'FAIL -> PASS must generate a milestone');
  const latestNote = notesAfterPass[notesAfterPass.length - 1];
  assert.equal(latestNote.milestone?.kind, 'state_change');
  assert.equal(latestNote.milestone?.current_state, 'PASS');
  assert.ok(latestNote.milestone?.evidence_refs.includes(passEv.ref));
  
  const view = parseRecall(trace.recall('worker'));
  assert.equal(view.active_memory.current_state, 'PASS');
});

test('Scenario 4: PASS -> PASS - no semantic change does not duplicate checkpoint', async t => {
  const { trace } = await fixture(t);
  // First fail then pass to trigger milestone
  await trace.after({ ...host(), tool: 'shell', input: { command: 'npm test' }, status: 'completed', result: { output: 'FAIL' } });
  await trace.after({ ...host(), tool: 'shell', input: { command: 'npm test' }, status: 'completed', result: { output: 'PASS' } });
  const countAfterFirstPass = trace.store.session('worker').notes.length;

  // Second pass with same command
  await trace.after({ ...host(), tool: 'shell', input: { command: 'npm test' }, status: 'completed', result: { output: 'PASS' } });
  const countAfterSecondPass = trace.store.session('worker').notes.length;
  assert.equal(countAfterSecondPass, countAfterFirstPass, 'PASS -> PASS must not produce duplicate milestones');
});

test('Scenario 5: Blocker resolved - old blocker is superseded and exits Active Memory', async t => {
  const { trace } = await fixture(t);
  const blocker = await trace.note({
    kind: 'unresolved',
    text: 'Blocker: cuda kernel memory alignment issue',
    source_refs: [],
    milestone: { kind: 'blocker', summary: 'cuda kernel memory alignment issue' }
  }, host());
  
  let view = parseRecall(trace.recall('worker'));
  assert.ok(view.active_memory.open_blockers.some(b => b.includes('memory alignment')));
  
  // Resolve blocker
  const ev = await trace.after({ ...host(), tool: 'shell', input: { command: 'make test' }, status: 'completed', result: { output: 'PASS' } });
  await trace.note({
    kind: 'finding',
    text: 'Alignment fixed with 128-byte padding',
    source_refs: [ev.ref],
    supersedes: [blocker.ref],
    milestone: {
      kind: 'state_change',
      summary: 'CUDA memory alignment resolved',
      current_state: 'PASS',
      evidence_refs: [ev.ref],
      supersedes: [blocker.ref]
    }
  }, host());

  view = parseRecall(trace.recall('worker'));
  assert.ok(!view.active_memory.open_blockers.some(b => b.includes('memory alignment')), 'Resolved blocker must exit active memory');
  assert.equal(view.active_memory.open_blockers.length, 0);
  assert.ok(trace.recall('worker').includes('Open blockers: (none)'));
});

test('Scenario 6: Correction - old finding disproved, correction becomes current state while old remains in history', async t => {
  const { trace } = await fixture(t);
  const ev1 = await trace.after({ ...host(), tool: 'read', input: { path: 'log.txt' }, status: 'completed', result: { output: 'error 79' } });
  const oldFinding = await trace.note({
    kind: 'finding',
    text: 'Suspected root cause: GPU hardware ECC fault',
    source_refs: [ev1.ref],
    milestone: { kind: 'verification', summary: 'GPU hardware ECC fault suspected', current_state: 'CLAIMED / UNVERIFIED' }
  }, host());

  const ev2 = await trace.after({ ...host(), tool: 'shell', input: { command: 'nvidia-smi -q' }, status: 'completed', result: { output: 'ECC errors: 0' } });
  const correction = await trace.note({
    kind: 'correction',
    text: 'ECC fault disproved by nvidia-smi; real cause is software page lock failure',
    source_refs: [ev2.ref],
    supersedes: [oldFinding.ref],
    milestone: {
      kind: 'correction',
      summary: 'Disproved ECC fault; confirmed software page lock failure',
      what_changed: 'Replaced hardware diagnosis with page lock driver defect',
      current_state: 'VERIFIED',
      evidence_refs: [ev2.ref],
      supersedes: [oldFinding.ref]
    }
  }, host());

  const view = parseRecall(trace.recall('worker'));
  // Active Memory reflects correction
  assert.ok(view.active_memory.verified_state.includes('software page lock failure'));
  
  // Historical query still finds the disproved finding
  const found = await trace.find({ type: 'trace.note', session: 'worker' });
  const refs = found.results.map(r => r.ref);
  assert.ok(refs.includes(oldFinding.ref), 'Old finding must remain searchable in raw history');
  assert.ok(refs.includes(correction.ref));
});

test('Scenario 7: Baseline promotion - candidate promotes to production baseline, old baseline exits', async t => {
  const { trace } = await fixture(t);
  const b1 = await trace.note({
    kind: 'fact',
    text: 'Initial candidate baseline: v0.1.0-alpha',
    source_refs: [],
    milestone: { kind: 'baseline', summary: 'v0.1.0-alpha baseline' }
  }, host());

  let view = parseRecall(trace.recall('worker'));
  assert.equal(view.active_memory.baseline, 'v0.1.0-alpha baseline');

  const ev = await trace.after({ ...host(), tool: 'shell', input: { command: 'pytest -q' }, status: 'completed', result: { output: '100 passed in 2.1s\nPASS' } });
  await trace.note({
    kind: 'fact',
    text: 'Promoted to production baseline: v1.0.0-verified',
    source_refs: [ev.ref],
    milestone: {
      kind: 'baseline',
      summary: 'v1.0.0-verified production baseline',
      current_state: 'PASS',
      evidence_refs: [ev.ref],
      supersedes: [b1.ref]
    }
  }, host());

  view = parseRecall(trace.recall('worker'));
  assert.equal(view.active_memory.baseline, 'v1.0.0-verified production baseline');
  assert.ok(!view.active_memory.baseline.includes('v0.1.0-alpha'));
});

test('Scenario 8: Compact survival - state preserved before compact and survives missing/malformed compact map', async t => {
  const { trace } = await fixture(t);
  const ev = await trace.after({ ...host(), tool: 'read', input: { path: 'spec.md' }, status: 'completed', result: { output: 'spec' } });
  await trace.note({
    kind: 'finding',
    text: 'Regression tests passing, benchmark remaining',
    source_refs: [ev.ref],
    milestone: {
      kind: 'state_change',
      summary: 'Regression verified',
      current_state: 'PASS',
      decision: 'Stick to static batching',
      unresolved: ['Long context soak test'],
      next_action: 'Run 128k soak benchmark',
      do_not_repeat: ['Do not use dynamic resolver'],
      evidence_refs: [ev.ref]
    }
  }, host());

  // Simulate compaction without trace map (causes recovery_gap: missing_map)
  await trace.observeMessages('worker', [
    { type: 'compaction', id: 'cmp_missing_map', summary: 'Regular summary without any opencode-trace-map tag', time: { created: Date.now() }, status: 'completed' }
  ]);

  // Verify recovery_gap was created
  const gap = trace.store.findEntriesAll({ type: 'recovery_gap', session: 'worker' });
  assert.ok(gap.length > 0, 'Compaction should produce recovery_gap on missing map');

  // Next session / turn recall still successfully recovers critical milestone memory
  const view = parseRecall(trace.recall('worker'));
  assert.ok(view.active_memory);
  assert.equal(view.active_memory.current_state, 'PASS');
  assert.ok(view.active_memory.open_blockers.some(b => b.includes('Long context soak test')));
  assert.equal(view.active_memory.next_action, 'Run 128k soak benchmark');
  assert.ok(view.active_memory.do_not_repeat.includes('Do not use dynamic resolver'));
});

test('Scenario 9: Handoff - Worker A creates handoff milestone, Worker B sees it on turn 1 recall', async t => {
  const { trace } = await fixture(t);
  const ev = await trace.after({ ...host('worker_a'), tool: 'shell', input: { command: 'cargo build' }, status: 'completed', result: { output: 'Finished release\nPASS' } });
  await trace.note({
    kind: 'handoff',
    text: 'Worker A handoff to Worker B: Core parser complete, tokenizer tests pending',
    source_refs: [ev.ref],
    milestone: {
      kind: 'handoff',
      to_session: 'worker_b',
      summary: 'Core parser complete; tokenizer tests pending',
      what_changed: 'Implemented parser syntax tree in AST.rs',
      current_state: 'PASS',
      unresolved: ['Add tokenizer edge cases for Unicode'],
      next_action: 'Implement unicode normalization in tokenizer.rs',
      do_not_repeat: ['Do not use regex for utf8 splitting'],
      evidence_refs: [ev.ref]
    }
  }, host('worker_a'));

  // Worker B enters on Turn 1 with explicit binding -> successfully inherits handoff
  const recallB = trace.recall('worker_b');
  const viewB = parseRecall(recallB);
  assert.equal(viewB.active_memory.current_state, 'PASS');
  assert.equal(viewB.active_memory.next_action, 'Implement unicode normalization in tokenizer.rs');
  assert.ok(viewB.active_memory.open_blockers.some(b => b.includes('Add tokenizer edge cases')));
  assert.ok(viewB.active_memory.do_not_repeat.includes('Do not use regex for utf8 splitting'));
  assert.ok(viewB.active_memory.evidence_refs.includes(ev.ref));
  assert.ok(viewB.peers.some(p => p.sessionID === 'worker_a' && p.handoff && p.handoff.current_state === 'PASS'));
  assert.ok(recallB.includes('Inherited handoff from worker_a'));
  assert.ok(recallB.includes('Next action: Implement unicode normalization in tokenizer.rs'));

  // Worker C enters with unrelated task (no handoff binding) -> 0 inherited handoff
  const recallC = trace.recall('worker_c');
  const viewC = parseRecall(recallC);
  assert.equal(viewC.active_memory.handoff_source, undefined);
  assert.equal(viewC.active_memory.current_state, null);
  assert.equal(viewC.active_memory.next_action, null);
  assert.equal(viewC.active_memory.open_blockers.length, 0);
  assert.equal(viewC.active_memory.do_not_repeat.length, 0);
});

test('Scenario 10: Evidence semantics - worker self-claim without evidence stays CLAIMED / UNVERIFIED', async t => {
  const { trace } = await fixture(t);
  // Claim VERIFIED without any source_refs or evidence_refs
  const unverified = await trace.note({
    kind: 'finding',
    text: 'I manually verified the fix, everything passes',
    source_refs: [],
    milestone: {
      kind: 'verification',
      summary: 'Fix verified by assertion',
      current_state: 'VERIFIED',
      evidence_refs: []
    }
  }, host());
  assert.equal(unverified.note.milestone.current_state, 'CLAIMED / UNVERIFIED');

  // Claim VERIFIED with another trace.note as evidence_refs (provenance only, not execution evidence)
  const noteEvidence = await trace.note({ kind: 'finding', text: 'Preceding hypothesis note' }, host());
  const pseudoVerified = await trace.note({
    kind: 'finding',
    text: 'Claiming verified with a note ref',
    source_refs: [noteEvidence.ref],
    milestone: {
      kind: 'verification',
      summary: 'Fix claimed via note ref',
      current_state: 'VERIFIED',
      evidence_refs: [noteEvidence.ref]
    }
  }, host());
  assert.equal(pseudoVerified.note.milestone.current_state, 'CLAIMED / UNVERIFIED', 'Note ref is provenance only and must not elevate to VERIFIED');

  // Claim with valid evidence ref (tool.after from pytest with completed status) retains VERIFIED
  const ev = await trace.after({ ...host(), tool: 'shell', input: { command: 'pytest' }, status: 'completed', result: { output: 'PASS' } });
  const verified = await trace.note({
    kind: 'finding',
    text: 'Verified by pytest run',
    source_refs: [ev.ref],
    milestone: {
      kind: 'verification',
      summary: 'Pytest verified',
      current_state: 'VERIFIED',
      evidence_refs: [ev.ref]
    }
  }, host());
  assert.equal(verified.note.milestone.current_state, 'VERIFIED');
});

test('Scenario 11: Historical compatibility - real historical trace store loads cleanly without errors', { skip: process.env.TRACE_TEST_LIVE_HISTORY !== '1' }, async t => {
  const realStorePath = '/home/frank/.local/share/opencode-trace';
  const trace = new Trace({ location: { directory: '/home/frank' } }, { storeRoot: realStorePath });
  await trace.ready;
  assert.ok(trace.store.index.size > 20000, 'Should load real events from store');
  const sessionIDs = [...trace.store.sessions.keys()];
  assert.ok(sessionIDs.length > 50, 'Should load real session projections');
  
  // Query arbitrary existing session and test projection
  const sampleSid = 'ses_f73ba176affe8RuF8MXlOSHKHK';
  if (trace.store.sessions.has(sampleSid)) {
    const proj = trace.projection(sampleSid);
    assert.ok(proj.active_memory, 'Historical session projection should compute active_memory');
    const recall = trace.recall(sampleSid);
    assert.ok(recall.includes('OPENCODE_TRACE_RECALL_V1'));
    const parsed = parseRecall(recall);
    assert.ok(parsed.active_memory !== undefined);
  }
  await trace.store.close();
});

test('Scenario 12: Real E2E Drill - multi-phase task recovery across session/restart boundary', async t => {
  const { trace, directory } = await fixture(t);
  
  // Phase 1: Agent A declares intent and makes architecture decision
  await trace.intent({ summary: 'Implement fault-tolerant P2P communication', paths: ['p2p.js'], status: 'active' }, host('ses_agent_a'));
  const dEv = await trace.after({ ...host('ses_agent_a'), tool: 'read', input: { path: 'arch.md' }, status: 'completed', result: { output: 'P2P spec v2' } });
  await trace.note({
    kind: 'decision',
    text: 'Adopt heartbeat watchdog with exponential backoff',
    source_refs: [dEv.ref],
    milestone: {
      kind: 'decision',
      summary: 'P2P watchdog architecture',
      decision: 'Heartbeat watchdog with exponential backoff (100ms - 5s)',
      evidence_refs: [dEv.ref]
    }
  }, host('ses_agent_a'));

  // Phase 2: Agent A encounters a test failure
  const failEv = await trace.after({
    ...host('ses_agent_a'),
    tool: 'shell',
    input: { command: 'node test_p2p.js' },
    status: 'completed',
    result: { output: 'AssertionError: heartbeat timeout not triggered on dead peer\nFAIL' }
  });

  // Phase 3: Agent A disproves wrong hypothesis & records correction
  const corrEv = await trace.after({
    ...host('ses_agent_a'),
    tool: 'read',
    input: { path: 'p2p.js' },
    status: 'completed',
    result: { output: 'socket.setTimeout ignored on closed socket' }
  });
  await trace.note({
    kind: 'correction',
    text: 'Heartbeat failure was caused by socket event listener leak, not timer resolution',
    source_refs: [corrEv.ref],
    milestone: {
      kind: 'correction',
      summary: 'Socket event listener leak identified as root cause',
      what_changed: 'Removed dangling error listener on disconnect',
      current_state: 'INVESTIGATING',
      evidence_refs: [corrEv.ref]
    }
  }, host('ses_agent_a'));

  // Phase 4: Agent A applies fix and tests PASS
  const passEv = await trace.after({
    ...host('ses_agent_a'),
    tool: 'shell',
    input: { command: 'node test_p2p.js' },
    status: 'completed',
    result: { output: '✔ 14/14 p2p tests passed\nPASS' }
  });

  // Phase 5: Handoff milestone with negative knowledge
  await trace.note({
    kind: 'handoff',
    text: 'Handoff to Agent B: P2P tests passing, soak test remaining',
    source_refs: [passEv.ref],
    milestone: {
      kind: 'handoff',
      summary: 'P2P core verified, soak verification remaining',
      what_changed: 'Fixed socket leak; 14 tests pass',
      current_state: 'PASS',
      unresolved: ['10-minute network partition soak test'],
      next_action: 'Run soak test: bash run_soak.sh 600',
      do_not_repeat: ['Do not use unbuffered socket streams', 'Do not reduce watchdog timer below 50ms'],
      evidence_refs: [passEv.ref]
    }
  }, host('ses_agent_a'));

  // Phase 6: Service restart / new session Agent B arrives
  await trace.store.close();
  const restartedTrace = new Trace({ location: { directory } }, { storeRoot: path.join(directory, 'store') });
  await restartedTrace.ready;
  t.after(async () => { await restartedTrace.store.close(); });

  // Agent B inspects recall from Agent A's handoff
  const recall = restartedTrace.recall('ses_agent_a');
  const view = parseRecall(recall);
  const am = view.active_memory;

  // Agent B accurately recovers key project state directly from Active Memory:
  assert.equal(am.goal, 'Implement fault-tolerant P2P communication');
  assert.equal(am.current_state, 'PASS');
  assert.ok(am.latest_decisions.some(d => d.includes('Heartbeat watchdog with exponential backoff')));
  assert.ok(am.open_blockers.some(b => b.includes('10-minute network partition soak test')));
  assert.equal(am.next_action, 'Run soak test: bash run_soak.sh 600');
  assert.ok(am.do_not_repeat.includes('Do not use unbuffered socket streams'));
  assert.ok(am.evidence_refs.includes(passEv.ref));

  // The human-readable text block is also directly verified:
  assert.ok(recall.includes('=== ACTIVE MILESTONE MEMORY ==='));
  assert.ok(recall.includes('Goal: Implement fault-tolerant P2P communication'));
  assert.ok(recall.includes('Next action: Run soak test: bash run_soak.sh 600'));
});

test('Scenario 13: 64-note eviction immunity - unsuperseded decision survives 70+ subsequent notes', async t => {
  const { trace } = await fixture(t);
  
  // Step 1: Record an old architectural decision that is never superseded
  const oldDecision = await trace.note({
    kind: 'decision',
    text: 'Core architecture: Zero-copy ring buffer with memory map',
    milestone: {
      kind: 'decision',
      summary: 'Zero-copy ring buffer',
      decision: 'Zero-copy ring buffer with memory map'
    }
  }, host());

  // Step 2: Ingest 70 ordinary notes (which exceeds 64-note window)
  for (let i = 0; i < 70; i++) {
    await trace.note({
      kind: 'finding',
      text: `Routine log analysis step ${i}`
    }, host());
  }

  const s = trace.store.session('worker');
  assert.equal(s.notes.length, 64, 's.notes must stay bounded at 64');
  assert.ok(!s.notes.some(n => n.ref === oldDecision.ref), 'Old decision is evicted from bounded s.notes');

  // Step 3: Active memory still retains the old unsuperseded decision!
  const view = parseRecall(trace.recall('worker'));
  assert.ok(view.active_memory.latest_decisions.some(d => d.includes('Zero-copy ring buffer')), 'Active memory must retain unsuperseded decision despite 64-note eviction');
});

test('Scenario 14: Active Memory 2048-byte hard cap & priority pruning', async t => {
  const { trace } = await fixture(t);

  // Create an oversized active memory state with lots of decisions, blockers, do_not_repeat, etc.
  const ev = await trace.after({ ...host(), tool: 'shell', input: { command: 'make' }, status: 'completed', result: { output: 'PASS' } });
  
  for (let i = 0; i < 8; i++) {
    await trace.note({
      kind: 'decision',
      text: `Important architectural decision ${i}: ` + 'X'.repeat(200),
      milestone: {
        kind: 'decision',
        summary: `Decision ${i}`,
        decision: `Important architectural decision ${i}: ` + 'X'.repeat(200),
        evidence_refs: [ev.ref]
      }
    }, host());
  }

  await trace.note({
    kind: 'finding',
    text: 'State with many constraints',
    source_refs: [ev.ref],
    milestone: {
      kind: 'state_change',
      summary: 'Large state change',
      current_state: 'PASS',
      unresolved: ['Blocker 1: ' + 'B'.repeat(100), 'Blocker 2: ' + 'B'.repeat(100), 'Blocker 3: ' + 'B'.repeat(100)],
      next_action: 'Perform full system integration benchmark: ' + 'A'.repeat(100),
      do_not_repeat: ['DNR 1: ' + 'N'.repeat(100), 'DNR 2: ' + 'N'.repeat(100), 'DNR 3: ' + 'N'.repeat(100)],
      evidence_refs: [ev.ref]
    }
  }, host());

  const view = parseRecall(trace.recall('worker'));
  const am = view.active_memory;
  const byteSize = Buffer.byteLength(JSON.stringify(am), 'utf8');
  assert.ok(byteSize <= 2048, `Active memory JSON size (${byteSize}B) must not exceed 2048B hard cap`);
  // Core state must be preserved
  assert.equal(am.current_state, 'PASS');
  assert.ok(am.open_blockers.length > 0, 'Open blockers must be preserved within budget');
});

test('Scenario 15: Cross-task handoff contamination prevention & explicit binding inheritance', async t => {
  const { trace } = await fixture(t);

  // Worker A: Task A - Database migration
  await trace.intent({ summary: 'Task A: migrate database', status: 'active', paths: ['db.sql'] }, host('worker_a'));
  const evA = await trace.after({ ...host('worker_a'), tool: 'shell', input: { command: 'migrate.sh' }, status: 'completed', result: { output: 'PASS' } });
  await trace.note({
    kind: 'handoff',
    text: 'Worker A handoff: DB migration blocker and negative rules',
    source_refs: [evA.ref],
    milestone: {
      kind: 'handoff',
      summary: 'DB migration status',
      current_state: 'INVESTIGATING',
      unresolved: ['DB migration blocker'],
      next_action: 'Run DB migration',
      do_not_repeat: ['Do not drop users table'],
      evidence_refs: [evA.ref]
      // NOTE: No to_session/to_worker specified for worker_b!
    }
  }, host('worker_a'));

  // Worker B: Unrelated Task B - Fix CSS button
  await trace.intent({ summary: 'Task B: fix CSS button', status: 'active', paths: ['style.css'] }, host('worker_b'));
  const recallBUnrelated = trace.recall('worker_b');
  const viewBUnrelated = parseRecall(recallBUnrelated);
  const amB = viewBUnrelated.active_memory;

  // VERIFICATION 1: Worker B must have 0 inherited handoff from Task A!
  assert.equal(amB.goal, 'Task B: fix CSS button');
  assert.equal(amB.handoff_source, undefined, 'Unrelated task must not have handoff_source');
  assert.ok(!amB.open_blockers.some(b => b.includes('DB migration')), 'Task B must not inherit DB blocker');
  assert.ok(amB.next_action !== 'Run DB migration', 'Task B must not inherit DB next_action');
  assert.ok(!amB.do_not_repeat.some(r => r.includes('users table')), 'Task B must not inherit DB do_not_repeat');

  // VERIFICATION 2: Explicit handoff from Worker A to Worker B
  await trace.note({
    kind: 'handoff',
    text: 'Worker A explicitly handing off to Worker B',
    source_refs: [evA.ref],
    milestone: {
      kind: 'handoff',
      to_session: 'worker_b',
      summary: 'Explicit DB migration handoff to worker_b',
      current_state: 'PASS',
      unresolved: ['DB migration blocker'],
      next_action: 'Run DB migration',
      do_not_repeat: ['Do not drop users table'],
      evidence_refs: [evA.ref]
    }
  }, host('worker_a'));

  // Worker B checks recall with explicit binding
  const recallBBound = trace.recall('worker_b');
  const viewBBound = parseRecall(recallBBound);
  const amBBound = viewBBound.active_memory;

  // VERIFICATION 3: Worker B now receives the explicit handoff!
  assert.equal(amBBound.current_state, 'PASS');
  assert.equal(amBBound.next_action, 'Run DB migration');
  assert.ok(amBBound.open_blockers.some(b => b.includes('DB migration blocker')));
  assert.ok(amBBound.do_not_repeat.some(r => r.includes('Do not drop users table')));
  assert.equal(amBBound.handoff_source.sessionID, 'worker_a');
});

test('Scenario 16: Same-parent unrelated siblings must have 0 inherited handoff', async t => {
  const { trace } = await fixture(t);

  // Both workers share the same parentID: 'supervisor'
  const hostDB = { sessionID: 'worker_db', parentID: 'supervisor', messageID: 'm1' };
  const hostCSS = { sessionID: 'worker_css', parentID: 'supervisor', messageID: 'm2' };

  await trace.intent({ summary: 'Migrate database to postgres', status: 'active', paths: ['db.sql'] }, hostDB);
  const evDB = await trace.after({ ...hostDB, tool: 'shell', input: { command: 'migrate.sh' }, status: 'completed', result: { output: 'PASS' } });

  await trace.note({
    kind: 'handoff',
    text: 'DB worker handoff: Migration blocker',
    source_refs: [evDB.ref],
    milestone: {
      kind: 'handoff',
      summary: 'DB migration blocker',
      unresolved: ['DB migration blocker'],
      next_action: 'Run DB migration',
      do_not_repeat: ['Do not drop users table'],
      evidence_refs: [evDB.ref]
      // No explicit to_session or task_ref
    }
  }, hostDB);

  // Sibling CSS worker enters
  await trace.intent({ summary: 'Fix responsive CSS layout', status: 'active', paths: ['layout.css'] }, hostCSS);
  const recallCSS = trace.recall('worker_css');
  const viewCSS = parseRecall(recallCSS);
  const amCSS = viewCSS.active_memory;

  // Sibling CSS worker must NOT inherit from sibling DB worker
  assert.equal(amCSS.handoff_source, undefined, 'Sibling under same parent must not inherit handoff without explicit binding');
  assert.ok(!amCSS.open_blockers.some(b => b.includes('DB migration')));
  assert.ok(amCSS.next_action !== 'Run DB migration');
  assert.ok(!amCSS.do_not_repeat.some(r => r.includes('users table')));
});

test('Scenario 17: task_ref substring collision prevention', async t => {
  const { trace } = await fixture(t);

  const evA = await trace.after({ ...host('worker_a'), tool: 'shell', input: { command: 'test.sh' }, status: 'completed', result: { output: 'PASS' } });
  // Worker A handoff with task_ref = "123"
  await trace.note({
    kind: 'handoff',
    text: 'Handoff for task 123',
    source_refs: [evA.ref],
    milestone: {
      kind: 'handoff',
      task_ref: '123',
      summary: 'Task 123 handoff',
      next_action: 'Resolve task 123',
      evidence_refs: [evA.ref]
    }
  }, host('worker_a'));

  // Worker B has summary containing "1234", but NO structured task_ref === "123"
  await trace.intent({ summary: 'Fix issue 1234 in CSS', status: 'active', paths: ['button.css'] }, host('worker_b'));
  const recallB = trace.recall('worker_b');
  const viewB = parseRecall(recallB);
  const amB = viewB.active_memory;

  // Worker B must NOT inherit handoff due to substring collision
  assert.equal(amB.handoff_source, undefined, 'Substring task_ref match in free text must not bind handoff');
  assert.ok(amB.next_action !== 'Resolve task 123');
});

test('Scenario 18: to_worker/continuation_of agent-name matching must not bind same-parent siblings', async t => {
  const { trace } = await fixture(t);

  // Both workers share parentID 'supervisor' and the same agent name 'build'
  const hostDB = { sessionID: 'worker_db', parentID: 'supervisor', messageID: 'm1', agent: 'build' };
  const hostCSS = { sessionID: 'worker_css', parentID: 'supervisor', messageID: 'm2', agent: 'build' };

  const evDB = await trace.after({ ...hostDB, tool: 'shell', input: { command: 'migrate.sh' }, status: 'completed', result: { output: 'PASS' } });
  await trace.note({
    kind: 'handoff',
    text: 'DB worker broadcasts to build workers',
    source_refs: [evDB.ref],
    milestone: {
      kind: 'handoff',
      to_worker: 'build',
      summary: 'DB migration broadcast',
      unresolved: ['DB migration blocker'],
      next_action: 'Run DB migration',
      do_not_repeat: ['Do not drop users table'],
      evidence_refs: [evDB.ref]
    }
  }, hostDB);

  await trace.intent({ summary: 'Fix responsive CSS layout', status: 'active', paths: ['layout.css'] }, hostCSS);
  let am = parseRecall(trace.recall('worker_css')).active_memory;
  assert.equal(am.handoff_source, undefined, 'Sibling must not bind via to_worker agent name');
  assert.ok(!am.open_blockers.some(b => b.includes('DB migration')));
  assert.ok(am.next_action !== 'Run DB migration');
  assert.ok(!am.do_not_repeat.some(r => r.includes('users table')));

  // A continuation_of token that matches only the shared agent name must not bind siblings either
  await trace.note({
    kind: 'handoff',
    text: 'DB worker continuation broadcast to build workers',
    source_refs: [evDB.ref],
    milestone: {
      kind: 'handoff',
      continuation_of: 'build',
      summary: 'DB migration continuation broadcast',
      unresolved: ['DB migration blocker'],
      next_action: 'Run DB migration',
      do_not_repeat: ['Do not drop users table'],
      evidence_refs: [evDB.ref]
    }
  }, hostDB);

  am = parseRecall(trace.recall('worker_css')).active_memory;
  assert.equal(am.handoff_source, undefined, 'Sibling must not bind via continuation_of agent name');
  assert.ok(am.next_action !== 'Run DB migration');
});
