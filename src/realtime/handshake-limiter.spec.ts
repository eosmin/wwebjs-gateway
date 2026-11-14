import { CommandLimiter, HandshakeLimiter } from './handshake-limiter.js'

describe('HandshakeLimiter', () => {
  it('blocks an address once it failed as often as the limit allows, until the window ends', () => {
    const limiter = new HandshakeLimiter(3)

    for (let failure = 0; failure < 3; failure += 1) {
      expect(limiter.isBlocked('10.0.0.1', 1000)).toBe(false)
      limiter.recordFailure('10.0.0.1', 1000)
    }

    expect(limiter.isBlocked('10.0.0.1', 30_000)).toBe(true)
    expect(limiter.isBlocked('10.0.0.2', 30_000)).toBe(false)
    expect(limiter.isBlocked('10.0.0.1', 61_000)).toBe(false)
  })

  it('starts a new window after the old one ended', () => {
    const limiter = new HandshakeLimiter(2)
    limiter.recordFailure('a', 0)
    limiter.recordFailure('a', 1)

    limiter.recordFailure('a', 70_000)

    expect(limiter.isBlocked('a', 70_001)).toBe(false)
  })

  it('does not grow past its bound when many addresses fail', () => {
    const limiter = new HandshakeLimiter(1)

    for (let address = 0; address < 10_050; address += 1) limiter.recordFailure(`ip-${address}`, 5)

    // The oldest were forgotten, the newest are still counted
    expect(limiter.isBlocked('ip-10049', 6)).toBe(true)
    expect(limiter.isBlocked('ip-0', 6)).toBe(false)
  })
})

describe('CommandLimiter', () => {
  it('lets a key use its allowance in a window, counts every command, and starts again after it', () => {
    const limiter = new CommandLimiter(2)

    expect(limiter.tryAcquire('key', 0)).toBe(true)
    expect(limiter.tryAcquire('key', 1)).toBe(true)
    expect(limiter.tryAcquire('key', 2)).toBe(false)
    expect(limiter.tryAcquire('other', 2)).toBe(true)
    expect(limiter.tryAcquire('key', 61_000)).toBe(true)
  })
})
