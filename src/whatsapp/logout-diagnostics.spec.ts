import {
  ConsoleTail,
  cleanConsoleLine,
  isLogoutRelevant,
  logoutReasonOf
} from './logout-diagnostics.js'

describe('logoutReasonOf', () => {
  const url = (query: string): string => `https://web.whatsapp.com/?${query}`

  it('reads the short token WhatsApp Web puts in the logout address', () => {
    expect(logoutReasonOf(url('post_logout=1&logout_reason=client_fatal'))).toBe('client_fatal')
    expect(logoutReasonOf(url('logout_reason=SYNC_fail2'))).toBe('SYNC_fail2')
  })

  it('leaves it out when there is none, or it is not a short token', () => {
    expect(logoutReasonOf(url('post_logout=1'))).toBeUndefined()
    expect(logoutReasonOf(url('logout_reason='))).toBeUndefined()
    expect(logoutReasonOf(url(`logout_reason=${'a'.repeat(49)}`))).toBeUndefined()
    expect(logoutReasonOf(url('logout_reason=a-b'))).toBeUndefined()
    expect(logoutReasonOf(url('logout_reason=a%20b'))).toBeUndefined()
    expect(logoutReasonOf(url('logout_reason=%3Cscript%3E'))).toBeUndefined()
    expect(logoutReasonOf(url('logout_reason=15551234567%40c.us'))).toBeUndefined()
  })

  it('leaves out a token that is a number or starts with a digit, which could be an account', () => {
    expect(logoutReasonOf(url('logout_reason=15551234567'))).toBeUndefined()
    expect(logoutReasonOf(url('logout_reason=1abc'))).toBeUndefined()
    expect(logoutReasonOf(url('logout_reason=_client'))).toBeUndefined()
    expect(logoutReasonOf(url('logout_reason=client_fatal_15551234567'))).toBeUndefined()
  })

  it('accepts exactly 48 characters and takes the first of a repeated parameter', () => {
    expect(logoutReasonOf(url(`logout_reason=${'a'.repeat(48)}`))).toHaveLength(48)
    expect(logoutReasonOf(url('logout_reason=first&logout_reason=second'))).toBe('first')
  })

  it('survives an address that cannot be parsed', () => {
    expect(logoutReasonOf('not a url')).toBeUndefined()
    expect(logoutReasonOf('')).toBeUndefined()
  })
})

describe('isLogoutRelevant', () => {
  it('keeps the three kinds of line the page writes about a reload or a logout', () => {
    expect(isLogoutRelevant('[reload] Updater.restart')).toBe(true)
    expect(isLogoutRelevant('x storage initialization error, logging out')).toBe(true)
    expect(isLogoutRelevant('something logging out here')).toBe(true)
  })

  it('drops everything else, so the volume stays small', () => {
    expect(isLogoutRelevant('chat 5551234 opened')).toBe(false)
    expect(isLogoutRelevant('')).toBe(false)
    expect(isLogoutRelevant('reload without the bracket')).toBe(false)
  })
})

describe('cleanConsoleLine', () => {
  it('truncates, drops control characters and masks long digit runs', () => {
    expect(cleanConsoleLine(`[reload] ${'x'.repeat(500)}`)).toHaveLength(160)
    expect(cleanConsoleLine('[reload]\u0000\u001b[31m a\nb')).toBe('[reload] [31m a b')
    expect(cleanConsoleLine('[reload] user 15551234567 left 12345 ago')).toBe(
      '[reload] user # left 12345 ago'
    )
  })

  it('masks a phone number split by separators, spaces or brackets', () => {
    for (const number of ['+1 555 123 4567', '1-555-123-4567', '(555) 123-4567', '5 5 5 1 2 3 4']) {
      expect(cleanConsoleLine(`[reload] user ${number} left`)).not.toMatch(/\d[\d\s().-]*\d{3}/)
    }
  })

  it('masks digits of other scripts', () => {
    expect(
      cleanConsoleLine('[reload] \uff11\uff15\uff15\uff15\uff11\uff12\uff13\uff14\uff15\uff16 x')
    ).toBe('[reload] # x')
    expect(cleanConsoleLine('[reload] \u0661\u0665\u0665\u0665\u0661\u0662\u0663\u0664 x')).toBe(
      '[reload] # x'
    )
  })

  it('masks account ids with short numbers, and any address or token with an @', () => {
    expect(cleanConsoleLine('[reload] 1234@c.us left 99-1@g.us now')).toBe(
      '[reload] <id> left <id> now'
    )
    expect(cleanConsoleLine('[reload] abc@lid x')).toBe('[reload] <id> x')
  })

  it('masks web addresses, with their query and tokens', () => {
    expect(cleanConsoleLine('[reload] go https://web.whatsapp.com/?t=abc123&u=bob now')).toBe(
      '[reload] go <url> now'
    )
    expect(cleanConsoleLine('logging out HTTP://x.example/a')).toBe('logging out <url>')
  })

  it('does not spend time on a huge line', () => {
    const started = Date.now()
    expect(cleanConsoleLine(`[reload] ${'ab '.repeat(500_000)}`)).toHaveLength(160)
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('masks the address of an account, whatever the shape', () => {
    expect(cleanConsoleLine('[reload] 15551234567@c.us and 123456789-1234@g.us')).not.toMatch(
      /\d{6}/
    )
  })
})

describe('ConsoleTail', () => {
  it('gives back the lines of the last window, oldest first, and no older ones', () => {
    let now = 1_000
    const tail = new ConsoleTail(5_000, 20, () => now)
    tail.add('old')
    now = 7_000
    tail.add('a')
    now = 8_000
    tail.add('b')
    now = 9_000

    expect(tail.recent()).toEqual(['a', 'b'])
  })

  it('keeps only the most recent lines up to its size', () => {
    const tail = new ConsoleTail(5_000, 3, () => 1)
    for (const line of ['a', 'b', 'c', 'd', 'e']) tail.add(line)

    expect(tail.recent()).toEqual(['c', 'd', 'e'])
  })

  it('empties when it is read for a logout', () => {
    const tail = new ConsoleTail(5_000, 3, () => 1)
    tail.add('a')
    tail.recent()

    expect(tail.recent()).toEqual([])
  })
})
