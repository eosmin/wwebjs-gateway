import { ValidationError } from '../errors.js'

import {
  assertPublicHttpUrl,
  isBlockedAddress,
  isValidAllowlistEntry,
  type SsrfPolicy
} from './ssrf.js'

const resolveTo =
  (...addresses: string[]): SsrfPolicy['resolve'] =>
  () =>
    Promise.resolve(addresses)

const policy = (overrides: Partial<SsrfPolicy> = {}): SsrfPolicy => ({
  privateHostAllowlist: [],
  allowPrivate: false,
  resolve: resolveTo('93.184.216.34'),
  ...overrides
})

describe('isBlockedAddress', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '64:ff9b::7f00:1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:7f00:1',
    '::10.0.0.1',
    '2002:a00:1::1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '64:ff9b:1::1',
    'fec0::1',
    '192.88.99.1',
    'not-an-ip'
  ])('blocks %s', address => {
    expect(isBlockedAddress(address)).toBe(true)
  })

  it.each([
    '93.184.216.34',
    '8.8.8.8',
    '172.15.255.255',
    '172.32.0.1',
    '2606:4700::1111',
    '::ffff:8.8.8.8'
  ])('allows %s', address => {
    expect(isBlockedAddress(address)).toBe(false)
  })
})

describe('assertPublicHttpUrl', () => {
  it('returns the parsed URL of a public host', async () => {
    const { url, addresses } = await assertPublicHttpUrl('https://example.com/hook?a=1', policy())
    expect(url.href).toBe('https://example.com/hook?a=1')
    expect(addresses).toEqual(['93.184.216.34'])
  })

  it.each([
    'ftp://example.com/file',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'gopher://example.com',
    'not a url',
    'https://user:pass@example.com/'
  ])('rejects %s', async url => {
    await expect(assertPublicHttpUrl(url, policy())).rejects.toBeInstanceOf(ValidationError)
  })

  it.each([
    'http://127.0.0.1/',
    'http://10.0.0.5/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://0177.0.0.1/'
  ])('rejects the private literal %s without resolving it', async url => {
    const resolve = jest.fn(resolveTo('93.184.216.34'))
    await expect(assertPublicHttpUrl(url, policy({ resolve }))).rejects.toBeInstanceOf(
      ValidationError
    )
    expect(resolve).not.toHaveBeenCalled()
  })

  it('rejects localhost through the resolver', async () => {
    await expect(
      assertPublicHttpUrl('http://localhost:3000/', policy({ resolve: resolveTo('127.0.0.1') }))
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects a name that resolves to a private address', async () => {
    await expect(
      assertPublicHttpUrl('https://rebind.example.com/', policy({ resolve: resolveTo('10.0.0.8') }))
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('rejects a name when any of its addresses is private', async () => {
    await expect(
      assertPublicHttpUrl(
        'https://mixed.example.com/',
        policy({ resolve: resolveTo('93.184.216.34', '169.254.169.254') })
      )
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects a name that does not resolve', async () => {
    await expect(
      assertPublicHttpUrl('https://nowhere.example.com/', policy({ resolve: resolveTo() }))
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('allows a private host named in the allowlist', async () => {
    const allowed = policy({ privateHostAllowlist: ['Bot'], resolve: resolveTo('172.18.0.4') })
    await expect(assertPublicHttpUrl('http://bot:3000/hook', allowed)).resolves.toHaveProperty(
      'addresses'
    )
    await expect(assertPublicHttpUrl('http://other:3000/hook', allowed)).rejects.toBeInstanceOf(
      ValidationError
    )
  })

  it('allows a private address inside an allowlisted CIDR only', async () => {
    const allowed = policy({ privateHostAllowlist: ['172.18.0.0/16'] })
    await expect(
      assertPublicHttpUrl('http://svc.internal/', { ...allowed, resolve: resolveTo('172.18.5.5') })
    ).resolves.toHaveProperty('addresses')
    await expect(
      assertPublicHttpUrl('http://svc.internal/', { ...allowed, resolve: resolveTo('172.19.0.1') })
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(assertPublicHttpUrl('http://172.18.0.9:8080/', allowed)).resolves.toHaveProperty(
      'addresses'
    )
  })

  it('does not let an allowlisted host open the metadata address through another name', async () => {
    const allowed = policy({ privateHostAllowlist: ['10.0.0.0/8'] })
    await expect(assertPublicHttpUrl('http://169.254.169.254/', allowed)).rejects.toBeInstanceOf(
      ValidationError
    )
  })

  it('never opens the metadata or link-local range, not even to an allowlisted host', async () => {
    const meta = { resolve: resolveTo('169.254.169.254') }
    await expect(
      assertPublicHttpUrl('http://meta/', policy({ ...meta, privateHostAllowlist: ['meta'] }))
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(
      assertPublicHttpUrl(
        'http://meta/',
        policy({ ...meta, privateHostAllowlist: ['169.254.0.0/16'] })
      )
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(
      assertPublicHttpUrl(
        'http://meta/',
        policy({ privateHostAllowlist: ['meta'], resolve: resolveTo('fe80::1') })
      )
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it.each(['::a9fe:a9fe', '64:ff9b::a9fe:a9fe', '2002:a9fe:a9fe::', '2001::1', '64:ff9b:1::1'])(
    'never opens the IPv6 forms that embed an IPv4 address, such as %s',
    async address => {
      const open = policy({ privateHostAllowlist: ['meta', '::/0'], resolve: resolveTo(address) })
      await expect(assertPublicHttpUrl('http://meta/', open)).rejects.toBeInstanceOf(
        ValidationError
      )
    }
  )

  it('fails closed with a ValidationError on an invalid allowlist entry', async () => {
    for (const entry of ['10.0.0.0/99', '10.0.0.0/abc', '10.0.0.0/-1', 'a/b', 'bad host'])
      await expect(
        assertPublicHttpUrl('https://example.com/', policy({ privateHostAllowlist: [entry] }))
      ).rejects.toBeInstanceOf(ValidationError)
  })

  it('ignores a trailing dot and letter case when matching the allowlist', async () => {
    const allowed = policy({ privateHostAllowlist: [' Bot '], resolve: resolveTo('172.18.0.4') })
    await expect(assertPublicHttpUrl('http://BOT.:3000/', allowed)).resolves.toBeDefined()
  })

  it('rejects when the resolver fails or hangs', async () => {
    const failing = policy({ resolve: () => Promise.reject(new Error('ENOTFOUND')) })
    await expect(assertPublicHttpUrl('https://nowhere.test/', failing)).rejects.toBeInstanceOf(
      ValidationError
    )
    jest.useFakeTimers()
    try {
      const hanging = policy({ resolve: () => new Promise<never>(() => undefined) })
      const result = expect(
        assertPublicHttpUrl('https://slow.test/', hanging)
      ).rejects.toBeInstanceOf(ValidationError)
      await jest.advanceTimersByTimeAsync(5000)
      await result
    } finally {
      jest.useRealTimers()
    }
  })

  it('rejects an empty URL', async () => {
    await expect(assertPublicHttpUrl('', policy())).rejects.toBeInstanceOf(ValidationError)
  })

  it('skips the address check when private targets are allowed, keeping the scheme check', async () => {
    const open = policy({ allowPrivate: true })
    await expect(assertPublicHttpUrl('http://127.0.0.1:3000/', open)).resolves.toHaveProperty(
      'addresses'
    )
    await expect(assertPublicHttpUrl('file:///etc/passwd', open)).rejects.toBeInstanceOf(
      ValidationError
    )
  })

  it('resolves with the system resolver by default', async () => {
    await expect(
      assertPublicHttpUrl('http://localhost/', { privateHostAllowlist: [], allowPrivate: false })
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('isValidAllowlistEntry', () => {
  it.each(['bot', 'api.internal', '10.0.0.0/8', '172.18.0.4', 'fd00::/8', '::1'])(
    'accepts %s',
    e => {
      expect(isValidAllowlistEntry(e)).toBe(true)
    }
  )
  it.each([
    '10.0.0.0/33',
    'fd00::/129',
    '10.0.0.0/x',
    '10.0.0.0/8/8',
    'fe80::1%eth0',
    '',
    'a b',
    '-bad',
    '1.2.3'
  ])('rejects %j', e => {
    expect(isValidAllowlistEntry(e)).toBe(false)
  })
})
