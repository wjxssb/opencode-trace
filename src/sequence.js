// Durable, race-safe per-session event sequence allocator (Phase B).
//
// Each session gets one state file `<dir>/<hash>.state` of the shape
//   { seq: <last allocated>, last_ref: <evt_|null> }
// guarded by an O_EXCL lock file `<dir>/<hash>.lock`. Allocation is atomic
// across processes on the same workspace: the caller supplies a `build`
// callback that derives the event ref from (seq, previous_ref) while the
// lock is held, and the state file is advanced in the same critical section.
//
// Documented failure semantics (honest, covered by Phase C gap markers):
// - crash AFTER the state file is written but BEFORE the event is persisted:
//   that sequence number has no event -> a detectable sequence gap and a
//   missing chain node. Never rewritten, never renumbered.
// - crash BEFORE the state file is written: the sequence number is simply
//   reused by the next allocation (no gap).
// - duplicate delivery of the same logical event: the replay guard in
//   Store.record dedupes by the causality-free body hash before allocation,
//   so a replay never consumes a new sequence number in the same process.
//   Cross-process replays are outside this guarantee (single-writer
//   workspace is the norm) and are documented.
// - retry: a failed allocation releases the lock and the next caller
//   proceeds; nothing is consumed.

import path from 'node:path';
import * as fs from 'node:fs/promises';
import { atomic, hash, stable } from './util.js';

const LOCK_STALE_MS = 10_000;
const LOCK_RETRIES = 40;
const LOCK_RETRY_MS = 5;

export class SequenceAllocator {
  constructor(dir) {
    this.dir = dir;
  }

  statePath(sessionID) { return path.join(this.dir, `${hash(sessionID)}.state`); }
  lockPath(sessionID) { return path.join(this.dir, `${hash(sessionID)}.lock`); }

  async withLock(sessionID, fn) {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const lockPath = this.lockPath(sessionID);
    let handle = null;
    for (let i = 0; i < LOCK_RETRIES && !handle; i++) {
      try { handle = await fs.open(lockPath, 'wx', 0o600); }
      catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        try {
          const stat = await fs.stat(lockPath);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            await fs.unlink(lockPath).catch(() => {}); // stale lock from a dead writer
            continue;
          }
        } catch { continue; }
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
