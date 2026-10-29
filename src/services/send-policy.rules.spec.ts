import {
  msUntilQuietEnds,
  normalizeContent,
  normalizeKeyword,
  scaleBudget,
  warmupFactor
} from './send-policy.rules.js'

const DAY = 86_400_000

describe('normalizeContent', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeContent('  Hola   AMIGO\n\tqué tal ')).toBe('hola amigo qué tal')
  })

  it('masks digits and links, so a template with a name-free variable still matches', () => {
    expect(normalizeContent('Tu pedido 1234 en https://shop.example/o/99?x=1 está listo')).toBe(
      'tu pedido <n> en <url> está listo'
    )
    expect(normalizeContent('Tu pedido 98 en www.shop.example/o/7 está listo')).toBe(
      'tu pedido <n> en <url> está listo'
    )
  })

  it('keeps different words different', () => {
    expect(normalizeContent('hola')).not.toBe(normalizeContent('adiós'))
  })
})

describe('normalizeKeyword', () => {
  it('ignores case and spacing only', () => {
    expect(normalizeKeyword('  STOP ')).toBe('stop')
    expect(normalizeKeyword('no   más')).toBe('no más')
    expect(normalizeKeyword('stop 2')).toBe('stop 2')
  })
})

describe('warmupFactor', () => {
  const now = Date.parse('2026-10-29T12:00:00.000Z')

  it('starts at the start fraction on the day of linking and for a session never linked', () => {
    expect(warmupFactor(new Date(now), now, 14, 0.1)).toBeCloseTo(0.1)
    expect(warmupFactor(null, now, 14, 0.1)).toBe(0.1)
  })

  it('ramps linearly and reaches 1 after the warm-up days', () => {
    expect(warmupFactor(new Date(now - 7 * DAY), now, 14, 0.1)).toBeCloseTo(0.55)
    expect(warmupFactor(new Date(now - 14 * DAY), now, 14, 0.1)).toBe(1)
    expect(warmupFactor(new Date(now - 90 * DAY), now, 14, 0.1)).toBe(1)
  })

  it('is 1 when the warm-up is off', () => {
    expect(warmupFactor(null, now, 0, 0.1)).toBe(1)
  })

  it('treats a link date in the future as the start', () => {
    expect(warmupFactor(new Date(now + DAY), now, 14, 0.1)).toBeCloseTo(0.1)
  })
})

describe('scaleBudget', () => {
  it('rounds down but never below 1', () => {
    expect(scaleBudget(20, 0.1)).toBe(2)
    expect(scaleBudget(5, 0.1)).toBe(1)
    expect(scaleBudget(300, 0.5)).toBe(150)
  })

  it('does not lose a unit to floating point', () => {
    // 20 * 0.55 is 11.000000000000002 or 10.999999999999998 depending on the order of the product
    expect(scaleBudget(20, 0.55)).toBe(11)
    expect(scaleBudget(300, 0.7)).toBe(210)
  })

  it('keeps a budget of 0 at 0', () => {
    expect(scaleBudget(0, 0.5)).toBe(0)
  })
})

