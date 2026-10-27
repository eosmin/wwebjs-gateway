import { IntervalThrottle } from './throttle.js'

describe('IntervalThrottle', () => {
  let clock = 0
  const throttle = (minIntervalMs: number, jitterMs?: number, random = () => 0): IntervalThrottle =>
    new IntervalThrottle({ minIntervalMs, jitterMs, now: () => clock, random })

  beforeEach(() => {
    clock = 0
  })

  it('lets the first action through and spaces the next ones', () => {
    const t = throttle(1000)
    expect([t.reserve('s'), t.reserve('s'), t.reserve('s')]).toEqual([0, 1000, 2000])
  })

  it('keeps keys independent', () => {
    const t = throttle(1000)
    t.reserve('a')
    expect(t.reserve('b')).toBe(0)
  })

  it('adds jitter up to the maximum to each interval', () => {
    const t = throttle(1000, 400, () => 0.999999)
    t.reserve('s')
    expect(t.reserve('s')).toBe(1400)
  })

  it('lets an action through once the interval has passed', () => {
    const t = throttle(1000)
    t.reserve('s')
    clock = 1000
    expect(t.reserve('s')).toBe(0)
  })

  it('forgets a key on request', () => {
    const t = throttle(1000)
    t.reserve('s')
    t.forget('s')
    expect(t.reserve('s')).toBe(0)
  })

  it('drops expired keys so the map stays bounded', () => {
    const t = throttle(1000)
    for (let i = 0; i < 1024; i++) t.reserve(`chat-${i}`)
    clock = 5000
    t.reserve('fresh')
    expect(t.reserve('chat-0')).toBe(0)
    expect(t.reserve('fresh')).toBe(1000)
  })

  it('rejects a negative interval or jitter', () => {
    expect(() => throttle(-1)).toThrow(RangeError)
    expect(() => throttle(1000, -1)).toThrow(RangeError)
  })

  it('sweeps at most once per interval', () => {
    const t = throttle(1000)
    for (let i = 0; i < 1100; i++) t.reserve(`chat-${i}`)
    clock = 1000
    t.reserve('a')
    // the map still holds the expired keys until the next sweep window, yet answers stay correct
    expect(t.reserve('chat-5')).toBe(0)
  })
})
