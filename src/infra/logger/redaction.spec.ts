import { isSensitiveKey, REDACTED, redactSensitive, scrubText } from './redaction.js'

describe('isSensitiveKey', () => {
  it.each([
    'secret',
    'webhookSecret',
    'token',
    'inboundToken',
    'access_token',
    'password',
    'apiKey',
    'api_key',
    'x-api-key',
    'authorization',
    'Cookie',
    'qr',
    'qrCode',
    'qr_string',
    'pairingQr',
    'pairingCode',
    'otp',
    'jwt',
    'signature',
    'x-webhook-signature',
    'privateKey',
    'proxy-authorization',
    'x-auth-token',
    'body',
    'text',
    'caption'
  ])('flags %s', key => {
    expect(isSensitiveKey(key)).toBe(true)
  })

  it.each(['sessionId', 'event', 'status', 'chatId', 'seq', 'sqrt', 'hotpath', 'textLength'])(
    'keeps %s',
    key => {
      expect(isSensitiveKey(key)).toBe(false)
    }
  )
})

describe('scrubText', () => {
  it.each([
    ['/v1/hooks/inbound/ABC123_-x/send?page=1', '/v1/hooks/inbound/[Redacted]/send?page=1'],
    [
      '/v1/hooks/inbound/ABC123?token=qtok&page=2',
      '/v1/hooks/inbound/[Redacted]?token=[Redacted]&page=2'
    ],
    ['Authorization: Bearer abc.def', 'Authorization: [Redacted] [Redacted]'],
    ['key wgk_AbC-123_x used', 'key [Redacted] used'],
    ['qr is 2@AbCdEfGh12345+/=,x', 'qr is [Redacted]'],
    ['password=hunter2 secret: shh', 'password=[Redacted] secret: [Redacted]'],
    ['Authorization: Basic dXNlcjpwYXNz', 'Authorization: [Redacted] [Redacted]'],
    [
      'redis://user:pass@cache:6379 and postgres://u:p@db/app',
      'redis://user:[Redacted]@cache:6379 and postgres://u:[Redacted]@db/app'
    ],
    ['{"token":"abc def","id":1}', '{"token":[Redacted],"id":1}'],
    ["secret: 'two words' next", 'secret: [Redacted] next'],
    ['/hooks%2Finbound%2FABC123/x', '/hooks%2Finbound%2F[Redacted]/x'],
    ['plain message about page=2', 'plain message about page=2']
  ])('%s', (input, expected) => {
    expect(scrubText(input)).toBe(expected)
  })
})

