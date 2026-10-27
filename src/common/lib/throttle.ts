export interface IntervalThrottleOptions {
  minIntervalMs: number
  // Random milliseconds added to each interval so sends do not land on a fixed rhythm
  jitterMs?: number
  now?: () => number
  random?: () => number
}

const SWEEP_THRESHOLD = 1024

// Spaces actions per key (a session, a chat) at least `minIntervalMs` apart: `reserve` books the next
// slot and returns how long to wait for it.
export class IntervalThrottle {
  private readonly nextFreeAt = new Map<string, number>()
  private lastSweepAt = Number.NEGATIVE_INFINITY
  private readonly now: () => number
  private readonly random: () => number

  constructor(private readonly options: IntervalThrottleOptions) {
    if (
      !(options.minIntervalMs >= 0) ||
      !(options.jitterMs === undefined || options.jitterMs >= 0)
    ) {
      throw new RangeError('A throttle needs a non-negative interval and jitter')
    }
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
  }

  reserve(key: string): number {
    const at = this.now()
    if (
      this.nextFreeAt.size >= SWEEP_THRESHOLD &&
      at - this.lastSweepAt >= this.options.minIntervalMs
    ) {
      this.sweep(at)
    }
    const slot = Math.max(at, this.nextFreeAt.get(key) ?? at)
    const jitter = Math.floor(this.random() * ((this.options.jitterMs ?? 0) + 1))
    this.nextFreeAt.set(key, slot + this.options.minIntervalMs + jitter)
    return slot - at
  }

  forget(key: string): void {
    this.nextFreeAt.delete(key)
  }

  private sweep(at: number): void {
    this.lastSweepAt = at
    for (const [key, freeAt] of this.nextFreeAt) {
      if (freeAt <= at) this.nextFreeAt.delete(key)
    }
  }
}
