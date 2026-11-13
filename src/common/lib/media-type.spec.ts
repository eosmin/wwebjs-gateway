import { outgoingMediaType, parseMediaType } from './media-type.js'

describe('parseMediaType', () => {
  it('gives the bare type in lower case and the parameters it understood', () => {
    expect(parseMediaType('Audio/OGG; Codecs=opus')).toEqual({
      bare: 'audio/ogg',
      parameters: [['codecs', 'opus']]
    })
    expect(parseMediaType('image/png')).toEqual({ bare: 'image/png', parameters: [] })
    expect(parseMediaType('  image/png  ')).toEqual({ bare: 'image/png', parameters: [] })
    expect(parseMediaType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"')).toEqual({
      bare: 'video/mp4',
      parameters: [['codecs', 'avc1.42e01e, mp4a.40.2']]
    })
  })

  it('keeps a ; or a / inside a quoted value as part of that value', () => {
    expect(parseMediaType('image/jpeg;x="a;text/html"')).toEqual({
      bare: 'image/jpeg',
      parameters: [['x', 'a;text/html']]
    })
  })

  it.each([
    '',
    '   ',
    'image',
    '/',
    'image/',
    '/png',
    'image/png;',
    'image/png;;',
    'image/png; x',
    'image/png; =y',
    'image/png; x="y',
    'image/png\r\nx-evil: 1',
    'image/png\u0000',
    'image/png\t',
    'image/png x=y',
    'image/png, text/html',
    `image/png; x=${'a'.repeat(300)}`
  ])('refuses %j', value => {
    expect(parseMediaType(value)).toBeUndefined()
  })

  it('refuses what is not a string', () => {
    expect(parseMediaType(undefined as unknown as string)).toBeUndefined()
    expect(parseMediaType(7 as unknown as string)).toBeUndefined()
  })
})

describe('outgoingMediaType', () => {
  it('keeps only the bare type, in lower case', () => {
    expect(outgoingMediaType('Image/PNG')).toBe('image/png')
    expect(outgoingMediaType('image/jpeg; charset=utf-8')).toBe('image/jpeg')
    expect(outgoingMediaType('application/pdf; x=1')).toBe('application/pdf')
    expect(outgoingMediaType('audio/ogg')).toBe('audio/ogg')
  })

  it('gives a voice note its codec from a constant, whatever the sender wrote around it', () => {
    expect(outgoingMediaType('audio/ogg; codecs=opus')).toBe('audio/ogg; codecs=opus')
    expect(outgoingMediaType('AUDIO/OGG;codecs="Opus"')).toBe('audio/ogg; codecs=opus')
    expect(outgoingMediaType('audio/ogg; x=1; codecs=opus')).toBe('audio/ogg; codecs=opus')
  })

  it('does not take the codec from a quoted value or from another parameter', () => {
    expect(outgoingMediaType('audio/ogg; x="a; codecs=opus"')).toBe('audio/ogg')
    expect(outgoingMediaType('audio/ogg; codecs=vorbis')).toBe('audio/ogg')
    expect(outgoingMediaType('audio/ogg; codecs=opus-evil')).toBe('audio/ogg')
    expect(outgoingMediaType('audio/mpeg; codecs=opus')).toBe('audio/mpeg')
  })

  it('refuses what is not a well formed type', () => {
    for (const value of ['', 'nonsense', 'audio/ogg;;', 'audio/ogg\r\nSet-Cookie: a=b', 'a/b;']) {
      expect(outgoingMediaType(value)).toBeUndefined()
    }
  })
})