describe('redactSensitive', () => {
  it('replaces sensitive values at any depth, in objects and arrays', () => {
    const input = {
      sessionId: 'main',
      webhook: { url: 'https://example.com', secret: 's3cr3t' },
      events: [{ type: 'qr', qr: '2@abc' }, { token: 't0k3n' }],
      deep: { a: { b: { c: { apiKey: 'wgk_x' } } } }
    }

    expect(redactSensitive(input)).toEqual({
      sessionId: 'main',
      webhook: { url: 'https://example.com', secret: REDACTED },
      events: [{ type: 'qr', qr: REDACTED }, { token: REDACTED }],
      deep: { a: { b: { c: { apiKey: REDACTED } } } }
    })
  })

  it('does not change its input', () => {
    const input = { secret: 'x', nested: { token: 'y' } }

    redactSensitive(input)

    expect(input).toEqual({ secret: 'x', nested: { token: 'y' } })
  })

  it('passes numbers, null and dates through untouched', () => {
    const date = new Date(0)

    expect(redactSensitive(7)).toBe(7)
    expect(redactSensitive(null)).toBeNull()
    expect(redactSensitive(date)).toBe(date)
  })

  it('walks class instances, maps and sets', () => {
    class Delivery {
      readonly secret = 's3cr3t'
      readonly id = 'd1'
    }

    expect(redactSensitive(new Delivery())).toEqual({ secret: REDACTED, id: 'd1' })
    expect(redactSensitive(new Map([['token', 'x']]))).toEqual({ token: REDACTED })
    expect(redactSensitive(new Set([{ secret: 'x' }]))).toEqual([{ secret: REDACTED }])
  })

  it('reduces bytes to their size', () => {
    expect(redactSensitive(Buffer.from('credential bytes'))).toBe('[Buffer 16 bytes]')
    expect(redactSensitive(new Uint8Array(4))).toBe('[Uint8Array 4 bytes]')
  })

  it('scrubs the message, stack and cause of an error', () => {
    const error = new Error('failed token=abc123', { cause: new Error('Bearer xyz') })

    const result = JSON.stringify(redactSensitive(error))

    expect(result).not.toContain('abc123')
    expect(result).not.toContain('xyz')
    expect(result).toContain('failed token=[Redacted]')
  })

  it('keeps a __proto__ key as data instead of replacing the prototype', () => {
    const parsed: unknown = JSON.parse('{"__proto__": {"polluted": "yes"}, "id": 1}')

    const result = redactSensitive(parsed) as Record<string, unknown>

    expect(result['id']).toBe(1)
    expect(result['__proto__']).toEqual({ polluted: 'yes' })
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('censors what lies deeper than the depth limit', () => {
    let deep: Record<string, unknown> = { leaf: 'value' }
    for (let level = 0; level < 12; level++) deep = { next: deep }

    const result = JSON.stringify(redactSensitive(deep))

    expect(result).toContain(REDACTED)
    expect(result).not.toContain('value')
  })
})

describe('scrubText limits', () => {
  it('does not stall on long runs of key-like text', () => {
    const started = Date.now()

    scrubText('token'.repeat(20000))
    scrubText('a-'.repeat(50000) + 'secret')
    scrubText('a'.repeat(15000) + '://')
    scrubText('token'.repeat(3000))

    expect(Date.now() - started).toBeLessThan(150)
  })

  it('truncates what is past the length limit', () => {
    const result = scrubText('x'.repeat(10000))

    expect(result.length).toBeLessThan(8300)
    expect(result.endsWith('[truncated]')).toBe(true)
  })
})

describe('redactSensitive robustness', () => {
  it('marks a property whose getter throws instead of throwing', () => {
    const value = {
      ok: 1,
      get broken(): string {
        throw new Error('boom')
      }
    }

    expect(redactSensitive(value)).toEqual({ ok: 1, broken: '[Unreadable]' })
  })

  it('reads an error whose message getter throws', () => {
    const error = new Error('x')
    Object.defineProperty(error, 'message', {
      get() {
        throw new Error('boom')
      }
    })

    expect(redactSensitive(error)).toMatchObject({ type: 'Error', message: '[Unreadable]' })
  })

  it('reduces every typed array and buffer to a size', () => {
    expect(redactSensitive(new Float32Array(3))).toBe('[Float32Array 12 bytes]')
    expect(redactSensitive(new ArrayBuffer(8))).toBe('[ArrayBuffer 8 bytes]')
    expect(redactSensitive(new DataView(new ArrayBuffer(4)))).toBe('[DataView 4 bytes]')
  })

  it('keeps the first entries of a long array and counts the rest', () => {
    const result = redactSensitive(Array.from({ length: 150 }, (_, i) => i)) as unknown[]

    expect(result).toHaveLength(101)
    expect(result[100]).toBe('[+50 more]')
  })

  it('marks a cycle once instead of copying it to the depth limit', () => {
    const node: Record<string, unknown> = { name: 'loop' }
    node['self'] = node

    expect(redactSensitive(node)).toEqual({ name: 'loop', self: '[Circular]' })
  })

  it('keeps the errors of an AggregateError and scrubs a URL object', () => {
    const aggregate = new AggregateError([new Error('token=abc123')], 'many')

    expect(JSON.stringify(redactSensitive(aggregate))).toContain('token=[Redacted]')
    expect(redactSensitive(new URL('redis://u:pw@cache:6379'))).toBe(
      'redis://u:[Redacted]@cache:6379'
    )
  })
})
