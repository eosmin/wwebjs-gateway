import { Logger } from '@nestjs/common'

import { TEST_ENV } from '../../tests/helpers/env.js'
import { parseEnv } from '../config/env.schema.js'
import type { EventEnvelope } from '../types/events.js'
import type { SessionManager } from '../whatsapp/session-manager.service.js'
import type { DownloadedMedia } from '../whatsapp/whatsapp-client.port.js'

import { WebhookMediaService } from './webhook-media.service.js'

const MAX = 16

const message = (id: string, size: number | undefined = 4) => ({
  id,
  hasMedia: true,
  media: {
    mimetype: 'image/png',
    downloadUrl: `https://gw/${id}`,
    ...(size !== undefined && { size })
  }
})

const event = (name: string, data: unknown): EventEnvelope =>
  ({
    id: 'evt_1',
    event: name,
    sessionId: 'main',
    seq: 4,
    timestamp: '2026-01-01T00:00:00.000Z',
    data
  }) as unknown as EventEnvelope

function setup(downloads: Record<string, DownloadedMedia | null | Error> = {}) {
  const downloadMedia = jest.fn((id: string) => {
    const answer = downloads[id]
    if (answer instanceof Error) return Promise.reject(answer)
    return Promise.resolve(answer ?? null)
  })
  const requireReady = jest.fn((_id: string) => ({ downloadMedia }))
  const service = new WebhookMediaService(
    parseEnv({ ...TEST_ENV, WEBHOOK_INLINE_MEDIA_MAX_BYTES: String(MAX) }),
    { requireReady } as unknown as SessionManager
  )
  return { service, downloadMedia, requireReady }
}

const file = (base64: string): DownloadedMedia => ({ mimetype: 'image/png', data: base64 })

describe('WebhookMediaService', () => {
  let warn: jest.SpiedFunction<Logger['warn']>
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation()
  })
  afterEach(() => jest.restoreAllMocks())

  it('downloads the file of each message that fits and answers its bytes by message id', async () => {
    const { service, downloadMedia } = setup({ a: file('AAAA'), b: file('BBBB') })

    const bytes = await service.fetchInline(
      event('message_batch', { messages: [message('a'), message('b')] })
    )

    expect(downloadMedia).toHaveBeenCalledTimes(2)
    expect([...bytes]).toEqual([
      ['a', 'AAAA'],
      ['b', 'BBBB']
    ])
  })

  it('does not touch the session when no message qualifies', async () => {
    const { service, requireReady, downloadMedia } = setup()

    const bytes = await service.fetchInline(event('message', message('a', 1000)))

    expect(bytes.size).toBe(0)
    expect(requireReady).not.toHaveBeenCalled()
    expect(downloadMedia).not.toHaveBeenCalled()
  })

  it('downloads nothing for an event that is not a new message', async () => {
    const { service, downloadMedia } = setup({ a: file('AAAA') })

    await service.fetchInline(event('message_ack', { message: message('a') }))

    expect(downloadMedia).not.toHaveBeenCalled()
  })

  it('keeps the bytes out when the file is larger than it said', async () => {
    const { service } = setup({ a: file('A'.repeat(100)) })

    const bytes = await service.fetchInline(event('message', message('a', 4)))

    expect(bytes.size).toBe(0)
  })

  it('leaves out a file WhatsApp no longer has, and goes on with the others', async () => {
    const { service } = setup({ a: null, b: file('BBBB') })

    const bytes = await service.fetchInline(
      event('message_batch', { messages: [message('a'), message('b')] })
    )

    expect([...bytes.keys()]).toEqual(['b'])
  })

  it('never rejects: a download that fails costs that file and says what kind of failure', async () => {
    const { service } = setup({ a: new Error('the url https://secret.example/x was reset') })

    const bytes = await service.fetchInline(event('message', message('a')))

    expect(bytes.size).toBe(0)
    const logged = warn.mock.calls.map(call => String(call[0])).join('\n')
    expect(logged).toContain('Error')
    expect(logged).not.toContain('secret.example')
    expect(logged).not.toContain('"a"')
  })

  it('downloads at most ten files for an event, the rest go by reference', async () => {
    const messages = Array.from({ length: 12 }, (_, index) => message(`m${index}`))
    const { service, downloadMedia } = setup(
      Object.fromEntries(messages.map(item => [item.id, file('AAAA')]))
    )

    const bytes = await service.fetchInline(event('message_batch', { messages }))

    expect(downloadMedia).toHaveBeenCalledTimes(10)
    expect(bytes.size).toBe(10)
  })

  it('says when a file turns out larger than the limit, without naming it', async () => {
    const { service } = setup({ a: file('A'.repeat(100)) })

    await service.fetchInline(event('message', message('a', 4)))

    const logged = warn.mock.calls.map(call => String(call[0])).join('\n')
    expect(logged).toContain('larger')
    expect(logged).not.toContain('"a"')
  })

  it('goes on with the next file after one fails', async () => {
    const { service } = setup({ a: new Error('reset'), b: file('BBBB') })

    const bytes = await service.fetchInline(
      event('message_batch', { messages: [message('a'), message('b')] })
    )

    expect([...bytes.keys()]).toEqual(['b'])
  })

  it('never rejects when the session is not ready', async () => {
    const { service, requireReady } = setup()
    requireReady.mockImplementationOnce(() => {
      throw new Error('not ready')
    })

    const bytes = await service.fetchInline(event('message', message('a')))

    expect(bytes.size).toBe(0)
  })
})
