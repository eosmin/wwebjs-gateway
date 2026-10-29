export interface TokenBucketOptions {
  // Tokens available in one window; also the burst size
  capacity: number
  windowMs: number
  now?: () => number
}

export interface TokenBucketState {
  tokens: number
  // When `tokens` was last brought up to date, in epoch milliseconds
  at: number
}

// A bucket that never refuses: consuming past the capacity books a future token, and `delayMs` says how
// long until one is free. Bursts are smoothed into a steady flow instead of failing.
export class TokenBucket {
  private tokens: number
  private lastRefillAt: number
  private readonly now: () => number

  constructor(
    private readonly options: TokenBucketOptions,
    initial?: TokenBucketState
  ) {
    if (!(options.capacity > 0) || !(options.windowMs > 0) || !isFinite(options.windowMs)) {
      throw new RangeError('A token bucket needs a positive capacity and window')
    }
    this.now = options.now ?? Date.now
    const at = this.now()
    // A saved state resumes where it stopped, capped by the capacity of now (a budget that was cut
    // takes effect at once, one that grew fills through the refill). Debt is limited to one burst,
    // and a state that is not a number or a time in the future counts as spent just now.
    const saved = initial && Number.isFinite(initial.tokens) ? initial.tokens : 0
    this.tokens = initial
      ? Math.min(options.capacity, Math.max(-options.capacity, saved))
      : options.capacity
    this.lastRefillAt = initial && Number.isFinite(initial.at) ? Math.min(initial.at, at) : at
  }

  // What to save to resume this bucket later
  snapshot(): TokenBucketState {
    this.refill()
    return { tokens: this.tokens, at: this.lastRefillAt }
  }

  // Tokens free right now, never negative
  available(): number {
    this.refill()
    return Math.max(0, Math.floor(this.tokens))
  }

  // Milliseconds until a token is free (0 when one is)
  delayMs(): number {
    this.refill()
    if (this.tokens >= 1) return 0
    // Multiplied before dividing: the other way round, 1 / (2 / 3_600_000) overshoots by a millisecond
    return Math.ceil(((1 - this.tokens) * this.options.windowMs) / this.options.capacity)
  }

  // Takes a token (booking a future one when none is free) and returns the delay before it may be used
  consume(): number {
    const delay = this.delayMs()
    this.tokens -= 1
    return delay
  }

  private refillPerMs(): number {
    return this.options.capacity / this.options.windowMs
  }

  private refill(): void {
    // A clock that went back adds nothing and does not move the reference back
    const at = Math.max(this.now(), this.lastRefillAt)
    this.tokens = Math.min(
      this.options.capacity,
      this.tokens + (at - this.lastRefillAt) * this.refillPerMs()
    )
    this.lastRefillAt = at
  }
}
