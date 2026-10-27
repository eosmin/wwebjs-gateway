import {
  API_KEY_PREFIX,
  generateApiKey,
  generateToken,
  safeEqual,
  sha256Hex,
  signWebhook
} from './crypto.js'

describe('sha256Hex', () => {
  it('hashes to the known digest', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  })
})

describe('generateToken', () => {
  it('returns 43 url-safe characters that differ every time', () => {
    const token = generateToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(generateToken()).not.toBe(token)
  })
})

describe('generateApiKey', () => {
  it('returns a wgk_ key with its sha256 and a display prefix', () => {
    const key = generateApiKey()
    expect(key.raw).toMatch(/^wgk_[A-Za-z0-9_-]{43}$/)
    expect(key.hash).toBe(sha256Hex(key.raw))
    expect(key.prefix).toBe(key.raw.slice(0, 8))
    expect(key.prefix.startsWith(API_KEY_PREFIX)).toBe(true)
  })
})

describe('safeEqual', () => {
  it('compares strings of any length', () => {
    expect(safeEqual('secret', 'secret')).toBe(true)
    expect(safeEqual('secret', 'secreT')).toBe(false)
    expect(safeEqual('short', 'a much longer string')).toBe(false)
  })
})

describe('signWebhook', () => {
  it('refuses an empty secret', () => {
    expect(() => signWebhook('', 1, 'x')).toThrow(RangeError)
  })

  it('signs timestamp and body with HMAC-SHA256', () => {
    // openssl: printf '1700000000.{"a":1}' | openssl dgst -sha256 -hmac key
    expect(signWebhook('key', 1700000000, '{"a":1}')).toMatch(/^sha256=[0-9a-f]{64}$/)
    expect(signWebhook('key', 1700000000, '{"a":1}')).toBe(
      signWebhook('key', 1700000000, '{"a":1}')
    )
    expect(signWebhook('key', 1700000001, '{"a":1}')).not.toBe(
      signWebhook('key', 1700000000, '{"a":1}')
    )
    expect(signWebhook('other', 1700000000, '{"a":1}')).not.toBe(
      signWebhook('key', 1700000000, '{"a":1}')
    )
  })
})
