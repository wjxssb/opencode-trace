// Mechanical human-readable presentation for trace tool results (P1).
//
// Phase 0 spike evidence (real isolated host, 2026-09-11): the host persists
// a tool result as state.content (string, what the model reads and the TUI
// renders expanded) + state.metadata; top-level 'output'/'title' are not
// persisted and the declared output schema is not enforced on values.
//
// Contract implemented here:
//   content  = human Markdown (header + bullets) + a fenced machine block
//              so the model keeps byte-exact refs/cursors/payloads;
//   title    = one-line summary (trace events, reviewer display, future TUI);
//   metadata = { opencode_trace: true, raw } with raw size-bounded (oversized
//              metadata previously broke host delivery).
//
// Pure structural formatting ONLY — no LLM calls, no semantic classification,
// no guessing at importance. Every formatter is defensive: unexpected shapes
// degrade to a fenced JSON block of whatever was returned. Presentation never
// throws and never changes what is stored; exact bytes stay recoverable
// through trace_expand.

const RAW_LIMIT = 12288;     // metadata.raw bound (host delivery safety)

function safeJson(value) {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function compactJson(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

/** Single-line clipped text for titles and bullets. */
function clip(text, max = 110) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

function iso(at) {
  if (Number.isFinite(at)) return new Date(at).toISOString();
  return String(at ?? '');
}

/** Refs as inline code, bounded, with an overflow marker. */
function refList(refs, max = 8) {
  if (!Array.isArray(refs) || refs.length === 0) return '(none)';
  const head = refs.slice(0, max).map(r => `\`${r}\``).join(', ');
  return refs.length > max ? `${head} … (+${refs.length - max} more)` : head;
}

function fence(json, lang = 'json') {
  return '```' + lang + '\n' + json + '\n```';
}

function bullets(lines) {
  return lines.filter(Boolean).map(l => `- ${l}`).join('\n');
}

function document(title, body) {
  return `### ${title}\n\n${body}`;
}

/** Format one trace_find entry row (index mode). */
function findEntryLine(entry) {
  if (!entry || typeof entry !== 'object') return '- (malformed entry)';
  const head = [`\`${entry.ref ?? '?'}\``, entry.type ?? '?'];
  if (entry.tool) head.push(`tool=${entry.tool}`);
  if (entry.status) head.push(`status=${entry.status}`);
  if (Number.isFinite(entry.at)) head.push(iso(entry.at));
  const parts = ['- ' + head.join(' · ')];
  if (entry.hit?.snippet) parts.push(`  hit: ${clip(entry.hit.snippet, 160)}`);
  if (Array.isArray(entry.paths) && entry.paths.length) parts.push(`  paths: ${clip(entry.paths.join(', '), 140)}`);
  return parts.join('\n');
}

/** Deep-scan hit line. */
function deepHitLine(hit) {
  if (!hit || typeof hit !== 'object') return '- (malformed hit)';
  return `- \`${hit.event_ref ?? '?'}\` · blob \`${hit.blob_ref ?? '?'}\` · byte ${hit.byte_offset ?? '?'}\n  ${clip(hit.snippet ?? '', 160)}`;
}

const formatters = {
  trace_note(value) {
    const note = value?.note ?? {};
    const ms = note.milestone;
    const title = ms ? `Milestone saved (${ms.kind ?? note.kind ?? '?'})` : `Note saved (${note.kind ?? '?'})`;
    const body = bullets([
      `**text**: ${clip(note.text ?? ms?.summary ?? '', 220)}`,
      ms?.current_state ? `**current state**: ${ms.current_state}` : null,
      ms?.what_changed ? `**what changed**: ${clip(ms.what_changed, 160)}` : null,
      ms?.next_action ? `**next action**: ${clip(ms.next_action, 160)}` : null,
      ms?.do_not_repeat?.length ? `**do not repeat**: ${ms.do_not_repeat.join('; ')}` : null,
      note.source_refs?.length ? `**source refs**: ${refList(note.source_refs)}` : null,
      note.supersedes?.length ? `**supersedes**: ${refList(note.supersedes)}` : null,
      note.depends_on?.length ? `**depends on**: ${refList(note.depends_on)}` : null,
      value.ref ? `**ref**: \`${value.ref}\`` : null,
    ]);
    return { title, content: document(title, body) };
  },

  trace_intent(value) {
    const intent = value?.intent ?? {};
    const advisories = Array.isArray(value?.advisories) ? value.advisories : [];
    const isRecovered = value?.recovered === true || intent?.recovered === true;
    const attempt = value?.attempt ?? intent?.attempt ?? 1;
    const prevError = value?.previous_error ?? intent?.previous_error;
    const title = `Intent (${intent.status ?? '?'})${isRecovered ? ' · recovered ✓' : ''}`;
    const advisoryLines = advisories.length
      ? advisories.map(a => `  - peer \`${a.peer ?? '?'}\` shares: ${clip([...(a.paths ?? []), ...(a.resources ?? [])].join(', '), 140)} (advisory only, never blocking)`)
      : ['  - none'];
    const body = bullets([
      `**summary**: ${clip(intent.summary ?? '', 220)}`,
      isRecovered ? `**recovery**: recovered from validation failure on attempt ${attempt}${prevError ? ` (repaired from error: \`${clip(prevError, 160)}\`)` : ''}` : null,
      `**paths** (${(intent.paths ?? []).length}): ${clip((intent.paths ?? []).join(', '), 200)}`,
      (intent.resources ?? []).length ? `**resources**: ${intent.resources.join(', ')}` : null,
      (intent.related_refs ?? []).length ? `**related refs**: ${refList(intent.related_refs)}` : null,
      `**overlapping-peer advisories**:`,
      ...advisoryLines,
      value.ref ? `**ref**: \`${value.ref}\`` : null,
      '_advisories are declarations, not locks: they never block execution._',
    ]);
    return { title, content: document(title, body) };
  },

  trace_find(value) {
    const indexResults = Array.isArray(value?.results) ? value.results : [];
    const deepHits = Array.isArray(value?.hits) ? value.hits : [];
    const title = value?.mode === 'deep'
      ? `Deep scan: ${deepHits.length} hit${deepHits.length === 1 ? '' : 's'}`
      : `Found ${indexResults.length} record${indexResults.length === 1 ? '' : 's'}`;
    const rows = value?.mode === 'deep' ? deepHits.map(deepHitLine) : indexResults.map(findEntryLine);
    const body = [
      `- **query**: ${clip(compactJson(value?.query ?? {}), 200)}`,
      `- **matches**: ${value?.mode === 'deep' ? deepHits.length : indexResults.length}`,
      value?.next_cursor ? '- **next cursor**: available; pass the complete `next_cursor` from the structured result below as `cursor`' : '- **next cursor**: (exhausted)',
      `- **indexed events**: ${value?.coverage?.indexed_events ?? '?'}`,
      '',
      rows.length ? rows.join('\n') : '_no matches_',
    ].join('\n');
    return { title, content: document(title, body) };
  },

  trace_expand(value) {
    const title = `${value?.ref ?? 'expand'} · ${value?.returned_bytes ?? 0}/${value?.total_bytes ?? 0} bytes` +
      (value?.hash_verified ? ' · SHA-256 verified' : '');
    const body = [
      `- **ref**: \`${value?.ref ?? '?'}\``,
      `- **window**: bytes ${value?.offset ?? 0}–${(value?.offset ?? 0) + (value?.returned_bytes ?? 0)} of ${value?.total_bytes ?? 0} (hash_verified: ${value?.hash_verified ? 'true' : 'false'})`,
      `- **next offset**: ${value?.next_offset === null || value?.next_offset === undefined ? '(complete)' : `\`${value.next_offset}\``}`,
      (value?.related_refs ?? []).length ? `- **related refs**: ${refList(value.related_refs)}` : null,
      (Array.isArray(value?.text_blobs) && value.text_blobs.length) ? `- **text blobs**: ${value.text_blobs.map(b => `\`${b.ref ?? '?'}\` (${b.bytes ?? '?'} B)`).join(', ')}` : null,
      '',
      value?.metadata_only ? '_metadata_only: no payload bytes requested._' : '_Exact page bytes are in the structured result below._',
    ].filter(Boolean).join('\n');
    return { title, content: document(title, body) };
  },

  trace_send(value) {
    const receipts = Array.isArray(value?.receipts) ? value.receipts : [];
    const receiptLines = receipts.map(r =>
      `  - \`${r.recipient ?? '?'}\` → **${r.state ?? '?'}**${r.delivery_ref ? ` · \`${r.delivery_ref}\`` : ''}`);
    const title = `Message ${value?.message_id ?? '?'} persisted · ${receipts.filter(r => r.state === 'host_admitted').length}/${receipts.length} admitted`;
    const body = bullets([
      `**message id**: \`${value?.message_id ?? '?'}\` · **thread**: \`${value?.thread_id ?? '?'}\``,
      `**persisted at**: \`${value?.message_ref ?? '?'}\``,
      `**deliveries**:`,
      ...receiptLines,
      '_' + (value?.evidence_levels ?? 'persisted always; delivery receipts never mean agreement') + '_',
      '_A receipt is delivery evidence only; it never means agreement or completion._',
    ]);
    return { title, content: document(title, body) };
  },

  trace_inbox(value) {
    const inbox = Array.isArray(value?.inbox) ? value.inbox : [];
    const outbox = Array.isArray(value?.outbox) ? value.outbox : [];
    const title = `Inbox: ${inbox.length} inbound · ${outbox.length} outbound`;
    const inboxLines = inbox.map(m =>
      `- \`${m.message_id}\` · **${m.type ?? '?'}** from \`${m.from ?? '?'}\` · thread \`${m.thread_id ?? '?'}\` · ${clip(m.note ?? '', 90)}\n` +
      `  levels: persisted=${m.levels?.persisted ? 'yes' : 'no'} host_admitted=${m.levels?.host_admitted ? 'yes' : 'no'} context_observed=${m.levels?.context_observed ? 'yes' : 'no'} recipient_ack=${m.levels?.recipient_ack ? 'yes' : 'no'} reply_recorded=${m.levels?.reply_recorded ? 'yes' : 'no'}`);
    const outboxLines = outbox.map(m => {
      const deliveries = (m.deliveries ?? []).map(d => `${d.recipient}=${d.state}`).join(', ');
      return `- \`${m.message_id}\` · **${m.type ?? '?'}** → ${clip(deliveries, 120)}${m.reply_recorded ? ' · replied' : ''}`;
    });
    const body = [
      `- **viewer**: \`${value?.viewer ?? '?'}\``,
      value?.next_cursor ? '- **older messages**: pass the complete `next_cursor` below as `cursor`, keeping the same thread filter' : '- **older messages**: (end of ingested history)',
      '',
      inbox.length ? '**Inbound**\n' + inboxLines.join('\n') : '**Inbound**: (none)',
      '',
      outbox.length ? '**Outbound**\n' + outboxLines.join('\n') : '**Outbound**: (none)',
      '',
      '_A receipt is delivery evidence only; it never means agreement or completion._',
    ].join('\n');
    return { title, content: document(title, body) };
  },

  trace_ack(value) {
    const title = `Receipt recorded for ${value?.message_id ?? '?'}`;
    const body = bullets([
      `**message**: \`${value?.message_id ?? '?'}\``,
      value?.ack_ref ? `**ack ref**: \`${value.ack_ref}\`` : null,
      `_${value?.note ?? 'receipt only; never means agreement or completion'}_`,
    ]);
    return { title, content: document(title, body) };
  },

  trace_step_result(value) {
    const title = `Step \`${value?.step ?? '?'}\` → ${value?.status ?? '?'}` + (value?.late ? ' · (late claim, flagged)' : '');
    const body = bullets([
      `**plan**: \`${value?.plan_id ?? '?'}\` · **step**: \`${value?.step ?? '?'}\` · **status**: **${value?.status ?? '?'}**`,
      value?.result_ref ? `**result ref**: \`${value.result_ref}\`` : null,
      value?.late ? '_this claim arrived after the attempt was terminal and is stored as flagged evidence without rewriting the recorded outcome_' : null,
    ]);
    return { title, content: document(title, body) };
  },

  trace_plan(value) {
    const steps = Array.isArray(value?.steps) ? value.steps : [];
    const good = steps.filter(s => s.execution === 'settled' && s.outcome === 'worker_reported_success');
    const title = `Plan ${value?.plan_id ?? '?'} · ${good.length}/${steps.length} steps worker-reported success`;
    const stepLines = steps.map(s =>
      `- **${s.id ?? '?'}**: ${s.execution ?? '?'}${s.outcome ? ` · outcome=${s.outcome}` : ''}${s.sessionID ? ` · worker \`${s.sessionID}\`` : ''}${s.evidence_ref ? ` · evidence \`${s.evidence_ref}\`` : ''}`);
    const body = bullets([
      `**plan ref**: \`${value?.plan_ref ?? '?'}\` · **version**: ${value?.version ?? '?'}`,
      '',
      ...stepLines,
      '',
      `_${value?.semantics ?? 'settled means the child turn finished; task success requires the worker structured result'}_`,
    ]);
    return { title, content: document(title, body) };
  },

  trace_status(value) {
    const intent = value?.current_intent;
    const notes = Array.isArray(value?.notes) ? value.notes : [];
    const unresolved = Array.isArray(value?.unresolved) ? value.unresolved : [];
    const peers = Array.isArray(value?.peers) ? value.peers : [];
    const title = `Memory for ${value?.sessionID ?? 'current session'}: ${notes.length} notes · ${unresolved.length} unresolved · ${peers.length} peers shown` +
      (intent ? ` · intent ${intent.status ?? '?'}` : ' · no active intent');
    const peerLines = peers.map(p =>
      `- \`${p.sessionID ?? '?'}\` (${p.agent ?? '?'} · ${p.status ?? '?'})${p.intent ? ` · intent **${p.intent.status}**: ${clip(p.intent.summary ?? '', 90)}` : ''}`);
    const body = [
      `- **workspace**: \`${value?.workspace ?? '?'}\``,
      `- **scope**: caller session \`${value?.sessionID ?? '?'}\`; this is a bounded observer view, not another worker's context`,
      intent ? `- **current intent** (${intent.status}): ${clip(intent.summary ?? '', 180)}` : '- **current intent**: (none declared)',
      `- **notes** (${notes.length}): ${notes.length ? notes.map(n => `\`${n.ref ?? '?'}\`(${n.kind ?? '?'})`).join(', ') : '(none)'}`,
      `- **unresolved** (${unresolved.length}): ${unresolved.length ? unresolved.map(n => `\`${n.ref ?? '?'}\``).join(', ') : '(none)'}`,
      `- **advisories**: ${(value?.advisories ?? []).length} · **intent conflicts**: ${(value?.intent_conflicts ?? []).length}`,
      `- **peer page**: ${peers.length} of ${value?.peer_total ?? '?'} (next offset: ${value?.peer_next_offset ?? 'end'})`,
      `- **degradation**: ${value?.errors ?? 0} errors · observer dropped ${value?.observer?.dropped_observations ?? 0}`,
      '',
      peers.length ? '**Peers**\n' + peerLines.join('\n') : '**Peers**: (none)',
      '',
      `_Snapshot may be stale; intents are declarations. Advisories never block execution._`,
    ].join('\n');
    return { title, content: document(title, body) };
  },
};

/**
 * Present one trace tool result.
 * @param {string} name tool name
 * @param {object} value the full result value ({ok:true,...} or {ok:false,...})
 * @returns {{title: string, content: string}} never throws
 */
export function present(name, value) {
  try {
    if (value && typeof value === 'object' && value.ok === false) {
      const title = `${name} failed`;
      return {
        title,
        content: document(title, bullets([
          `**error**: ${clip(value.error ?? 'unknown', 200)}`,
          '_trace is unavailable for this call; native execution is unaffected._',
        ])) + '\n\n' + fence(safeJson(value)),
      };
    }
    const format = formatters[name];
    if (format) {
      const shown = format(value);
      const fullJson = safeJson(value);
      return { title: shown.title, summary: shown.content,
        content: `${shown.content}\n\n${fence(fullJson)}` };
    }
  } catch {
    // fall through to the generic fence below
  }
  const title = name;
  return { title, content: document(title, fence(safeJson(value))) };
}

/**
 * Size-bounded raw payload for result metadata.
 * Oversized metadata previously broke host delivery; raw is omitted past the
 * bound with an explicit marker (never silently truncated bytes).
 */
export function boundedRaw(value, serialized, limit = RAW_LIMIT) {
  try {
    // Deliver the same JSON-safe value as the fenced body. Internal search filters
    // contain undefined; passing those through metadata breaks native persistence.
    if (Buffer.byteLength(serialized, 'utf8') <= limit) return JSON.parse(serialized);
    return {
      raw_omitted: true,
      serialized_bytes: Buffer.byteLength(serialized, 'utf8'),
      note: 'full structured result is fenced in content',
    };
  } catch {
    return { raw_omitted: true, note: 'result was not JSON-serializable' };
  }
}
