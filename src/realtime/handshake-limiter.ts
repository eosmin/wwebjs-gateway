// Socket.IO takes over the HTTP upgrade before Fastify sees it, so the rate limit of the REST routes
// does not cover a handshake. A key that does not exist costs a database lookup: this counts the
// handshakes that FAILED per address, in a fixed window, so a caller that tries keys is refused
// before the lookup. A handshake that succeeds is not counted, so a client that reconnects often is
// not held back by it.
const WINDOW_MS = 60_000
// The map holds an entry per address that failed lately; past this size the expired ones are dropped
const PRUNE_AT = 10_000

interface Window {
  startedAt: number
  count: number
}

export class HandshakeLimiter {
  private readonly windows = new Map<string, Window>()

  constructor(private readonly maxFailuresPerWindow: number) {}

  // True when the address already failed as many times as the window allows
  isBlocked(address: string, now: number = Date.now()): boolean {
    const window = this.windows.get(address)
    if (window === undefined) return false
    if (now - window.startedAt >= WINDOW_MS) {
      this.windows.delete(address)
      return false
    }
    return window.count >= this.maxFailuresPerWindow
  }

  recordFailure(address: string, now: number = Date.now()): void {
    const window = this.windows.get(address)
    if (window === undefined || now - window.startedAt >= WINDOW_MS) {
      if (this.windows.size >= PRUNE_AT) this.prune(now)
      this.windows.set(address, { startedAt: now, count: 1 })
      return
    }
    window.count += 1
  }

  private prune(now: number): void {
    for (const [address, window] of this.windows) {
      if (now - window.startedAt >= WINDOW_MS) this.windows.delete(address)
    }
    // Every address failed within the window: forget the oldest rather than grow without bound
    if (this.windows.size >= PRUNE_AT) {
      const oldest = this.windows.keys().next().value
      if (oldest !== undefined) this.windows.delete(oldest)
    }
  }
}

// Commands per key: a fixed window of RATE_LIMIT_MAX a minute, like the allowance of a REST key. Every
// command counts, whatever it answers, so many sockets of one key cannot go round the limit.
export class CommandLimiter {
  private readonly windows = new Map<string, Window>()

  constructor(private readonly maxPerWindow: number) {}

  // False when the key already used its allowance in this window
  tryAcquire(key: string, now: number = Date.now()): boolean {
    const window = this.windows.get(key)
    if (window === undefined || now - window.startedAt >= WINDOW_MS) {
      if (this.windows.size >= PRUNE_AT) this.prune(now)
      this.windows.set(key, { startedAt: now, count: 1 })
      return true
    }
    if (window.count >= this.maxPerWindow) return false
    window.count += 1
    return true
  }

  private prune(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= WINDOW_MS) this.windows.delete(key)
    }
    if (this.windows.size >= PRUNE_AT) {
      const oldest = this.windows.keys().next().value
      if (oldest !== undefined) this.windows.delete(oldest)
    }
  }
}
