// Durable, race-safe per-session event sequence allocator (Phase B).
//
// Each session gets one state file `<dir>/<hash>.state` of the shape
//   { seq: <last allocated>, last_ref: <evt_|null> }
// guarded by an O_EXCL lock file `<dir>/<hash>.lock`. Allocation is atomic
// across processes on the same workspace: the caller supplies a `build`
// callback that derives the event ref from (seq, previous_ref) while the
// lock is held, and the state file is advanced in the same critical section.
//
// Store.record and capture use AdmissionJournal under this shared lock:
// an fsynced intent fixes occurrence/sequence/ref before advancing state,
// so a crash after admission replays the same immutable envelope. Legacy
// allocate callers lack that intent and can leave honest detectable gaps.
// Unknown lock ownership is not evidence of death and is never age-stolen.

import path from 'node:path';
import * as fs from 'node:fs/promises';
import { atomic, hash, stable } from './util.js';

const LOCK_RETRIES = 40;
const LOCK_RETRY_MS = 5;
const localLocks = new Map();

export class SequenceAllocator {
  constructor(dir) {
    this.dir = dir;
  }

  statePath(sessionID) { return path.join(this.dir, `${hash(sessionID)}.state`); }
  lockPath(sessionID) { return path.join(this.dir, `${hash(sessionID)}.lock`); }

  async withLock(sessionID, fn) {
    const key = this.lockPath(sessionID);
    const prior = localLocks.get(key) ?? Promise.resolve();
    let release;
    const done = new Promise(resolve => { release = resolve; });
    localLocks.set(key, done);
    await prior;
    try { return await this.withDiskLock(sessionID, fn); }
    finally { release(); if (localLocks.get(key) === done) localLocks.delete(key); }
  }

  async withDiskLock(sessionID, fn) {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const lockPath = this.lockPath(sessionID);
    let handle = null;
    for (let i = 0; i < LOCK_RETRIES && !handle; i++) {
      try {
        handle = await fs.open(lockPath, 'wx', 0o600);
        const stat = await fs.readFile('/proc/self/stat', 'utf8');
        const boot = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
        await handle.writeFile(stable({ pid: process.pid, start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], boot }));
        await handle.sync();
      }
      catch (error) {
        if (handle) {
          await handle.close().catch(() => {}); handle = null;
          await fs.unlink(lockPath).catch(() => {});
        }
        if (error?.code !== 'EEXIST') throw error;
        let recoveryHandle;
        try {
          // Serialize stale-owner removal. Two reapers must not both inspect
          // the old owner and let the second unlink a newly acquired lock.
          // A crashed reaper leaves an explicit fail-closed recovery guard;
          // it is never guessed dead by age.
          recoveryHandle = await fs.open(`${lockPath}.recovery`, 'wx', 0o600);
          const original = await fs.readFile(lockPath, 'utf8');
          const owner = JSON.parse(original);
          if (!Number.isInteger(owner.pid) || !owner.start || !owner.boot) throw new Error('unknown lock owner');
          let dead = false;
          try {
            const stat = await fs.readFile(`/proc/${owner.pid}/stat`, 'utf8');
            const boot = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
            dead = owner.start !== stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] || owner.boot !== boot;
          } catch (probe) { if (probe.code === 'ENOENT') dead = true; }
          if (dead && await fs.readFile(lockPath, 'utf8') === original) {
            await fs.unlink(lockPath).catch(() => {});
            continue;
          }
        } catch { /* unknown owner is not evidence of death */ }
        finally {
          if (recoveryHandle) {
            await recoveryHandle.close().catch(() => {});
            await fs.unlink(`${lockPath}.recovery`).catch(() => {});
          }
        }
        await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS + Math.floor(Math.random() * 4)));
      }
    }
    if (!handle) throw new Error(`sequence lock timeout for session ${String(sessionID).slice(0, 40)}`);
    try { return await fn(); }
    finally { await handle.close().catch(() => {}); await fs.unlink(lockPath).catch(() => {}); }
  }

  async readState(sessionID) {
    try { return JSON.parse(await fs.readFile(this.statePath(sessionID), 'utf8')); }
    catch (error) {
      if (error?.code === 'ENOENT') return { seq: 0, last_ref: null };
      throw error;
    }
  }

  /**
   * Allocate the next (seq, previous_ref) for a session and derive the event
   * ref inside the critical section. `build(seq, previousRef)` must return
   * `{ ref, body }` (or just a ref string) deterministically from its inputs.
   */
  async allocate(sessionID, build) {
    return this.withLock(sessionID, async () => {
      const state = await this.readState(sessionID);
      const seq = (Number(state?.seq) || 0) + 1;
      const previous = state?.last_ref ?? null;
      const built = await build(seq, previous);
      const ref = typeof built === 'string' ? built : built.ref;
      await atomic(this.statePath(sessionID), stable({ seq, last_ref: ref }));
      return { seq, previous_event_ref: previous, ref, body: typeof built === 'string' ? null : built.body };
    });
  }

  /** Current watermark (for coverage reporting). */
  async watermark(sessionID) {
    const state = await this.readState(sessionID);
    return { seq: Number(state?.seq) || 0, last_ref: state?.last_ref ?? null };
  }
}
