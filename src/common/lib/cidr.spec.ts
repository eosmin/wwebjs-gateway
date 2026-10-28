import { buildCidrList, ipInList, isValidCidr, parseNetwork } from './cidr.js'

describe('parseNetwork', () => {
  it.each([
    ['10.0.0.1', { network: '10.0.0.1', family: 'ipv4' }],
    ['10.0.0.0/8', { network: '10.0.0.0', family: 'ipv4', prefix: 8 }],
    ['2001:db8::/32', { network: '2001:db8::', family: 'ipv6', prefix: 32 }]
  ])('parses %s', (entry, expected) => {
    expect(parseNetwork(entry)).toEqual(expected)
  })

  it.each([
    'example.com',
    '10.0.0.0/33',
    '10.0.0.0/8/8',
    '10.0.0.0/x',
    '::1/129',
    '',
    '10.0.0.1/',
    '/8',
    '10.0.0.0/-1',
    ' 10.0.0.1',
    '10.0.0.0/ 8'
  ])('rejects %j', entry => {
    expect(parseNetwork(entry)).toBeNull()
  })
})

describe('ipInList edges', () => {
  it('matches the first and last address of a range and nothing beside it', () => {
    const list = buildCidrList(['10.0.0.0/8'])

    expect(ipInList(list, '10.0.0.0')).toBe(true)
    expect(ipInList(list, '10.255.255.255')).toBe(true)
    expect(ipInList(list, '9.255.255.255')).toBe(false)
    expect(ipInList(list, '11.0.0.0')).toBe(false)
  })

  it('handles /0 and host prefixes', () => {
    expect(ipInList(buildCidrList(['0.0.0.0/0']), '203.0.113.1')).toBe(true)
    expect(ipInList(buildCidrList(['203.0.113.1/32']), '203.0.113.2')).toBe(false)
    expect(ipInList(buildCidrList(['2001:db8::1/128']), '2001:db8::1')).toBe(true)
  })

  it('keeps the families apart', () => {
    expect(ipInList(buildCidrList(['2001:db8::/32']), '10.0.0.1')).toBe(false)
    expect(ipInList(buildCidrList(['10.0.0.0/8']), '2001:db8::1')).toBe(false)
    expect(ipInList(buildCidrList(['10.0.0.0/8']), '::ffff:11.0.0.1')).toBe(false)
  })
})

describe('isValidCidr', () => {
  it('rejects a zone id', () => {
    expect(isValidCidr('fe80::1%eth0')).toBe(false)
  })
})

describe('ipInList', () => {
  const list = buildCidrList(['10.0.0.0/8', '203.0.113.7', '2001:db8::/32', 'not-a-cidr'])

  it.each(['10.1.2.3', '203.0.113.7', '2001:db8::1', '::ffff:10.1.2.3'])('matches %s', ip => {
    expect(ipInList(list, ip)).toBe(true)
  })

  it.each(['11.0.0.1', '203.0.113.8', '2001:db9::1', 'garbage', ''])('does not match %j', ip => {
    expect(ipInList(list, ip)).toBe(false)
  })

  it('matches nothing when every entry is invalid', () => {
    expect(ipInList(buildCidrList(['nope', '10.0.0.0/99']), '10.0.0.1')).toBe(false)
  })
})
