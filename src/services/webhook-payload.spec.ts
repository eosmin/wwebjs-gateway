import { z } from 'zod'

import { REDACTED } from '../infra/logger/redaction.js'
import { WA_EVENTS, type EventEnvelope } from '../types/events.js'

import type { DeliveryEnvelope } from './delivery-queue.service.js'
import {
  MESSAGE_CARRYING_EVENTS,
  inlineMediaCandidates,
  redactForStorage,
  shapeForWebhook
} from './webhook-payload.js'

const INLINE_MAX = 10

const message = (extra: Record<string, unknown> = {}) => ({
  id: 'm1',
  body: 'hi',
  raw: { internal: true },
  media: { mimetype: 'image/png', downloadUrl: 'https://gw/media', base64: 'AAAAAA' },
  ...extra
})

const envelope = (event: string, data: unknown): EventEnvelope =>
  ({
    id: 'evt_1',
    event,
    sessionId: 'main',
    seq: 7,
    timestamp: '2026-01-01T00:00:00.000Z',
    data
  }) as unknown as EventEnvelope

const delivery = (event: string, data: unknown): DeliveryEnvelope =>
  envelope(event, data) as unknown as DeliveryEnvelope

const options = (over: Partial<Parameters<typeof shapeForWebhook>[1]> = {}) => ({
  includeRaw: true,
  mediaMode: 'inline' as const,
  inlineMediaMaxBytes: INLINE_MAX,
  ...over
})

describe('shapeForWebhook', () => {
  it('keeps raw and media when the webhook wants both', () => {
    const shaped = shapeForWebhook(envelope('message', message()), options())
    expect(shaped.data).toEqual(message())
  })

  it('drops raw when the webhook does not include it', () => {
    const shaped = shapeForWebhook(envelope('message', message()), options({ includeRaw: false }))
    expect(shaped.data).not.toHaveProperty('raw')
    expect(shaped.data).toHaveProperty('body', 'hi')
  })

  it('drops the whole media block in mode none', () => {
    const shaped = shapeForWebhook(envelope('message', message()), options({ mediaMode: 'none' }))
    expect(shaped.data).not.toHaveProperty('media')
  })

  it('keeps the reference but drops base64 in mode reference', () => {
    const shaped = shapeForWebhook(
      envelope('message', message()),
      options({ mediaMode: 'reference' })
    )
    expect(shaped.data).toMatchObject({
      media: { mimetype: 'image/png', downloadUrl: 'https://gw/media' }
    })
    expect((shaped.data as { media: object }).media).not.toHaveProperty('base64')
  })

  it('drops base64 above the inline limit and keeps the reference', () => {
    // 16 base64 characters decode to 12 bytes, above the limit of 10
    const big = message({
      media: { mimetype: 'a/b', downloadUrl: 'u', base64: 'AAAAAAAAAAAAAAAA' }
    })
    const shaped = shapeForWebhook(envelope('message', big), options())
    expect((shaped.data as { media: object }).media).toEqual({ mimetype: 'a/b', downloadUrl: 'u' })
  })

  it('keeps base64 within the inline limit', () => {
    // 8 characters decode to 6 bytes
    const small = message({ media: { mimetype: 'a/b', downloadUrl: 'u', base64: 'AAAAAAAA' } })
    const shaped = shapeForWebhook(envelope('message', small), options())
    expect((shaped.data as { media: { base64: string } }).media.base64).toBe('AAAAAAAA')
  })

  it.each([
    ['message_ack', 'message'],
    ['message_edit', 'message'],
    ['contact_changed', 'message'],
    ['message_sent', 'message'],
    ['message_revoke_everyone', 'message'],
    ['message_revoke_everyone', 'revokedMessage']
  ])('shapes the messages nested in %s.%s', (event, key) => {
    const shaped = shapeForWebhook(
      envelope(event, { [key]: message(), other: 1 }),
      options({ includeRaw: false, mediaMode: 'none' })
    )
    const nested = (shaped.data as Record<string, object>)[key]
    expect(nested).not.toHaveProperty('raw')
    expect(nested).not.toHaveProperty('media')
    expect(shaped.data).toHaveProperty('other', 1)
  })

  it('shapes every message of a batch', () => {
    const shaped = shapeForWebhook(
      envelope('message_batch', { chatId: 'c', messages: [message(), message()], count: 2 }),
      options({ includeRaw: false })
    )
    for (const item of (shaped.data as { messages: object[] }).messages) {
      expect(item).not.toHaveProperty('raw')
    }
  })

  it('leaves an absent or null nested message alone', () => {
    const shaped = shapeForWebhook(
      envelope('message_revoke_everyone', { message: message(), revokedMessage: null }),
      options({ includeRaw: false })
    )
    expect(shaped.data).toMatchObject({ revokedMessage: null })
    const sent = shapeForWebhook(envelope('message_sent', { jobId: 'j' }), options())
    expect(sent.data).toEqual({ jobId: 'j' })
  })

  it('does not touch events that carry no message, even with a raw or media key', () => {
    const data = { raw: 1, media: 2, status: 'ready' }
    const shaped = shapeForWebhook(
      envelope('session_status', data),
      options({ includeRaw: false, mediaMode: 'none' })
    )
    expect(shaped.data).toEqual(data)
  })

  it('does not mutate the envelope the bus shares with other subscribers', () => {
    const original = envelope('message', message())
    const snapshot = structuredClone(original)
    shapeForWebhook(original, options({ includeRaw: false, mediaMode: 'none' }))
    expect(original).toEqual(snapshot)
  })

  it('copies the envelope fields as they are', () => {
    const shaped = shapeForWebhook(envelope('message', message()), options())
    expect(shaped).toMatchObject({
      id: 'evt_1',
      event: 'message',
      sessionId: 'main',
      seq: 7,
      timestamp: '2026-01-01T00:00:00.000Z'
    })
  })
})

