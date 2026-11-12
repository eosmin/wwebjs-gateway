import { Logger } from '@nestjs/common'

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

describe('isBlockedAddress translated forms', () => {
  it('blocks the IPv4-translated (SIIT) range but not an IPv4-mapped public address', () => {
    expect(isBlockedAddress('::ffff:0:a9fe:a9fe')).toBe(true)
    expect(isBlockedAddress('::ffff:0:808:808')).toBe(true)
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false)
  })
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

  it('lets private targets through when they are allowed, keeping the scheme check', async () => {
    const open = policy({ allowPrivate: true, resolve: () => Promise.resolve(['127.0.0.1']) })
    await expect(assertPublicHttpUrl('http://127.0.0.1:3000/', open)).resolves.toMatchObject({
      addresses: ['127.0.0.1']
    })
    await expect(assertPublicHttpUrl('http://localhost:3000/', open)).resolves.toMatchObject({
      addresses: ['127.0.0.1']
    })
    await expect(
      assertPublicHttpUrl('http://[::1]:3000/', policy({ allowPrivate: true }))
    ).resolves.toMatchObject({ addresses: ['::1'] })
    await expect(
      assertPublicHttpUrl('http://10.0.0.5/', policy({ allowPrivate: true }))
    ).resolves.toMatchObject({ addresses: ['10.0.0.5'] })
    await expect(assertPublicHttpUrl('file:///etc/passwd', open)).rejects.toBeInstanceOf(
      ValidationError
    )
  })

  // The security review of step 1.4: turning the guard off must not open the cloud metadata service
  it.each([
    'http://169.254.169.254/latest/meta-data',
    'http://[::ffff:169.254.169.254]/',
    'http://[fe80::1]/',
    'http://[fd00:ec2::254]/',
    'http://[64:ff9b::a9fe:a9fe]/',
    'http://[2002:a9fe:a9fe::1]/',
    // IPv4-translated (SIIT) form of the metadata address
    'http://[::ffff:0:a9fe:a9fe]/',
    // The metadata service of Alibaba Cloud
    'http://100.100.100.200/',
    // The WireServer of Azure, a public address
    'http://168.63.129.16/machine/?comp=goalstate',
    'http://[::ffff:168.63.129.16]/'
  ])(
    'keeps the metadata addresses blocked even when private targets are allowed: %s',
    async url => {
      await expect(assertPublicHttpUrl(url, policy({ allowPrivate: true }))).rejects.toBeInstanceOf(
        ValidationError
      )
    }
  )

  it('blocks a name that resolves to the metadata address when private targets are allowed', async () => {
    const open = policy({ allowPrivate: true, resolve: () => Promise.resolve(['169.254.169.254']) })
    await expect(assertPublicHttpUrl('http://meta.test/', open)).rejects.toBeInstanceOf(
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

describe('the addresses no switch and no allowlist opens', () => {
  // A public address, so it is closed by being listed, not by a private range
  it.each(['http://168.63.129.16/', 'http://[::ffff:a83f:8110]/'])(
    'refuses the WireServer of Azure (%s) with the default policy and with its address allowlisted',
    async url => {
      await expect(assertPublicHttpUrl(url, policy({}))).rejects.toBeInstanceOf(ValidationError)
      await expect(
        assertPublicHttpUrl(url, policy({ privateHostAllowlist: ['168.63.129.16'] }))
      ).rejects.toBeInstanceOf(ValidationError)
    }
  )

  it('still takes the addresses next to it', async () => {
    await expect(assertPublicHttpUrl('http://168.63.129.17/', policy({}))).resolves.toHaveProperty(
      'addresses'
    )
  })

  // The security review of the webhooks: an allowlisted range must not open the other metadata services
  it.each([
    ['100.100.100.200', '100.64.0.0/10'],
    ['::ffff:100.100.100.200', '100.64.0.0/10'],
    ['fd00:ec2::254', 'fc00::/7']
  ])('refuses %s even when the allowlist names %s', async (address, cidr) => {
    const open = policy({ privateHostAllowlist: [cidr, 'meta'], resolve: resolveTo(address) })
    await expect(assertPublicHttpUrl('http://meta/', open)).rejects.toBeInstanceOf(ValidationError)
  })

  it('still opens the rest of an allowlisted range', async () => {
    await expect(
      assertPublicHttpUrl(
        'http://svc/',
        policy({ privateHostAllowlist: ['100.64.0.0/10'], resolve: resolveTo('100.100.100.201') })
      )
    ).resolves.toHaveProperty('addresses')
    await expect(
      assertPublicHttpUrl(
        'http://svc/',
        policy({ privateHostAllowlist: ['fc00::/7'], resolve: resolveTo('fd00:ec2::255') })
      )
    ).resolves.toHaveProperty('addresses')
  })

  // On Linux 0.0.0.0 and :: connect to the machine itself, so the switch for development keeps them shut
  it.each([
    'http://0.0.0.0:3000/',
    'http://0.1.2.3/',
    'http://[::]:3000/',
    'http://[::ffff:0.0.0.0]/',
    'http://[::ffff:0:0]/',
    'http://[::ffff:100.100.100.200]/',
    'http://100.100.100.200/latest/meta-data'
  ])('keeps %s closed when private targets are allowed', async url => {
    await expect(assertPublicHttpUrl(url, policy({ allowPrivate: true }))).rejects.toBeInstanceOf(
      ValidationError
    )
  })

  it('refuses a name that resolves to them when private targets are allowed', async () => {
    for (const address of ['0.0.0.0', '::', '::ffff:0.0.0.0']) {
      await expect(
        assertPublicHttpUrl(
          'http://localhost/',
          policy({ allowPrivate: true, resolve: resolveTo(address) })
        )
      ).rejects.toBeInstanceOf(ValidationError)
    }
  })

  it('still lets loopback through when private targets are allowed', async () => {
    await expect(
      assertPublicHttpUrl('http://127.0.0.1:3000/', policy({ allowPrivate: true }))
    ).resolves.toHaveProperty('addresses')
  })
})

describe('what a refusal says about the address', () => {
  const logged: string[] = []
  beforeEach(() => {
    logged.length = 0
    for (const level of ['log', 'warn', 'debug', 'verbose', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(String(args[0]))
      })
    }
  })
  afterEach(() => jest.restoreAllMocks())

  const refusal = async (url: string, p: SsrfPolicy): Promise<ValidationError> => {
    try {
      await assertPublicHttpUrl(url, p)
    } catch (error: unknown) {
      if (error instanceof ValidationError) return error
    }
    throw new Error('the URL was accepted')
  }

  // A key of a session reads this (a webhook it creates, the error of a delivery): telling "does not
  // resolve" from "resolves to a private address" would let it map the internal DNS
  it('is the same whether the name does not resolve or resolves to something closed', async () => {
    const cases = await Promise.all([
      refusal('https://nowhere.example.com/', policy({ resolve: resolveTo() })),
      refusal(
        'https://down.example.com/',
        policy({ resolve: () => Promise.reject(new Error('x')) })
      ),
      refusal('https://internal.example.com/', policy({ resolve: resolveTo('10.0.0.5') })),
      refusal('https://meta.example.com/', policy({ resolve: resolveTo('169.254.169.254') })),
      refusal('http://10.0.0.5/', policy()),
      refusal('http://169.254.169.254/', policy({ allowPrivate: true }))
    ])

    expect(new Set(cases.map(error => error.message)).size).toBe(1)
    expect(new Set(cases.map(error => JSON.stringify(error.details))).size).toBe(1)
    expect(cases[0]?.message).toBe(
      'The URL is not allowed: the host does not resolve to a public address'
    )
  })

  it('keeps the detailed reason in the log of the server, without the URL', async () => {
    await refusal(
      'https://secret-host.example.com/path-token',
      policy({ resolve: resolveTo('10.0.0.5') })
    )
    await refusal('https://secret-host.example.com/path-token', policy({ resolve: resolveTo() }))

    const log = logged.join('\n')
    expect(log).toMatch(/private or reserved/)
    expect(log).toMatch(/does not resolve/)
    expect(log).not.toContain('secret-host')
    expect(log).not.toContain('path-token')
  })

  it('still says why a URL that is not an address problem is refused', async () => {
    expect((await refusal('ftp://example.com/', policy())).message).toContain('only http and https')
    expect((await refusal('not a url', policy())).message).toContain('not a valid URL')
  })
})

describe('an allowlist entry that is wrong', () => {
  it('does not echo the entry of the operator in the refusal', async () => {
    const error = await assertPublicHttpUrl(
      'https://example.com/',
      policy({ privateHostAllowlist: ['10.0.0.0/99 internal-secret'] })
    ).catch((failure: unknown) => failure)

    expect(error).toBeInstanceOf(ValidationError)
    expect(JSON.stringify(error)).not.toContain('internal-secret')
    expect((error as ValidationError).message).not.toContain('internal-secret')
    expect(JSON.stringify((error as ValidationError).details)).not.toContain('internal-secret')
  })
})
