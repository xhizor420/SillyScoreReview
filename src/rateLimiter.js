/**
 * Evenly-paced rate limiter.
 *
 * Concurrency alone does not keep you inside a provider's published limits: 8
 * requests in flight against a 2-second model is ~240 requests/minute, which
 * blows through a 60/minute cap even though only 8 are ever open at once. This
 * paces requests so the documented ceiling is respected proactively, instead of
 * discovering it by collecting 429s.
 *
 * Requests are spaced by a fixed minimum interval (60s / requestsPerMinute)
 * rather than allowed to burst. Burst-capable schemes — a token bucket, or a
 * sliding window — permit a full burst at the end of one window and another at
 * the start of the next, so an observer measuring any rolling N-second span can
 * legitimately see twice the intended ceiling. Even pacing has no such boundary
 * case: the rate is bounded in *every* window, not just aligned ones. The cost
 * is that short jobs lose burst speed, which is irrelevant for the batch
 * scoring this tool exists to do, and the safety is the point when the
 * consequence of overshooting is a suspended API key.
 */
export class RateLimiter {
  /**
   * @param {object} opts
   * @param {number} opts.requestsPerMinute sustained ceiling (0/null disables limiting)
   */
  constructor({ requestsPerMinute } = {}) {
    this.enabled = Boolean(requestsPerMinute && requestsPerMinute > 0);
    this.requestsPerMinute = this.enabled ? requestsPerMinute : null;
    this.minIntervalMs = this.enabled ? 60_000 / requestsPerMinute : 0;
    this.nextSlotMs = 0;
    this.chain = Promise.resolve(); // serializes waiters so they proceed in order
    this.throttledCount = 0;
    this.totalWaitedMs = 0;
  }

  /** Resolves once it is this caller's turn, in arrival order. */
  async acquire() {
    if (!this.enabled) return;
    const turn = this.chain.then(() => this._reserve());
    this.chain = turn.catch(() => {}); // keep the chain alive if a caller rejects
    return turn;
  }

  async _reserve() {
    const now = Date.now();
    // Reserve the next slot up front so queued callers claim distinct slots
    // rather than all waking against the same timestamp.
    const slot = Math.max(now, this.nextSlotMs);
    this.nextSlotMs = slot + this.minIntervalMs;

    const waitMs = slot - now;
    if (waitMs > 0) {
      this.throttledCount++;
      this.totalWaitedMs += waitMs;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  stats() {
    return {
      enabled: this.enabled,
      requestsPerMinute: this.requestsPerMinute,
      minIntervalMs: this.minIntervalMs,
      throttledCount: this.throttledCount,
      totalWaitedMs: this.totalWaitedMs,
    };
  }
}