describe('redactForStorage', () => {
  it('redacts the QR text', () => {
    const stored = redactForStorage(delivery('qr', { qr: '2@secretsecretsecret' }))
    expect(stored.data).toEqual({ qr: REDACTED })
  })

  it('redacts the pairing code', () => {
    const stored = redactForStorage(delivery('code', { code: 'ABCD-1234' }))
    expect(stored.data).toEqual({ code: REDACTED })
  })

  it('drops inline base64, keeping the rest of the media block', () => {
    const stored = redactForStorage(delivery('message', message()))
    expect((stored.data as { media: object }).media).toEqual({
      mimetype: 'image/png',
      downloadUrl: 'https://gw/media'
    })
    expect(stored.data).toHaveProperty('raw')
  })

  it('drops inline base64 of nested and batched messages', () => {
    const nested = redactForStorage(delivery('message_ack', { message: message(), ack: 3 }))
    expect((nested.data as { message: { media: object } }).message.media).not.toHaveProperty(
      'base64'
    )
    const batch = redactForStorage(delivery('message_batch', { messages: [message()] }))
    expect((batch.data as { messages: { media: object }[] }).messages[0]?.media).not.toHaveProperty(
      'base64'
    )
  })

  it('leaves other events as they are', () => {
    const data = { status: 'ready', previous: 'authenticating' }
    expect(redactForStorage(delivery('session_status', data)).data).toEqual(data)
  })
})

describe('the events that carry messages', () => {
  // The shaping works from a list of events, so an event added to the catalog with a message in it
  // must show up here before it can leak a `raw` or an inline media past a webhook that excluded them
  it('are exactly the events whose payload has a `raw`', () => {
    const withRaw = Object.entries(WA_EVENTS)
      .filter(([, definition]) =>
        JSON.stringify(
          z.toJSONSchema(definition.payload, { unrepresentable: 'any', reused: 'inline' })
        ).includes('"raw"')
      )
      .map(([name]) => name)
      .sort()
    expect([...MESSAGE_CARRYING_EVENTS].sort()).toEqual(withRaw)
  })

  const at = (data: unknown, path: readonly string[]): unknown =>
    path.reduce<unknown>(
      (value, key) =>
        typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined,
      data
    )

  it.each([
    ['unread_count', { id: 'c', lastMessage: message() }, ['lastMessage']],
    ['chat_removed', { id: 'c', lastMessage: message() }, ['lastMessage']],
    [
      'chat_archived',
      { chat: { id: 'c', lastMessage: message() }, currState: true },
      ['chat', 'lastMessage']
    ]
  ])('shapes the last message of a chat in %s', (event, data, path) => {
    const shaped = shapeForWebhook(
      envelope(event, data),
      options({ includeRaw: false, mediaMode: 'none' })
    )
    const last = at(shaped.data, path)
    expect(last).not.toHaveProperty('raw')
    expect(last).not.toHaveProperty('media')
    const stored = at(redactForStorage(delivery(event, data)).data, path)
    expect(stored).not.toHaveProperty('media.base64')
    expect(stored).toHaveProperty('raw')
  })
})

