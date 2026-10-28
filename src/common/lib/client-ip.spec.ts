import { resolveClientIp } from './client-ip.js'

describe('resolveClientIp', () => {
  it('ignores the header when no proxy is trusted', () => {
    expect(resolveClientIp('192.0.2.1', '198.51.100.9', 0)).toBe('192.0.2.1')
  })

  it('takes the address the single trusted proxy saw', () => {
    expect(resolveClientIp('10.0.0.2', '198.51.100.9', 1)).toBe('198.51.100.9')
  })

  it('does not believe an address the caller put first in the header', () => {
    expect(resolveClientIp('10.0.0.2', '1.1.1.1, 198.51.100.9', 1)).toBe('198.51.100.9')
  })

  it('walks back one entry per trusted hop', () => {
    expect(resolveClientIp('10.0.0.3', '198.51.100.9, 10.0.0.2', 2)).toBe('198.51.100.9')
  })

  it('uses the peer when the chain is shorter than the trusted hops', () => {
    // The request did not pass through every proxy, so the header is only what the caller wrote
    expect(resolveClientIp('192.0.2.1', '198.51.100.9', 2)).toBe('192.0.2.1')
  })

  it('does not believe a forged leftmost entry with two trusted hops', () => {
    expect(resolveClientIp('10.0.0.3', '1.1.1.1, 198.51.100.9, 10.0.0.2', 2)).toBe('198.51.100.9')
  })

  it.each(['', '  ', ' , '])('uses the peer for the header %j', header => {
    expect(resolveClientIp('192.0.2.1', header, 1)).toBe('192.0.2.1')
  })

  it('ignores empty entries between commas', () => {
    expect(resolveClientIp('10.0.0.2', '198.51.100.9,,', 1)).toBe('198.51.100.9')
  })

  it('treats negative hops as none', () => {
    expect(resolveClientIp('192.0.2.1', '198.51.100.9', -1)).toBe('192.0.2.1')
  })

  it('uses the peer when the header is missing', () => {
    expect(resolveClientIp('192.0.2.1', undefined, 1)).toBe('192.0.2.1')
  })

  it('is empty when there is no peer at all', () => {
    expect(resolveClientIp(undefined, undefined, 0)).toBe('')
  })
})
