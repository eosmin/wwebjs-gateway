import { TokenBucket } from './token-bucket.js'

describe('TokenBucket', () => {
  let clock = 0
  const bucket = (capacity: number, windowMs: number): TokenBucket =>
    new TokenBucket({ capacity, windowMs, now: () => clock })

  beforeEach(() => {
    clock = 0
  })

  it('starts full and hands out the burst with no delay', () => {
    const b = bucket(3, 60_000)
    expect([b.consume(), b.consume(), b.consume()]).toEqual([0, 0, 0])
    expect(b.available()).toBe(0)
  })

  it('delays instead of failing once the burst is spent', () => {
    const b = bucket(2, 60_000)
    b.consume()
    b.consume()
    expect(b.consume()).toBe(30_000)
    expect(b.consume()).toBe(60_000)
  })

  it('refills at capacity per window', () => {
    const b = bucket(2, 60_000)
    b.consume()
    b.consume()
    clock = 30_000
    expect(b.available()).toBe(1)
    expect(b.delayMs()).toBe(0)
  })

  it('never refills beyond the capacity', () => {
    const b = bucket(2, 60_000)
    clock = 10 * 60_000
    expect(b.available()).toBe(2)
  })

  it('reports the wait for the next token without taking it', () => {
    const b = bucket(1, 1000)
    b.consume()
    expect(b.delayMs()).toBe(1000)
    expect(b.delayMs()).toBe(1000)
  })

  it('resumes from a saved state and keeps refilling from where it stopped', () => {
    const b = bucket(2, 60_000)
    b.consume()
    b.consume()
    const saved = b.snapshot()

    clock = 30_000
    const resumed = new TokenBucket({ capacity: 2, windowMs: 60_000, now: () => clock }, saved)

    expect(resumed.available()).toBe(1)
  })

  it('does not hand out the burst again when it resumes a spent bucket', () => {
    const spent = { tokens: 0, at: 0 }
    const resumed = new TokenBucket({ capacity: 5, windowMs: 60_000, now: () => 0 }, spent)

    expect(resumed.available()).toBe(0)
    expect(resumed.delayMs()).toBe(12_000)
  })

  it('cuts saved tokens to a smaller capacity at once', () => {
    const resumed = new TokenBucket(
      { capacity: 4, windowMs: 60_000, now: () => 0 },
      { tokens: 10, at: 0 }
    )

    expect(resumed.available()).toBe(4)
  })

  it('treats a clock that went back as no time passed', () => {
    clock = 10_000
    const resumed = new TokenBucket(
      { capacity: 2, windowMs: 60_000, now: () => clock },
      { tokens: 0, at: 50_000 }
    )

    expect(resumed.available()).toBe(0)
    expect(resumed.snapshot().at).toBe(10_000)
  })

  it('does not drain the tokens when the clock goes back while it runs', () => {
    clock = 10_000
    const b = bucket(2, 60_000)
    b.consume()

    clock = 1_000
    expect(b.available()).toBe(1)
    clock = 10_000
    expect(b.available()).toBe(1)
  })

  it('limits the debt of a saved state to one burst', () => {
    const resumed = new TokenBucket(
      { capacity: 2, windowMs: 60_000, now: () => 0 },
      { tokens: -1_000_000, at: 0 }
    )

    // Two tokens in debt refill in one window, not in a million
    expect(resumed.delayMs()).toBe(90_000)
  })

  it.each([
    ['tokens', { tokens: Number.NaN, at: 0 }],
    ['time', { tokens: 1, at: Number.NaN }]
  ])('counts a saved state with a bad %s as spent', (_name, saved) => {
    const resumed = new TokenBucket({ capacity: 3, windowMs: 60_000, now: () => 5_000 }, saved)

    expect(resumed.available()).toBeLessThanOrEqual(1)
    expect(Number.isFinite(resumed.snapshot().tokens)).toBe(true)
  })

  it.each([
    [0, 1000],
    [-1, 1000],
    [1, 0],
    [1, Infinity],
    [NaN, 1000]
  ])('rejects capacity %p with window %p', (capacity, windowMs) => {
    expect(() => bucket(capacity, windowMs)).toThrow(RangeError)
  })
})
