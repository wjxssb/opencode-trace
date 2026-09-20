// Phase E: token counting for runtime-context budgeting.
//
// LOCAL ONLY: the optional tokenizer endpoint is the resident vLLM server
// (`/tokenize`); there is no remote/cloud path. With no endpoint (or after
// repeated failures) a conservative deterministic estimator is used and the
// mode is reported honestly. Estimator: CJK ~1 token/char, other text
// ~1 token per 3.2 chars plus small overhead — deliberately conservative
// (overestimates) so byte-budget equivalence is preserved as a floor.
const FALLBACK_FAILURE_LIMIT = 3;

export class TokenCounter {
  constructor(options = {}) {
    this.endpoint = options.tokenizerEndpoint ?? null;
    this.model = options.tokenizerModel ?? null;
    this.cache = new Map();
    this.failures = 0;
    this.mode = this.endpoint ? 'local_tokenizer' : 'estimator';
  }

  available() { return true; } // estimator always available; endpoint is an upgrade

  /** Deterministic conservative estimate (pure function of text). */
  estimate(text) {
    let wide = 0, narrow = 0;
    for (const ch of String(text ?? '')) (ch.codePointAt(0) > 0x2e7f ? wide++ : narrow++);
    return Math.ceil(wide * 1.1 + narrow / 3.2) + 4;
  }

  /**
   * Count tokens: exact via the local tokenizer when configured and healthy,
   * otherwise the deterministic estimator. Never throws; failures decrement
   * trust in the endpoint and flip to fallback mode (recorded in `mode`).
   */
  async count(text) {
    if (!text) return 0;
    const cached = this.cache.get(text);
    if (cached != null) return cached;
    let tokens = null;
    if (this.endpoint && this.failures < FALLBACK_FAILURE_LIMIT) {
      try {
        const res = await fetch(this.endpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, text: String(text).slice(0, 60000) }),
          signal: AbortSignal.timeout(600),
        });
        if (res.ok) {
          const data = await res.json();
          tokens = Array.isArray(data.tokens) ? data.tokens.length : (Number.isFinite(data.count) ? data.count : null);
        }
      } catch { /* local endpoint unavailable — fall through to estimator */ }
      if (tokens == null) this.failures++;
    }
    if (tokens == null) {
      this.mode = this.endpoint ? 'estimator_fallback' : 'estimator';
      tokens = this.estimate(text);
    } else {
      this.mode = 'local_tokenizer';
    }
    if (this.cache.size >= 512) this.cache.clear();
    this.cache.set(text, tokens);
    return tokens;
  }
}

// Evidence-based default: measured V2-A runtime-context frames render at
// ~1.5-3.5K tokens; 3200 keeps the full CRITICAL/HIGH payload while leaving
// headroom below the host's practical context budget. Configurable via
// plugin options `runtimeContextTokenBudget`.
export const DEFAULT_TOKEN_BUDGET = 3200;
