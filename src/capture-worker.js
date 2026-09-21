// Phase G: capture writer (worker thread), V3 S6 port. Owns persistence
// for the non-blocking capture path: idempotent CAS blob+event writes and
// the derived index (single writer — the host suppresses its own index
// writes while this worker is alive). Death of this thread never affects
// the host: unacknowledged envelopes are counted lost by the host via the
// durable loss ledger, and the next generation drains the ledger into
// explicit trace.capture_gap markers.
//
// Handle-unaware by construction (§13): this module imports Store and the
// worker_threads API only. It persists CanonicalCaptureEnvelopeV1 inputs
// whose identity fields are already validated canonical refs; it never
// resolves, matches, or stores model handles or finalization-set tokens.
import { parentPort, workerData } from 'node:worker_threads';
import { Store } from './store.js';
import { assertCanonicalEnvelope } from './canonical-envelope.js';

const post = message => parentPort.postMessage(message);

// No-op watcher: the worker ingests exactly what it persists itself; the
// host process runs the directory watcher for its own view.
const noWatch = () => ({ on() {}, unref() {}, close() {} });

try {
  const store = await new Store(workerData.location, workerData.storeRoot, () => {}, { watch: noWatch }).init();
  post({ type: 'ready', generation: workerData.generation });
  // Restart recovery: a new generation drains the durable loss ledger into
  // trace.capture_gap markers before accepting new work, so loss recorded
  // while a previous writer was dead becomes visible coverage.
  try {
    const markers = await store.drainCaptureLedgers(workerData.ledgerDir, workerData.generation);
    if (markers.length) post({ type: 'ledgers-drained', markers, generation: workerData.generation });
  } catch (error) {
    post({ type: 'ledger-error', error: String(error?.message ?? error) });
  }

  parentPort.on('message', async message => {
    if (message.type === 'ping') { post({ type: 'pong', generation: workerData.generation }); return; }
    if (message.type === 'drain-ledgers') {
      try {
        const markers = await store.drainCaptureLedgers(workerData.ledgerDir, workerData.generation);
        post({ type: 'ledgers-drained', markers, generation: workerData.generation });
      } catch (error) {
        post({ type: 'ledger-error', error: String(error?.message ?? error) });
      }
      return;
    }
    if (message.type !== 'envelopes') return;
    const started = Date.now();
    const persisted = {};
    let lastRef = null;
    for (const env of message.envelopes) {
      // Defense in depth (§12/M3): the coordinator already validated before
      // admission; the worker re-validates before persistence. A poison
      // envelope trips fatal — the coordinator's death path ledgers the
      // in-flight seqs exactly and respawns. Never a silent persist.
      try { assertCanonicalEnvelope(env); }
      catch (error) {
        post({ type: 'fatal', error: `poison envelope rejected: ${error.message}` });
        process.exitCode = 1;
        return;
      }
      const event = await store.persistEnvelope(env);
      persisted[event.host?.sessionID ?? '_'] = Math.max(persisted[event.host?.sessionID ?? '_'] ?? 0, event.session_seq ?? 0);
      lastRef = event.ref;
    }
    post({
      type: 'ack',
      ids: message.envelopes.map(env => env.env_id),
      persisted,
      indexed: message.envelopes.length,
      latencyMs: Date.now() - started,
      lastRef,
      generation: workerData.generation,
    });
  });
} catch (error) {
  post({ type: 'fatal', error: String(error?.stack ?? error) });
  process.exitCode = 1;
}
