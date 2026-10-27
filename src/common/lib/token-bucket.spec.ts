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