const REFERENCE = { mimetype: 'image/png', size: 4, downloadUrl: 'https://gw/media' }
const withReference = (id: string, media: Record<string, unknown> | null = REFERENCE) => ({
  id,
  hasMedia: media !== null,
  ...(media !== null && { media })
})

describe('inlineMediaCandidates', () => {
  it('names the messages of a message event whose file fits the limit', () => {
    expect(inlineMediaCandidates(envelope('message', withReference('a')), INLINE_MAX)).toEqual([
      'a'
    ])
  })

  it('names the messages of a batch', () => {
    const batch = envelope('message_batch', {
      messages: [
        withReference('a'),
        withReference('b', { ...REFERENCE, size: 99 }),
        withReference('c')
      ]
    })

    expect(inlineMediaCandidates(batch, INLINE_MAX)).toEqual(['a', 'c'])
  })

  it('leaves out a message without media, with a file past the limit or of unknown size', () => {
    const none = withReference('a', null)
    const big = withReference('b', { ...REFERENCE, size: INLINE_MAX + 1 })
    const unknown = withReference('c', { mimetype: 'image/png', downloadUrl: 'u' })

    for (const message of [none, big, unknown]) {
      expect(inlineMediaCandidates(envelope('message', message), INLINE_MAX)).toEqual([])
    }
  })

  it('leaves out media that already carries its bytes', () => {
    const message = withReference('a', { ...REFERENCE, base64: 'AAAA' })

    expect(inlineMediaCandidates(envelope('message', message), INLINE_MAX)).toEqual([])
  })

  // An ack or an edit of a message would download the same file again and again
  it.each(['message_ack', 'message_create', 'message_edit', 'media_uploaded', 'unread_count'])(
    'does not name the messages of %s, which is not a new message',
    name => {
      const data = name === 'message_create' ? withReference('a') : { message: withReference('a') }

      expect(inlineMediaCandidates(envelope(name, data), INLINE_MAX)).toEqual([])
    }
  )
})

describe('shapeForWebhook with downloaded media', () => {
  const event = () => envelope('message', withReference('a'))

  it('adds the bytes to the media of a webhook that takes them inline', () => {
    const shaped = shapeForWebhook(event(), options(), new Map([['a', 'AAAAAA']]))

    expect(shaped.data).toMatchObject({ media: { ...REFERENCE, base64: 'AAAAAA' } })
  })

  it('does not add them for a reference webhook, nor for one that wants no media', () => {
    const bytes = new Map([['a', 'AAAAAA']])

    expect(shapeForWebhook(event(), options({ mediaMode: 'reference' }), bytes).data).toMatchObject(
      { media: REFERENCE }
    )
    expect(shapeForWebhook(event(), options({ mediaMode: 'none' }), bytes).data).not.toHaveProperty(
      'media'
    )
  })

  it('still holds back bytes that do not fit the limit', () => {
    const shaped = shapeForWebhook(event(), options(), new Map([['a', 'A'.repeat(100)]]))

    expect(shaped.data).toMatchObject({ media: REFERENCE })
    expect(shaped.data).not.toHaveProperty('media.base64')
  })

  it('leaves the shared event as it was', () => {
    const shared = event()

    shapeForWebhook(shared, options(), new Map([['a', 'AAAAAA']]))

    expect(shared.data).toEqual(withReference('a'))
  })

  it('puts the bytes of each message of a batch on its own message', () => {
    const batch = envelope('message_batch', {
      messages: [withReference('a'), withReference('b')]
    })

    const shaped = shapeForWebhook(batch, options(), new Map([['b', 'BBBBBB']]))

    const { messages } = shaped.data as { messages: { media: { base64?: string } }[] }
    expect(messages[0]?.media.base64).toBeUndefined()
    expect(messages[1]?.media.base64).toBe('BBBBBB')
  })
})
