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
    // The configured/documented ceiling never moves. `currentRpm` is what we
    // actually pace at, and drops below the ceiling when the provider pushes
    // back — see penalize()/reward().
    this.ceilingRpm = this.requestsPerMinute;
    this.currentRpm = this.requestsPerMinute;
    this.minIntervalMs = this.enabled ? 60_000 / requestsPerMinute : 0;
    this.nextSlotMs = 0;
    this.chain = Promise.resolve(); // serializes waiters so they proceed in order
    this.throttledCount = 0;
    this.totalWaitedMs = 0;
    this.penalties = 0;
    this.lastPenaltyMs = 0;
    this.successesSincePenalty = 0;
  }

  /**
   * The provider answered 429: we are too fast for it right now, whatever its
   * published numbers say (shared IPs, a busy upstream model, a tightened
   * limit). Halve the pace for everyone sharing this limiter, and honour any
   * Retry-After by holding the next slot back that long.
   *
   * Several workers usually hit the same 429 burst at once, so penalties within
   * two seconds of each other count as one — otherwise one burst would slam the
   * rate straight to the floor.
   */
  penalize(retryAfterMs = null) {
    const now = Date.now();
    if (!this.enabled) {
      // No published limit to pace against, but the API has just told us one
      // exists. Assume 60/min as the ceiling; the halving below then starts
      // us at 30/min, and reward() climbs back toward 60 once it is quiet.
      this.enabled = true;
      this.ceilingRpm = 60;
      this.currentRpm = 60;
      this.requestsPerMinute = 60;
    }
    if (retryAfterMs != null && retryAfterMs > 0 && retryAfterMs <= 30_000) {
      this.nextSlotMs = Math.max(this.nextSlotMs, now + retryAfterMs);
    }
    this.successesSincePenalty = 0;
    if (now - this.lastPenaltyMs < 2000) return;
    this.lastPenaltyMs = now;
    this.penalties++;
    const floor = Math.max(2, this.ceilingRpm / 16);
    this.currentRpm = Math.max(floor, this.currentRpm / 2);
    this.minIntervalMs = 60_000 / this.currentRpm;
  }

  /**
   * A request went through. After a quiet spell, creep back toward the ceiling
   * — 10% of it per 10 clean requests — so one bad minute does not leave a
   * whole overnight scan crawling at a fraction of its allowance. Never exceeds
   * the ceiling.
   */
  reward() {
    if (!this.enabled || this.currentRpm >= this.ceilingRpm) return;
    this.successesSincePenalty++;
    if (Date.now() - this.lastPenaltyMs < 20_000) return;
    if (this.successesSincePenalty % 10 !== 0) return;
    this.currentRpm = Math.min(this.ceilingRpm, this.currentRpm + this.ceilingRpm * 0.1);
    this.minIntervalMs = 60_000 / this.currentRpm;
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
      ceilingRpm: this.ceilingRpm,
      currentRpm: this.currentRpm == null ? null : Math.round(this.currentRpm),
      slowedDown: Boolean(this.enabled && this.currentRpm < this.ceilingRpm),
      penalties: this.penalties,
      minIntervalMs: this.minIntervalMs,
      throttledCount: this.throttledCount,
      totalWaitedMs: this.totalWaitedMs,
    };
  }
}
