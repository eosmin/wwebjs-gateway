export interface TokenBucketOptions {
  // Tokens available in one window; also the burst size
  capacity: number
  windowMs: number
  now?: () => number
}

// A bucket that never refuses: consuming past the capacity books a future token, and `delayMs` says how
// long until one is free. Bursts are smoothed into a steady flow instead of failing.
export class TokenBucket {
  private tokens: number
  private lastRefillAt: number
  private readonly now: () => number

  constructor(private readonly options: TokenBucketOptions) {
    if (!(options.capacity > 0) || !(options.windowMs > 0) || !isFinite(options.windowMs)) {
      throw new RangeError('A token bucket needs a positive capacity and window')
    }
    this.now = options.now ?? Date.now
    this.tokens = options.capacity
    this.lastRefillAt = this.now()
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
    return Math.ceil((1 - this.tokens) / this.refillPerMs())
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
    const at = this.now()
    this.tokens = Math.min(
      this.options.capacity,
      this.tokens + (at - this.lastRefillAt) * this.refillPerMs()
    )
    this.lastRefillAt = at
  }
}
