import { inlineMediaType } from './inline-media.js'

describe('inlineMediaType', () => {
  it.each([
    ['image/jpeg', 'image/jpeg'],
    ['Image/JPEG', 'image/jpeg'],
    ['  image/png  ', 'image/png'],
    ['audio/ogg; codecs=opus', 'audio/ogg'],
    ['audio/ogg;codecs=opus', 'audio/ogg'],
    ['AUDIO/OGG; Codecs="opus"', 'audio/ogg'],
    ['image/jpeg; charset=utf-8', 'image/jpeg'],
    ['video/mp4; codecs="avc1.42E01E, mp4a.40.2"', 'video/mp4'],
    ['audio/mpeg', 'audio/mpeg'],
    ['application/pdf', 'application/pdf'],
    ['image/gif', 'image/gif'],
    ['image/webp', 'image/webp']
  ])('serves %j inline as %j, without the parameters of the sender', (mimetype, served) => {
    expect(inlineMediaType(mimetype)).toBe(served)
  })

  it.each([
    'text/html',
    'text/html; x=image/jpeg',
    'text/html; charset=utf-8',
    'image/svg+xml',
    'application/octet-stream',
    'application/xhtml+xml',
    'application/javascript',
    'image/jpeg-evil',
    'image/jpegx',
    'x-image/jpeg',
    'audio/ogg;;',
    'audio/ogg;',
    'audio/ogg; codecs',
    'audio/ogg; =opus',
    'audio/ogg; codecs=opus;;',
    'audio/ogg codecs=opus',
    'audio/ogg, text/html',
    'image/jpeg/extra',
    'image',
    '/',
    '',
    '   ',
    ';',
    'audio/ogg; codecs="opus'
  ])('hands %j over as a download', mimetype => {
    expect(inlineMediaType(mimetype)).toBeUndefined()
  })

  it('refuses a type with a line break or any control character, so no header can be injected', () => {
    for (const mimetype of [
      'audio/ogg\r\nSet-Cookie: a=b',
      'image/jpeg\nx: y',
      'image/jpeg\u0000',
      'audio/ogg; codecs=opu\u0007s',
      'image/jpeg\u007f',
      'audio/ogg; codecs="a\r\nb"'
    ]) {
      expect(inlineMediaType(mimetype)).toBeUndefined()
    }
  })

  it('refuses a type that is not a string or is absurdly long', () => {
    expect(inlineMediaType(undefined as unknown as string)).toBeUndefined()
    expect(inlineMediaType(null as unknown as string)).toBeUndefined()
    expect(inlineMediaType(`audio/ogg; codecs=${'a'.repeat(300)}`)).toBeUndefined()
  })
})
