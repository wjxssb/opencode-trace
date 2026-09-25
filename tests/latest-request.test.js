import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Trace, RECALL_WORKFLOW } from '../src/trace.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-latest-request-'));
  const make = async () => { const trace = new Trace({ location: { directory: dir } }, { storeRoot: path.join(dir, 'store') }); await trace.ready; return trace; };
  const trace = await make();
  t.after(async () => { trace.store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { trace, make };
}
const host = (id = 'c1', messageID = 'm1') => ({ sessionID: 's1', messageID, id, agent: 'build' });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const snapshot = trace => JSON.parse(trace.recall('s1').split('\n').find(line => line.startsWith('{')));

test('a new handoff replaces the session\'s earlier handoffs; targeted handoffs stay separate', async t => {
  const { trace } = await fixture(t);
  const first = await trace.note({ kind: 'handoff', text: 'CONTINUATION: resume exactly here, implementing C' }, host('c1'));
  const targeted = await trace.note({ milestone: { kind: 'handoff', summary: 'for the reviewer', to_worker: 'reviewer' } }, host('c2'));
  await tick();
  const second = await trace.note({ kind: 'handoff', text: 'C SEGMENT COMPLETE; stopped for restart' }, host('c3'));
  assert.deepEqual(second.note.auto_superseded, [first.ref]);
  assert.ok(second.note.supersedes.includes(first.ref));
  assert.ok(!second.note.supersedes.includes(targeted.ref));
  const refs = snapshot(trace).notes.map(note => note.ref);
  assert.ok(!refs.includes(first.ref), 'the stale continuation handoff no longer appears in recall');
  assert.ok(refs.includes(second.ref) && refs.includes(targeted.ref));
});

test('recall names the latest user request and flags notes written before it, also after a restart', async t => {
  const { trace, make } = await fixture(t);
  const before = await trace.note({ kind: 'handoff', text: 'C-REWORK COMPLETE; next: production smoke then M2' }, host('c1'));
  await tick();
  await trace.prompt({ ...host('p1', 'm_d1'), prompt: { text: '审计：Post-restart 冒烟已确认。以下 D1 修正并入 D2 之前完成。', files: [], agents: [] } });
  await tick();
  const after = await trace.note({ kind: 'finding', text: 'typst digest cross-checked' }, host('c2'));
  const check = recall => {
    assert.match(recall, /Latest user request \([^)]+\): "审计：Post-restart 冒烟已确认。以下 D1 修正并入 D2 之前完成。"\. It is the current task/);
    const view = JSON.parse(recall.split('\n').find(line => line.startsWith('{')));
    assert.equal(view.latest_user_request.message_id, 'm_d1');
    assert.equal(view.notes.find(note => note.ref === before.ref).predates_latest_user_request, true);
    assert.equal(view.notes.find(note => note.ref === after.ref).predates_latest_user_request, undefined);
  };
  check(trace.recall('s1'));
  // A fresh process rebuilds the pointer from the durable prompt.received event.
  trace.store.close();
  const restarted = await make();
  t.after(() => restarted.store.close());
  const out = await restarted.context({ sessionID: 's1', messages: [] });
  check(out.recall);
});

test('workflow guidance no longer tells the model to resume from notes', () => {
  assert.ok(!/Resume from unsuperseded notes/.test(RECALL_WORKFLOW));
  assert.match(RECALL_WORKFLOW, /predates_latest_user_request never replaces or re-issues that request/);
});

test('a short summary beside a longer text is kept as the note summary instead of rejecting the note', async t => {
  const { trace } = await fixture(t);
  const body = '收尾完成（review looks_good）。HEAD=25d78d1，6 个提交；验证 203/203；停在重启点。';
  const both = await trace.note({ kind: 'handoff', summary: '收尾完成——停在重启点', text: body,
    milestone: { kind: 'state_change', summary: '收尾完成：review PASS；等用户重启' } }, host('c1'));
  assert.equal(both.note.text, body);
  assert.equal(both.note.summary, '收尾完成——停在重启点');
  assert.equal(both.note.milestone.summary, '收尾完成：review PASS；等用户重启');
  // Without a milestone summary, the short summary fills it rather than the long body.
  const filled = await trace.note({ kind: 'finding', summary: 'typst digest verified', text: 'Cross-checked against the release API digest.',
    milestone: { kind: 'verification' } }, host('c2'));
  assert.equal(filled.note.milestone.summary, 'typst digest verified');
  // Alone, summary is still the text; identical values store no separate summary.
  const alone = await trace.note({ kind: 'fact', summary: 'only summary' }, host('c3'));
  assert.equal(alone.note.text, 'only summary');
  assert.equal(alone.note.summary, undefined);
  const same = await trace.note({ kind: 'fact', summary: 'same', text: 'same' }, host('c4'));
  assert.equal(same.note.summary, undefined);
  await assert.rejects(trace.note({ kind: 'fact', summary: 'x'.repeat(2049), text: 'body' }, host('c5')), /summary exceeds 2048/);
  // Stored notes carry it into recall.
  assert.ok(snapshot(trace).notes.some(note => note.summary === '收尾完成——停在重启点'));
});
