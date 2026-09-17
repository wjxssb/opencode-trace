export class TraceValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'TraceValidationError';
    this.code = 'SCHEMA_ERROR';
    this.details = details;
  }
}

/**
 * Normalizes and canonicalizes input for `trace_intent`.
 *
 * Ensures:
 * - status: enum ['active', 'waiting', 'done', 'cancelled']
 * - summary: non-empty string <= 2048 bytes (safe default on done/cancelled if omitted)
 * - paths: string -> [string], array -> array, null/undefined -> [], invalid -> actionable error
 * - resources: string -> [string], array -> array, null/undefined -> []
 * - related_refs: array of valid string refs
 */
export function normalizeTraceIntentInput(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TraceValidationError(`trace_intent input must be an object; received ${raw === null ? 'null' : typeof raw}`);
  }

  // 1. status
  const rawStatus = raw.status;
  if (typeof rawStatus !== 'string' || !['active', 'waiting', 'done', 'cancelled'].includes(rawStatus)) {
    throw new TraceValidationError(
      `Invalid intent status: expected one of "active", "waiting", "done", "cancelled", received ${JSON.stringify(rawStatus)}`
    );
  }
  const status = rawStatus;

  // 2. summary
  let summary = raw.summary;
  if (summary === undefined || summary === null) {
    if (status === 'done' || status === 'cancelled') {
      summary = `Intent ${status}`;
    } else {
      throw new TraceValidationError(`summary is required when setting intent status to "${status}"`);
    }
  } else if (typeof summary !== 'string') {
    throw new TraceValidationError(`summary must be a string; received ${typeof summary}`);
  } else {
    summary = summary.trim();
    if (!summary) {
      if (status === 'done' || status === 'cancelled') {
        summary = `Intent ${status}`;
      } else {
        throw new TraceValidationError(`summary must not be empty`);
      }
    }
  }
  if (Buffer.byteLength(summary, 'utf8') > 2048) {
    throw new TraceValidationError(`summary exceeds maximum size of 2048 bytes`);
  }

  // 3. paths
  let paths = raw.paths;
  let normalizedPaths = [];
  if (paths === undefined || paths === null) {
    normalizedPaths = [];
  } else if (typeof paths === 'string') {
    const trimmed = paths.trim();
    normalizedPaths = trimmed ? [trimmed] : [];
  } else if (Array.isArray(paths)) {
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      if (typeof p !== 'string') {
        throw new TraceValidationError(
          `paths must contain only non-empty path strings; element at index ${i} has type ${typeof p} (${JSON.stringify(p)})`
        );
      }
      const trimmed = p.trim();
      if (!trimmed) {
        throw new TraceValidationError(`paths element at index ${i} cannot be empty`);
      }
      if (Buffer.byteLength(trimmed, 'utf8') > 4096) {
        throw new TraceValidationError(`path at index ${i} exceeds maximum 4096 bytes`);
      }
      normalizedPaths.push(trimmed);
    }
  } else {
    throw new TraceValidationError(
      `paths must be an array of strings, a single path string, or null/omitted; received ${typeof paths} (${JSON.stringify(paths)})`
    );
  }

  if (normalizedPaths.length > 64) {
    throw new TraceValidationError(`paths array cannot exceed 64 items; received ${normalizedPaths.length}`);
  }

  // 4. resources
  let resources = raw.resources;
  let normalizedResources = [];
  if (resources === undefined || resources === null) {
    normalizedResources = [];
  } else if (typeof resources === 'string') {
    const trimmed = resources.trim();
    normalizedResources = trimmed ? [trimmed] : [];
  } else if (Array.isArray(resources)) {
    for (let i = 0; i < resources.length; i++) {
      const r = resources[i];
      if (typeof r !== 'string') {
        throw new TraceValidationError(`resources must contain only strings; element at index ${i} has type ${typeof r}`);
      }
      const trimmed = r.trim();
      if (!trimmed) {
        throw new TraceValidationError(`resources element at index ${i} cannot be empty`);
      }
      if (Buffer.byteLength(trimmed, 'utf8') > 256) {
        throw new TraceValidationError(`resource at index ${i} exceeds 256 bytes`);
      }
      normalizedResources.push(trimmed);
    }
  } else {
    throw new TraceValidationError(`resources must be an array of strings or single string; received ${typeof resources}`);
  }

  if (normalizedResources.length > 32) {
    throw new TraceValidationError(`resources array cannot exceed 32 items; received ${normalizedResources.length}`);
  }

  // 5. related_refs
  let related_refs = raw.related_refs;
  let normalizedRefs = [];
  if (related_refs === undefined || related_refs === null) {
    normalizedRefs = [];
  } else if (typeof related_refs === 'string') {
    const trimmed = related_refs.trim();
    if (trimmed) normalizedRefs = [trimmed];
  } else if (Array.isArray(related_refs)) {
    normalizedRefs = related_refs
      .filter(r => typeof r === 'string' && r.trim())
      .map(r => r.trim())
      .slice(0, 16);
  }

  const attempt = Number.isInteger(raw.attempt) && raw.attempt > 0 ? raw.attempt : 1;
  const recovered = raw.recovered === true;
  const previous_error = typeof raw.previous_error === 'string' ? raw.previous_error : undefined;

  return {
    status,
    summary,
    paths: normalizedPaths,
    resources: normalizedResources,
    related_refs: normalizedRefs,
    attempt,
    recovered,
    ...(previous_error ? { previous_error } : {})
  };
}
