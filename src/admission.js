// Stable-occurrence admission, not content deduplication. A durable intent
// fixes the sequence and immutable event identity before asynchronous delivery.
// Payload/output CAS precedes that intent. Events are the commit point; indexes
// are disposable. Restart replays admitted, uncommitted envelopes unchanged.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomic, hash, stable } from './util.js';
import { buildCanonicalEnvelope, assertCanonicalEnvelope } from './canonical-envelope.js';

export function newOccurrence() { return `trace:${randomUUID()}`; }
function validateOccurrence(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:._/-]{1,240}$/.test(value))
    throw new Error('Invalid Trace occurrence identity');
  return value;
}
async function readJSON(filename) {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function removeDurable(filename) {
  await fs.unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const directory = await fs.open(path.dirname(filename), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export class AdmissionJournal {
  constructor(store, options = {}) {
    this.store = store;
    this.root = path.join(store.root, 'admission');
    this.fault = options.admissionFault ?? (async () => {});
    this.recovery = { recovered: 0, incomplete: [], authority: 'immutable event and source CAS; admission intent fixes occurrence identity' };
  }
  file(occurrence) { return path.join(this.root, 'accepted', `${hash(validateOccurrence(occurrence))}.json`); }
  pending(session) { return path.join(this.root, 'pending', `${hash(session)}.json`); }
  sequence(session, seq) { return path.join(this.root, 'sequence', hash(session), `${seq}.json`); }
  async linkSequence(record) {
    const target = this.sequence(record.session, record.envelope.session_seq);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try { await fs.link(this.file(record.occurrence), target); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (stable(await readJSON(target)) !== stable(record)) throw new Error('Trace admission sequence locator conflict');
      return;
    }
    const directory = await fs.open(path.dirname(target), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async hasSequence(session, seq) {
    const record = await readJSON(this.sequence(session, seq));
    if (!record) return false;
    this.validate(record);
    if (record.session !== session || record.envelope.session_seq !== seq) throw new Error('Trace sequence locator mismatch');
    return true;
  }
  async init() {
    for (const name of ['accepted', 'pending']) await fs.mkdir(path.join(this.root, name), { recursive: true, mode: 0o700 });
    for (const name of await fs.readdir(path.join(this.root, 'pending'))) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const record = await readJSON(path.join(this.root, 'pending', name));
      if (!record) continue;
      if (name !== `${hash(record.session)}.json`) throw new Error('Trace pending intent filename mismatch');
      await this.store.sequences.withLock(record.session, () => this.reconcilePending(record.session));
    }
  }
  validate(record) {
    if (record?.schema !== 1 || record.workspace !== this.store.workspaceID ||
        typeof record.session !== 'string' || !record.session ||
        !/^[a-f0-9]{64}$/.test(record.fingerprint ?? '')) throw new Error('Invalid Trace admission intent');
    validateOccurrence(record.occurrence);
    const env = record.envelope;
    assertCanonicalEnvelope(env);
    if (env.workspace_id !== record.workspace || env.session_id !== record.session ||
        env.body.occurrence_id !== record.occurrence || env.ref !== env.event_ref ||
        env.event_ref !== `evt_${hash(stable(env.body))}` || env.body.session_seq !== env.session_seq)
      throw new Error('Trace admission identity mismatch');
    return record;
  }
  async reconcilePending(session) {
    const record = await readJSON(this.pending(session));
    if (!record) return;
    this.validate(record);
    if (record.session !== session) throw new Error('Trace admission session mismatch');
    const state = await this.store.sequences.readState(session);
    const env = record.envelope;
    const prior = env.previous_event_ref ?? null;
    // An old writer that does not understand admission must never run beside
    // this writer. An unexpected chain is surfaced, never renumbered/repaired.
    if (state.seq !== env.session_seq - 1 && state.seq !== env.session_seq)
      throw new Error('Trace admission sequence conflict');
    if ((state.seq === env.session_seq - 1 && state.last_ref !== prior) ||
        (state.seq === env.session_seq && state.last_ref !== env.event_ref))
      throw new Error('Trace admission predecessor conflict');
    await atomic(this.file(record.occurrence), stable(record), true);
    await this.fault('after-admission', record);
    await this.linkSequence(record);
    await atomic(this.store.sequences.statePath(session), stable({ seq: env.session_seq, last_ref: env.event_ref }));
    await this.fault('after-sequence', record);
    await removeDurable(this.pending(session));
  }
  async admit(job, occurrence = newOccurrence()) {
    validateOccurrence(occurrence);
    const session = job.host?.sessionID ?? '_workspace';
    // Blob writes before admission may leave harmless orphan CAS files. They
    // do not allocate a sequence or claim that an observation was accepted.
    const payload = await this.store.blob(job.data);
    for (const blob of job.blobs ?? []) {
      const content = Buffer.isBuffer(blob.content) ? blob.content : Buffer.from(blob.content ?? '', 'utf8');
      if (hash(content) !== blob.sha256 || blob.ref !== `blob_${blob.sha256}`)
        throw new Error('Trace output source hash mismatch');
      await atomic(path.join(this.store.root, 'blobs', blob.sha256.slice(0, 2), blob.sha256), content, true);
    }
    const fingerprint = hash(stable({ type: job.type, host: job.host, payload, extra: job.extra ?? {} }));
    return this.store.sequences.withLock(session, async () => {
      await this.reconcilePending(session);
      const known = await readJSON(this.file(occurrence));
      if (known) {
        this.validate(known);
        const envelope = await this.materialize(known);
        const gapIdentity = value => stable({ session: value.session, reason: value.reason,
          ranges: value.ranges, marker_key: value.marker_key, status: value.status });
        const sameGap = job.gapDedupe === true && job.type === 'trace.capture_gap' &&
          known.envelope.event_type === job.type && job.data.status === 'detected' &&
          gapIdentity(JSON.parse(envelope.encoded)) === gapIdentity(job.data);
        // tool.after causality is derived from the current index, not raw
        // observation content. A late retry must retain the first admitted
        // cause even after another before event with the same call key.
        const retryExtra = { ...job.extra };
        if (job.type === 'tool.after') {
          delete retryExtra.caused_by;
          if (known.envelope.caused_by) retryExtra.caused_by = known.envelope.caused_by;
        }
        const sameObservation = known.fingerprint === hash(stable({ type: job.type, host: job.host, payload, extra: retryExtra }));
        if ((!sameObservation && !sameGap) || known.session !== session)
          throw new Error('Trace occurrence reused for a different observation');
        return { envelope, replayed: true };
      }
      const previous = await this.store.sequences.readState(session);
      const built = buildCanonicalEnvelope({ workspace_id: this.store.workspaceID, session_id: session,
        event_type: job.type, host: job.host ?? {}, data: job.data,
        extra: { ...job.extra, occurrence_id: occurrence }, seq: previous.seq + 1,
        previous_event_ref: previous.last_ref });
      const { encoded, ...metadata } = built;
      const record = { schema: 1, workspace: this.store.workspaceID, session, occurrence, fingerprint,
        envelope: { ...metadata, ref: built.event_ref, at: built.created_at, session } };
      this.validate(record);
      await this.fault('before-intent', record);
      // This fsynced intent is the admission point. On crash it is completed
      // under the same session lock before any subsequent allocation.
      await atomic(this.pending(session), stable(record));
      await this.fault('after-intent', record);
      await this.reconcilePending(session);
      return { envelope: { ...record.envelope, encoded }, replayed: false };
    });
  }
  async materialize(record) {
    this.validate(record);
    const env = record.envelope;
    const encoded = (await this.store.readBlob(env.payload.ref)).toString('utf8');
    if (hash(encoded) !== env.payload.sha256 || Buffer.byteLength(encoded) !== env.payload.bytes)
      throw new Error('Trace admission payload mismatch');
    for (const output of env.outputs ?? []) await this.store.readBlob(output.ref);
    return { ...env, encoded };
  }
  async recover() {
    const records = [];
    for (const filename of await fs.readdir(path.join(this.root, 'accepted'))) {
      if (!/^[a-f0-9]{64}\.json$/.test(filename)) continue;
      const record = await readJSON(path.join(this.root, 'accepted', filename));
      this.validate(record);
      if (filename !== `${hash(record.occurrence)}.json`) throw new Error('Trace admission filename mismatch');
      await this.linkSequence(record);
      records.push(record);
    }
    records.sort((a, b) => a.session.localeCompare(b.session) || a.envelope.session_seq - b.envelope.session_seq);
    for (const record of records) {
      const ref = record.envelope.event_ref;
      try {
        const existing = await this.store.readEvent(ref).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        const env = await this.materialize(record);
        if (existing) continue;
        await this.store.persistEnvelope(env);
        this.recovery.recovered++;
      } catch (error) {
        this.recovery.incomplete.push({ occurrence: record.occurrence, ref, session: record.session,
          seq: record.envelope.session_seq, reason: error.code ?? 'source-or-event-invalid' });
        this.store.warning('admission_recovery', error);
      }
    }
    return this.recovery;
  }
}