describe('msUntilQuietEnds', () => {
  const mexico = { from: '22:00', to: '07:00', timezone: 'America/Mexico_City' }
  // Mexico City is UTC-6 all year since 2022
  const at = (utc: string): number => Date.parse(utc)

  it('is 0 without quiet hours', () => {
    expect(msUntilQuietEnds(undefined, at('2026-10-29T12:00:00Z'))).toBe(0)
  })

  it('is 0 outside the window', () => {
    // 12:00 in Mexico City
    expect(msUntilQuietEnds(mexico, at('2026-10-29T18:00:00Z'))).toBe(0)
  })

  it('counts to the end of a window that crosses midnight, before and after midnight', () => {
    // 23:00 local -> 8 h left
    expect(msUntilQuietEnds(mexico, at('2026-10-30T05:00:00Z'))).toBe(8 * 3_600_000)
    // 01:30 local -> 5 h 30 min left
    expect(msUntilQuietEnds(mexico, at('2026-10-29T07:30:00Z'))).toBe(5.5 * 3_600_000)
  })

  it('counts to the end of a same-day window and excludes its end instant', () => {
    const lunch = { from: '13:00', to: '15:00', timezone: 'UTC' }
    expect(msUntilQuietEnds(lunch, at('2026-10-29T13:00:00Z'))).toBe(2 * 3_600_000)
    expect(msUntilQuietEnds(lunch, at('2026-10-29T15:00:00Z'))).toBe(0)
  })

  it('reads the window in its own time zone, not the server one', () => {
    const tokyo = { from: '09:00', to: '10:00', timezone: 'Asia/Tokyo' }
    // 00:30 UTC is 09:30 in Tokyo
    expect(msUntilQuietEnds(tokyo, at('2026-10-29T00:30:00Z'))).toBe(30 * 60_000)
  })

  it('has no window when it starts and ends together', () => {
    expect(
      msUntilQuietEnds({ from: '08:00', to: '08:00', timezone: 'UTC' }, at('2026-10-29T08:00:00Z'))
    ).toBe(0)
  })

  it('reads the time just after midnight as midnight, not hour 24', () => {
    // 00:30 in Mexico City is 06:30 UTC; the window ends at 07:00 local
    expect(msUntilQuietEnds(mexico, at('2026-10-29T06:30:00Z'))).toBe(6.5 * 3_600_000)
  })

  describe('daylight saving', () => {
    const newYork = { from: '22:00', to: '07:00', timezone: 'America/New_York' }

    it('lasts an hour longer on the night the clocks go back', () => {
      // 23:00 EDT on Oct 31 (03:00Z); at 07:00 on Nov 1 the zone is EST (12:00Z)
      expect(msUntilQuietEnds(newYork, at('2026-11-01T03:00:00Z'))).toBe(9 * 3_600_000)
    })

    it('lasts an hour shorter on the night the clocks go forward', () => {
      // 22:00 EST on Mar 7 (03:00Z); at 07:00 on Mar 8 the zone is EDT (11:00Z)
      expect(msUntilQuietEnds(newYork, at('2026-03-08T03:00:00Z'))).toBe(8 * 3_600_000)
    })

    it('counts a same-day window on the day of the change from the wall clock', () => {
      // 05:00 EDT on Nov 1 is 09:00Z; the window ends at 07:00 EST (12:00Z) with one hour repeated
      expect(msUntilQuietEnds(newYork, at('2026-11-01T09:00:00Z'))).toBe(3 * 3_600_000)
    })
  })

  describe('a window that ends at a time the clock change repeats or skips', () => {
    const at = (utc: string): number => Date.parse(utc)

    it('ends at the later of the two 01:30 on the night the clocks go back', () => {
      const repeated = { from: '22:00', to: '01:30', timezone: 'America/New_York' }
      // 23:00 EDT on Oct 31 is 03:00Z. 01:30 happens at 05:30Z (EDT) and again at 06:30Z (EST)
      expect(msUntilQuietEnds(repeated, at('2026-11-01T03:00:00Z'))).toBe(3.5 * 3_600_000)
    })

    it('does not end before a time that does not exist on the night the clocks go forward', () => {
      const skipped = { from: '22:00', to: '02:30', timezone: 'America/New_York' }
      // 22:00 EST on Mar 7 is 03:00Z. 02:30 on Mar 8 never happens: 03:00 EDT is 07:00Z
      const wait = msUntilQuietEnds(skipped, at('2026-03-08T03:00:00Z'))

      expect(wait).toBeGreaterThanOrEqual(4 * 3_600_000)
      expect(wait).toBeLessThanOrEqual(4.5 * 3_600_000)
    })
  })
})
