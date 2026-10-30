import { EditMessageBody, ReplyMessageBody, SendMessageBody } from './messages.dto.js'

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
