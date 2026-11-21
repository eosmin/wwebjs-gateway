import { LogThrottle } from './log-throttle.js'

describe('LogThrottle', () => {
  let clock = 0
  const throttle = new LogThrottle(30_000, () => clock)

  beforeEach(() => {
    clock = 1_000
    throttle.reset()
  })

  it('lets the first line through at once', () => {
    expect(throttle.next()).toEqual({ suppressed: 0 })
  })

  it('holds back the repeats inside the interval and counts them', () => {
    throttle.next()
    clock += 2_000
    expect(throttle.next()).toBeUndefined()
    clock += 2_000
    expect(throttle.next()).toBeUndefined()

    clock += 26_000
    expect(throttle.next()).toEqual({ suppressed: 2 })
  })

  it('starts the interval again after a line went through', () => {
    throttle.next()
    clock += 30_000
    throttle.next()
    clock += 29_999

    expect(throttle.next()).toBeUndefined()
  })

  it('reset reports what was held back and lets the next line through', () => {
    throttle.next()
    clock += 1
    throttle.next()

    expect(throttle.reset()).toBe(1)
    expect(throttle.next()).toEqual({ suppressed: 0 })
  })
})
