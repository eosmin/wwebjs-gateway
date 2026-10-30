import { buildMessageDto } from '../../tests/helpers/fake-whatsapp-client.js'
import { NotFoundError, ValidationError } from '../common/errors.js'
import type { AppConfig } from '../config/env.schema.js'
import { SendMessageBody } from '../types/messages.dto.js'
import type { PolicyDecision } from '../types/send-policy.dto.js'
import type { SessionManager } from '../whatsapp/session-manager.service.js'
import type { WhatsAppClientPort } from '../whatsapp/whatsapp-client.port.js'

import type { HumanizeDefaultsService } from './humanize-defaults.service.js'
import type { IdempotentSendService } from './idempotent-send.service.js'
import type { MediaResolverService } from './media-resolver.service.js'
import { MessageSendService } from './message-send.service.js'
import type { RecipientResolverService } from './recipient-resolver.service.js'
import type { SendPolicyService } from './send-policy.service.js'
import type { NewSendJob } from './send-queue.job.js'

const CHAT = '5215500000001@c.us'

function build(
  options: {
    policy?: PolicyDecision
    original?: ReturnType<typeof buildMessageDto> | null
    replay?: { jobId: string; replayed: boolean }
  } = {}
) {
  const send = jest.fn((_job: NewSendJob, _options: { waitMs?: number; requestHash?: string }) =>
    Promise.resolve({ jobId: 'job-1', replayed: false })
  )
  const peek = jest.fn((_session: string, _key: string, _hash: string) =>
    Promise.resolve(options.replay)
  )
  const resolve = jest.fn((_session: string, to: string) =>
    Promise.resolve(to.includes('@') ? to : CHAT)
  )
  const media = { resolve: jest.fn(() => Promise.resolve({ mimetype: 'image/png', data: 'QUJD' })) }
  const check = jest.fn(() => Promise.resolve(options.policy ?? { decision: 'allow' as const }))
  const getMessageById = jest.fn(() =>
    Promise.resolve(
      options.original === undefined ? buildMessageDto({ chatId: '999@g.us' }) : options.original
    )
  )
  const humanize = jest.fn((_session: string, requested: unknown, type: string) =>
    Promise.resolve(requested ?? (type === 'text' ? { typing: 'auto' as const } : undefined))
  )
  const service = new MessageSendService(
    { SEND_SYNC_TIMEOUT_MS: 60_000 } as AppConfig,
    {
      requireReady: () => ({ getMessageById }) as unknown as WhatsAppClientPort
    } as unknown as SessionManager,
    { resolve } as unknown as RecipientResolverService,
    media as unknown as MediaResolverService,
    { check } as unknown as SendPolicyService,
    { send, peek } as unknown as IdempotentSendService,
    { resolve: humanize } as unknown as HumanizeDefaultsService
  )
  const jobOf = (): NewSendJob => {
    const [first] = send.mock.calls
    if (!first) throw new Error('nothing was sent')
    return first[0]
  }
  return { service, send, peek, check, media, resolve, humanize, jobOf }
}

const parse = (body: unknown): SendMessageBody => SendMessageBody.parse(body)
const request = { sessionId: 's', wait: true }

