// Contract snapshot regression: any model-visible contract change must be
// reviewed and the snapshot re-blessed. Intentionally fails on unreviewed
// changes (descriptions, schemas, enums, required fields).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { definitions } from '../src/tools.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SNAP = path.join(here, '__snapshots__', 'contract-snapshot.json');
const REVIEWER_SCHEMA = '/home/frank/.local/share/opencode-runtime/current/plugins/inline-reviewer/src/schema.js';

test('contract snapshot matches blessed model-visible surface', async () => {
  const blessed = JSON.parse(await fs.readFile(SNAP, 'utf8'));
  const tools = definitions(null).map(d => ({ name: d.name, description: d.description, input: d.input }));
  const rev = await import(REVIEWER_SCHEMA);
  const current = {
    traceCommit: blessed.traceCommit,
    reviewerCommit: blessed.reviewerCommit,
    traceTools: tools,
    reviewer: { reviewInputSchema: rev.reviewInputSchema ?? null, REVIEW_TOOL_NAME: rev.REVIEW_TOOL_NAME ?? 'review' },
  };
  const hash = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
  assert.equal(
    hash(current),
    hash(blessed),
    `Model-visible contract changed without snapshot review. stored=${hash(blessed)} current=${hash(current)}. ` +
    `If intentional, re-bless tests/__snapshots__/contract-snapshot.json after review.`
  );
});

test('contract snapshot pins required safety invariants', async () => {
  const blessed = JSON.parse(await fs.readFile(SNAP, 'utf8'));
  const note = blessed.traceTools.find(t => t.name === 'trace_note');
  assert.ok(note, 'trace_note must exist in snapshot');
  assert.deepEqual(note.input.properties.kind.enum, ['fact', 'finding', 'decision', 'unresolved', 'handoff', 'correction']);
  assert.ok(!note.input.properties.kind.enum.includes('state_change'));
  assert.ok(note.input.properties.milestone.properties.kind.enum.includes('state_change'));
  assert.deepEqual(note.input.required ?? [], []);
  const expand = blessed.traceTools.find(t => t.name === 'trace_expand');
  assert.deepEqual(expand.input.required, ['ref']);
  assert.equal(blessed.reviewer.REVIEW_TOOL_NAME, 'review');
  assert.ok(blessed.reviewer.reviewInputSchema, 'reviewer schema must be captured');
});
