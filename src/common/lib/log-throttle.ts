// Lets one line through per interval for a failure that repeats on its own timer (a client that
// retries every two seconds while its server is down), and counts the lines it held back so the next
// one can say how many there were.
export class LogThrottle {
  private lastAt: number | undefined
  private suppressed = 0

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now
  ) {}

  // `undefined` when the line is held back; otherwise how many were held back since the last one
  next(): { suppressed: number } | undefined {
    const at = this.now()
    if (this.lastAt !== undefined && at - this.lastAt < this.intervalMs) {
      this.suppressed++
      return undefined
    }
    const suppressed = this.suppressed
    this.lastAt = at
    this.suppressed = 0
    return { suppressed }
  }

  // The failure is over: returns how many lines were held back and lets the next failure log at once
  reset(): number {
    const suppressed = this.suppressed
    this.lastAt = undefined
    this.suppressed = 0
    return suppressed
  }
}
