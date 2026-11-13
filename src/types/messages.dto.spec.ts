import { z } from 'zod'

import { EditMessageBody, MediaSource, ReplyMessageBody, SendMessageBody } from './messages.dto.js'

const text = { to: '5215500000001@c.us', type: 'text', body: 'hola' }

// wwebjs spreads `extra` into the message after everything the gateway validated (the chat, the
// text, the media, the quote, the mentions), so the bodies have no such field at all
describe('the extra option', () => {
  it('is not part of a send, a reply or an edit', () => {
    expect(() => SendMessageBody.parse({ ...text, extra: { backgroundColor: '#fff' } })).toThrow()
    expect(() => ReplyMessageBody.parse({ type: 'text', body: 'hola', extra: { a: 1 } })).toThrow()
    expect(() => EditMessageBody.parse({ body: 'nuevo', extra: { a: 1 } })).toThrow()
  })

  it('is refused on every type of content, not only on text', () => {
    const bodies = [
      { type: 'media', source: { base64: 'QUJD', mimetype: 'image/png' } },
      { type: 'location', latitude: 1, longitude: 2 },
      { type: 'contact', contactId: '5215500000002@c.us' },
      { type: 'contacts', contactIds: ['5215500000002@c.us'] },
      { type: 'poll', name: 'q', options: ['a', 'b'] },
      { type: 'event', name: 'e', startTime: '2030-01-01T00:00:00.000Z' },
      { type: 'groupInvite', inviteCode: 'AbCdEfGhIjKl' }
    ]

    for (const body of bodies) {
      expect(() => SendMessageBody.parse({ to: text.to, ...body })).not.toThrow()
      expect(() => SendMessageBody.parse({ to: text.to, ...body, extra: { a: 1 } })).toThrow()
    }
  })

  it.each([
    'from',
    'id',
    'caption',
    'mentionedJidList',
    'quotedMsg',
    'quotedStanzaID',
    'mimetype',
    'data',
    'filename',
    'isViewOnce',
    'lat',
    'lng',
    'vcardList',
    'pollName',
    'pollOptions',
    'eventName',
    'canonicalUrl',
    'matchedText',
    'isForwarded',
    'ephemeralDuration',
    'messageSecret'
  ])('does not let `%s` in through the body either', key => {
    expect(() => SendMessageBody.parse({ ...text, [key]: 'x' })).toThrow()
  })
})

// WhatsApp Web no longer has the module that builds a call link, so an event with a call never
// leaves: the body says so instead of letting the send fail on the way to WhatsApp
describe('the event call type', () => {
  const event = { to: text.to, type: 'event', name: 'e', startTime: '2030-01-01T00:00:00.000Z' }

  it.each(['voice', 'video'])('refuses `%s` and says why', callType => {
    const result = SendMessageBody.safeParse({ ...event, callType })

    expect(result.success).toBe(false)
    expect(result.error?.issues[0]).toMatchObject({ path: ['callType'] })
    expect(result.error?.issues[0]?.message).toMatch(/call links are not supported/i)
  })

  it('refuses `none` too: the option does not exist in the API', () => {
    expect(SendMessageBody.safeParse({ ...event, callType: 'none' }).success).toBe(false)
  })

  it('accepts an event without it', () => {
    expect(() => SendMessageBody.parse(event)).not.toThrow()
  })
})

// H-LIVE-09: a voice note is `audio/ogg; codecs=opus`, a type with parameters
describe('the type of an inline media source', () => {
  const media = (mimetype: unknown): unknown =>
    SendMessageBody.safeParse({
      to: text.to,
      type: 'media',
      source: { base64: 'QUJD', mimetype }
    })
  const typeOf = (mimetype: string): string => {
    const parsed = SendMessageBody.parse({
      to: text.to,
      type: 'media',
      source: { base64: 'QUJD', mimetype }
    }) as { source: { mimetype: string } }
    return parsed.source.mimetype
  }

  it('accepts a type with parameters and keeps only a safe form of it', () => {
    expect(typeOf('audio/ogg; codecs=opus')).toBe('audio/ogg; codecs=opus')
    expect(typeOf('Image/PNG')).toBe('image/png')
    expect(typeOf('image/jpeg; charset=utf-8')).toBe('image/jpeg')
    expect(typeOf('application/pdf;x="a;b"')).toBe('application/pdf')
  })

  it.each([
    '',
    'nonsense',
    'image/',
    'image png',
    'image/png\r\nSet-Cookie: a=b',
    'image/png\n',
    'image/png;',
    'audio/ogg;;',
    'image/png; x',
    'image/png; x="y',
    `image/${'a'.repeat(130)}`
  ])('still refuses %j', mimetype => {
    expect((media(mimetype) as { success: boolean }).success).toBe(false)
  })

  it('refuses a type that is not a string', () => {
    expect((media(7) as { success: boolean }).success).toBe(false)
  })

  it('keeps the schema of the field a string with its length, for the OpenAPI document', () => {
    const schema = z.toJSONSchema(MediaSource, { unrepresentable: 'any' }) as {
      anyOf: { properties: Record<string, unknown> }[]
    }

    expect(schema.anyOf[0]?.properties['mimetype']).toEqual({ type: 'string', maxLength: 127 })
  })

  it('accepts 127 characters and refuses 128', () => {
    const type = (length: number): string => `image/${'a'.repeat(length - 'image/'.length)}`

    expect((media(type(127)) as { success: boolean }).success).toBe(true)
    expect((media(type(128)) as { success: boolean }).success).toBe(false)
  })

  it('does not give the codec of a voice note to another type', () => {
    expect(typeOf('audio/mpeg; codecs=opus')).toBe('audio/mpeg')
    expect(typeOf('audio/ogg; codecs=vorbis')).toBe('audio/ogg')
  })

  it('answers a refusal with the path and the message of the field', () => {
    const result = SendMessageBody.safeParse({
      to: text.to,
      type: 'media',
      source: { base64: 'QUJD', mimetype: 'image/png\r\nx: y' }
    })

    expect(result.success).toBe(false)
    expect(result.error?.issues[0]).toMatchObject({
      message: 'Not a media type such as image/png'
    })
    expect(result.error?.issues[0]?.path.join('.')).toContain('mimetype')
  })
})
