import { resolveMimetype } from './mime.js'

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])

describe('resolveMimetype', () => {
  it('believes a specific Content-Type that agrees with the bytes in kind', () => {
    expect(resolveMimetype('image/jpeg', png)).toBe('image/jpeg')
    expect(
      resolveMimetype('audio/mp4', Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A ')]))
    ).toBe('audio/mp4')
  })

  it('does not believe a type that contradicts what the bytes are', () => {
    expect(resolveMimetype('text/html', png)).toBe('image/png')
    expect(resolveMimetype('application/pdf', png)).toBe('image/png')
  })

  it('ignores a type that is not well formed', () => {
    expect(resolveMimetype('image/png\r\nx-evil: 1', png)).toBe('image/png')
    expect(resolveMimetype('nonsense', Buffer.from('plain'))).toBeUndefined()
  })

  it('knows the other formats by their first bytes', () => {
    expect(resolveMimetype(undefined, Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(resolveMimetype(undefined, Buffer.from('GIF89a'))).toBe('image/gif')
    expect(resolveMimetype(undefined, Buffer.from('%PDF-1.7'))).toBe('application/pdf')
    expect(resolveMimetype(undefined, Buffer.from('OggS'))).toBe('audio/ogg')
    expect(resolveMimetype(undefined, Buffer.from('ID3'))).toBe('audio/mpeg')
  })

  it('does not throw on a buffer shorter than any signature', () => {
    expect(resolveMimetype(undefined, Buffer.alloc(1))).toBeUndefined()
    expect(resolveMimetype(undefined, Buffer.alloc(0))).toBeUndefined()
  })

  it.each([undefined, 'application/octet-stream'])('reads the bytes when the type is %s', type => {
    expect(resolveMimetype(type, png)).toBe('image/png')
  })

  it('knows the WebP container and an MP4 box', () => {
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])
    const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom')])
    expect(resolveMimetype(undefined, webp)).toBe('image/webp')
    expect(resolveMimetype(undefined, mp4)).toBe('video/mp4')
  })

  it('has nothing to say about unknown bytes without a type', () => {
    expect(resolveMimetype(undefined, Buffer.from('plain'))).toBeUndefined()
    expect(resolveMimetype('application/octet-stream', Buffer.from('plain'))).toBe(
      'application/octet-stream'
    )
  })
})