describe('MessageSendService', () => {
  it('queues text for the resolved chat and waits SEND_SYNC_TIMEOUT_MS', async () => {
    const { service, send, jobOf } = build()

    const result = await service.send(
      { ...request, idempotencyKey: 'k1' },
      parse({ to: '+52 55 0000 0001', type: 'text', body: 'hola', humanize: { typing: 'auto' } })
    )

    expect(result).toEqual({ jobId: 'job-1', replayed: false })
    expect(jobOf()).toEqual({
      sessionId: 's',
      chatId: CHAT,
      content: { type: 'text', body: 'hola' },
      options: {},
      humanize: { typing: 'auto' },
      idempotencyKey: 'k1'
    })
    expect(send.mock.calls[0]?.[1]).toEqual({
      waitMs: 60_000,
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown
    })
  })

  it('does not wait with wait=false', async () => {
    const { service, send } = build()

    await service.send(
      { sessionId: 's', wait: false },
      parse({ to: CHAT, type: 'text', body: 'x' })
    )

    expect(send.mock.calls[0]?.[1]).toEqual({})
  })

  it('maps the common options one to one', async () => {
    const { service, jobOf } = build()

    await service.send(
      request,
      parse({
        to: CHAT,
        type: 'text',
        body: 'x',
        quotedMessageId: 'q1',
        ignoreQuoteErrors: true,
        mentions: ['5215500000002@c.us'],
        groupMentions: [{ subject: 'G', id: '1@g.us' }],
        linkPreview: false,
        parseVCards: false,
        sendSeen: true,
        waitUntilMsgSent: true
      })
    )

    expect(jobOf().options).toEqual({
      quotedMessageId: 'q1',
      ignoreQuoteErrors: true,
      mentions: ['5215500000002@c.us'],
      groupMentions: [{ subject: 'G', id: '1@g.us' }],
      linkPreview: false,
      parseVCards: false,
      sendSeen: true,
      waitUntilMsgSent: true
    })
  })

  it('resolves the media and maps its options', async () => {
    const { service, media, jobOf } = build()

    await service.send(
      request,
      parse({
        to: CHAT,
        type: 'media',
        source: { url: 'https://cdn.example.com/a.png' },
        caption: 'look',
        asDocument: true,
        asVoice: true,
        asGif: true,
        asSticker: true,
        stickerName: 'n',
        stickerAuthor: 'a',
        stickerCategories: ['😀'],
        asHd: true,
        viewOnce: true
      })
    )

    expect(media.resolve).toHaveBeenCalledWith('s', { url: 'https://cdn.example.com/a.png' })
    expect(jobOf().content).toEqual({
      type: 'media',
      media: { mimetype: 'image/png', data: 'QUJD' }
    })
    expect(jobOf().options).toEqual({
      caption: 'look',
      sendMediaAsDocument: true,
      sendAudioAsVoice: true,
      sendVideoAsGif: true,
      sendMediaAsSticker: true,
      stickerName: 'n',
      stickerAuthor: 'a',
      stickerCategories: ['😀'],
      sendMediaAsHd: true,
      isViewOnce: true
    })
  })

  it.each([
    [
      'location',
      { type: 'location', latitude: 19.4, longitude: -99.1, name: 'Zócalo' },
      { type: 'location', latitude: 19.4, longitude: -99.1, name: 'Zócalo' }
    ],
    [
      'contacts',
      { type: 'contacts', contactIds: ['5215500000002@c.us', '5215500000003@c.us'] },
      { type: 'contacts', contactIds: ['5215500000002@c.us', '5215500000003@c.us'] }
    ],
    [
      'a contact by id',
      { type: 'contact', contactId: '5215500000002@c.us' },
      { type: 'contacts', contactIds: ['5215500000002@c.us'] }
    ],
    [
      'a poll',
      { type: 'poll', name: '¿Cuándo?', options: ['Hoy', 'Mañana'], allowMultipleAnswers: true },
      { type: 'poll', name: '¿Cuándo?', options: ['Hoy', 'Mañana'], allowMultipleAnswers: true }
    ],
    [
      'an event',
      { type: 'event', name: 'Demo', startTime: '2026-02-01T10:00:00.000Z', callType: 'video' },
      {
        type: 'event',
        name: 'Demo',
        startTime: new Date('2026-02-01T10:00:00.000Z'),
        callType: 'video'
      }
    ]
  ])('sends %s', async (_label, body, content) => {
    const { service, jobOf } = build()

    await service.send(request, parse({ to: CHAT, ...body }))

    expect(jobOf().content).toEqual(content)
  })

  it('sends a vCard as text that WhatsApp parses', async () => {
    const { service, jobOf } = build()

    await service.send(
      request,
      parse({ to: CHAT, type: 'contact', vcard: 'BEGIN:VCARD\nEND:VCARD' })
    )

    expect(jobOf().content).toEqual({ type: 'text', body: 'BEGIN:VCARD\nEND:VCARD' })
    expect(jobOf().options).toEqual({ parseVCards: true })
  })

  it('refuses a contact with both or neither of contactId and vcard before anything runs', () => {
    expect(() => parse({ to: CHAT, type: 'contact' })).toThrow('Send either contactId or vcard')
    expect(() =>
      parse({ to: CHAT, type: 'contact', contactId: '5215500000002@c.us', vcard: 'x' })
    ).toThrow('Send either contactId or vcard')
  })

  it('sends the invite of a group as its link, with a preview', async () => {
    const { service, jobOf } = build()

    await service.send(
      request,
      parse({ to: CHAT, type: 'groupInvite', inviteCode: 'AbCdEfGhIjKl' })
    )

    expect(jobOf().content).toEqual({
      type: 'text',
      body: 'https://chat.whatsapp.com/AbCdEfGhIjKl'
    })
    expect(jobOf().options).toEqual({ linkPreview: true })
  })

  it('stops a send the policy rejects, before queueing it', async () => {
    const { service, send, check } = build({
      policy: { decision: 'reject', code: 'RECIPIENT_SUPPRESSED', rule: 'SUPPRESSED' as never }
    })

    await expect(
      service.send(request, parse({ to: CHAT, type: 'text', body: 'hola' }))
    ).rejects.toMatchObject({ code: 'RECIPIENT_SUPPRESSED', details: { rule: 'SUPPRESSED' } })
    expect(check).toHaveBeenCalledWith({ sessionId: 's', chatId: CHAT, body: 'hola', waitedMs: 0 })
    expect(send).not.toHaveBeenCalled()
  })

  describe('the order of the work', () => {
    it('asks the policy before it downloads any media', async () => {
      const { service, media } = build({
        policy: { decision: 'reject', code: 'RECIPIENT_SUPPRESSED', rule: 'SUPPRESSED' as never }
      })

      await expect(
        service.send(
          request,
          parse({ to: CHAT, type: 'media', source: { url: 'https://cdn.example.com/a.png' } })
        )
      ).rejects.toMatchObject({ code: 'RECIPIENT_SUPPRESSED' })
      expect(media.resolve).not.toHaveBeenCalled()
    })

    it.each([
      [
        'a media sends its caption',
        { type: 'media', source: { base64: 'QUJD', mimetype: 'image/png' }, caption: 'look' },
        'look'
      ],
      ['a vCard sends its text', { type: 'contact', vcard: 'BEGIN:VCARD' }, 'BEGIN:VCARD'],
      [
        'a group invite sends its link',
        { type: 'groupInvite', inviteCode: 'AbCdEfGhIjKl' },
        'https://chat.whatsapp.com/AbCdEfGhIjKl'
      ],
      ['a location has no text', { type: 'location', latitude: 1, longitude: 2 }, undefined]
    ])('gives the policy what the recipient will read: %s', async (_label, body, text) => {
      const { service, check } = build()

      await service.send(request, parse({ to: CHAT, ...body }))

      expect(check).toHaveBeenCalledWith({ sessionId: 's', chatId: CHAT, body: text, waitedMs: 0 })
    })

    it('queues the send when the policy only delays it: pacing is the worker job, never an error', async () => {
      const { service, send } = build({
        policy: { decision: 'delay', delayMs: 5000, rule: 'SESSION_MAX_PER_MINUTE' as never }
      })

      await service.send(request, parse({ to: CHAT, type: 'text', body: 'hola' }))

      expect(send).toHaveBeenCalledTimes(1)
    })

    it('fails before queueing when the recipient or the media cannot be resolved', async () => {
      const failing = build()
      failing.resolve.mockRejectedValueOnce(new NotFoundError('NOT_FOUND', 'no'))
      await expect(
        failing.service.send(request, parse({ to: '5215500000001', type: 'text', body: 'x' }))
      ).rejects.toBeInstanceOf(NotFoundError)
      expect(failing.send).not.toHaveBeenCalled()

      const noMedia = build()
      noMedia.media.resolve.mockRejectedValueOnce(new ValidationError('VALIDATION_ERROR', 'bad'))
      await expect(
        noMedia.service.send(
          request,
          parse({ to: CHAT, type: 'media', source: { base64: 'QUJD', mimetype: 'image/png' } })
        )
      ).rejects.toBeInstanceOf(ValidationError)
      expect(noMedia.send).not.toHaveBeenCalled()
    })
  })

  describe('idempotent replays', () => {
    const keyed = { ...request, idempotencyKey: 'k1' }
    const body = { to: CHAT, type: 'text', body: 'hola' }

    it('answers a key used before without resolving, checking or queueing anything', async () => {
      const { service, send, resolve, check, media } = build({
        replay: { jobId: 'old', replayed: true }
      })

      await expect(service.send(keyed, parse(body))).resolves.toEqual({
        jobId: 'old',
        replayed: true
      })
      expect(resolve).not.toHaveBeenCalled()
      expect(check).not.toHaveBeenCalled()
      expect(media.resolve).not.toHaveBeenCalled()
      expect(send).not.toHaveBeenCalled()
    })

    it('does not look at all without a key', async () => {
      const { service, peek } = build()

      await service.send(request, parse(body))

      expect(peek).not.toHaveBeenCalled()
    })

    it('hashes the request as it was written, so it does not change with what is resolved', async () => {
      const first = build()
      await first.service.send(keyed, parse(body))
      const second = build()
      second.resolve.mockResolvedValue('999@c.us')
      second.humanize.mockResolvedValue({ typing: 99 })
      await second.service.send(keyed, parse(body))

      const hashOf = (built: ReturnType<typeof build>) => built.send.mock.calls[0]?.[1]?.requestHash
      expect(hashOf(first)).toMatch(/^[0-9a-f]{64}$/)
      expect(hashOf(second)).toBe(hashOf(first))
      expect(first.peek.mock.calls[0]?.[2]).toBe(hashOf(first))
    })

    it('hashes another request differently, a reply and a forward included', async () => {
      const hashes = new Set<string | undefined>()
      for (const run of [
        (s: MessageSendService) => s.send(keyed, parse(body)),
        (s: MessageSendService) => s.send(keyed, parse({ ...body, body: 'otro' })),
        (s: MessageSendService) => s.reply(keyed, 'm1', { type: 'text', body: 'hola', to: CHAT }),
        (s: MessageSendService) => s.reply(keyed, 'm2', { type: 'text', body: 'hola', to: CHAT }),
        (s: MessageSendService) => s.forward(keyed, 'm1', CHAT),
        (s: MessageSendService) => s.forward(keyed, 'm1', '5215500000009@c.us')
      ]) {
        const built = build()
        await run(built.service)
        hashes.add(built.send.mock.calls[0]?.[1]?.requestHash)
      }

      expect(hashes.size).toBe(6)
    })

    it('does not resolve the chat of a reply it can already answer', async () => {
      const { service } = build({ replay: { jobId: 'old', replayed: true } })
      const getMessageById = jest.fn()
      Object.assign(service, { chatOf: getMessageById })

      await service.reply(keyed, 'm1', { type: 'text', body: 'x' })

      expect(getMessageById).not.toHaveBeenCalled()
    })
  })

  describe('humanize', () => {
    it('gives a text the humanize the defaults resolve, and a media none', async () => {
      const { service, humanize, jobOf } = build()

      await service.send(request, parse({ to: CHAT, type: 'text', body: 'x' }))
      expect(humanize).toHaveBeenLastCalledWith('s', undefined, 'text')
      expect(jobOf().humanize).toEqual({ typing: 'auto' })

      const media = build()
      await media.service.send(
        request,
        parse({ to: CHAT, type: 'media', source: { base64: 'QUJD', mimetype: 'image/png' } })
      )
      expect(media.humanize).toHaveBeenLastCalledWith('s', undefined, 'media')
      expect(media.jobOf().humanize).toBeUndefined()
    })

    it('passes the humanize of the request to be kept', async () => {
      const { service, humanize, jobOf } = build()

      await service.send(
        request,
        parse({ to: CHAT, type: 'text', body: 'x', humanize: { typing: 5 } })
      )

      expect(humanize).toHaveBeenLastCalledWith('s', { typing: 5 }, 'text')
      expect(jobOf().humanize).toEqual({ typing: 5 })
    })
  })

  describe('forward', () => {
    it('queues a forward for the resolved chat with the key, the policy and the wait of any send', async () => {
      const { service, send, check, jobOf } = build()

      const result = await service.forward(
        { ...request, idempotencyKey: 'k9' },
        'm-1',
        '5215500000001'
      )

      expect(result).toEqual({ jobId: 'job-1', replayed: false })
      expect(jobOf()).toEqual({
        sessionId: 's',
        chatId: CHAT,
        content: { type: 'forward', messageId: 'm-1' },
        idempotencyKey: 'k9'
      })
      expect(check).toHaveBeenCalledWith({
        sessionId: 's',
        chatId: CHAT,
        body: undefined,
        waitedMs: 0
      })
      expect(send.mock.calls[0]?.[1]).toEqual({
        waitMs: 60_000,
        requestHash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown
      })
    })

    it('stops at a rejection of the policy like any send', async () => {
      const { service, send } = build({
        policy: { decision: 'reject', code: 'RECIPIENT_SUPPRESSED', rule: 'SUPPRESSED' as never }
      })

      await expect(service.forward(request, 'm-1', CHAT)).rejects.toMatchObject({
        code: 'RECIPIENT_SUPPRESSED'
      })
      expect(send).not.toHaveBeenCalled()
    })
  })

  describe('reply', () => {
    it('quotes the message and goes to its chat when `to` is missing', async () => {
      const { service, jobOf } = build()

      await service.reply(request, 'orig-1', { type: 'text', body: 'ok' })

      expect(jobOf().chatId).toBe('999@g.us')
      expect(jobOf().options).toEqual({ quotedMessageId: 'orig-1' })
    })

    it('goes where `to` says', async () => {
      const { service, jobOf } = build()

      await service.reply(request, 'orig-1', { type: 'text', body: 'ok', to: CHAT })

      expect(jobOf().chatId).toBe(CHAT)
    })

    it('404s when the message does not exist', async () => {
      const { service } = build({ original: null })

      await expect(
        service.reply(request, 'gone', { type: 'text', body: 'ok' })
      ).rejects.toBeInstanceOf(NotFoundError)
    })
  })
})
