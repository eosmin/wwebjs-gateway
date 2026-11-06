import { Logger } from '@nestjs/common'

import { TEST_ENV } from '../../tests/helpers/env.js'
import { parseEnv } from '../config/env.schema.js'
import type { Webhook } from '../database/models.js'
import type { DeliveriesRepository } from '../database/repositories/deliveries.repository.js'
import { MetricsService } from '../infra/metrics/metrics.service.js'
import type { EventEnvelope } from '../types/events.js'
import { EventBusService } from '../whatsapp/event-bus.service.js'

import type { DeliveryQueueService } from './delivery-queue.service.js'
import { WebhookDispatcherService } from './webhook-dispatcher.service.js'
import type { WebhookMediaService } from './webhook-media.service.js'
import type { WebhookService } from './webhook.service.js'

const webhook = (id: string, overrides: Partial<Webhook> = {}): Webhook => ({
  id,
  sessionId: null,
  url: 'https://hooks.example.test/in',
  secret: 'whsec_stored',
  events: ['*'],
  enabled: true,
  mediaMode: 'reference',
  includeRaw: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides
})

const message = {
  id: 'm1',
  body: 'hello',
  raw: { internal: true },
  media: { mimetype: 'image/png', downloadUrl: 'u', base64: 'AAAA' }
}

const event = (name = 'message', data: unknown = message, seq = 3): EventEnvelope =>
  ({
    id: `evt_${seq}`,
    event: name,
    sessionId: 'main',
    seq,
    timestamp: '2026-01-01T00:00:00.000Z',
    data
  }) as unknown as EventEnvelope

function setup(options: { includeRaw?: boolean } = {}) {
  const bus = new EventBusService()
  const forEvent = jest.fn((_s: string, _e: string) => Promise.resolve<Webhook[]>([]))
  const create = jest.fn((data: { id?: string }) => Promise.resolve({ id: data.id }))
  const failUnqueued = jest.fn((_id: string, _error: string) => Promise.resolve())
  const enqueue = jest.fn((_data: unknown) => Promise.resolve())
  const fetchInline = jest.fn((_event: EventEnvelope) => Promise.resolve(new Map<string, string>()))
  const metrics = new MetricsService()
  const config = parseEnv({ ...TEST_ENV, INCLUDE_RAW: String(options.includeRaw ?? true) })
  const service = new WebhookDispatcherService(
    config,
    bus,
    { forEvent } as unknown as WebhookService,
    { create, failUnqueued } as unknown as DeliveriesRepository,
    { enqueue } as unknown as DeliveryQueueService,
    { fetchInline } as unknown as WebhookMediaService,
    metrics
  )
  service.onModuleInit()
  return { bus, service, forEvent, create, failUnqueued, enqueue, metrics, fetchInline }
}

// The bus never awaits its subscribers, so the dispatcher is awaited through `dispatch`
const dispatched = async (
  ctx: ReturnType<typeof setup>,
  envelope: EventEnvelope
): Promise<void> => {
  await ctx.service.dispatch(envelope)
}

describe('WebhookDispatcherService', () => {
  let warn: jest.SpiedFunction<Logger['warn']>
  let error: jest.SpiedFunction<Logger['error']>
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation()
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation()
  })
  afterEach(() => jest.restoreAllMocks())

  it('asks the webhook list for the session and the event', async () => {
    const ctx = setup()
    await dispatched(ctx, event('message'))
    expect(ctx.forEvent).toHaveBeenCalledWith('main', 'message')
  })

  it('does nothing when no webhook wants the event', async () => {
    const ctx = setup()
    await dispatched(ctx, event())
    expect(ctx.create).not.toHaveBeenCalled()
    expect(ctx.enqueue).not.toHaveBeenCalled()
  })

  it('subscribes to every event of the bus and stops on shutdown', async () => {
    const ctx = setup()
    ctx.forEvent.mockResolvedValue([webhook('w1')])
    ctx.bus.publish(event('session_status', { status: 'ready' }))
    await new Promise(resolve => setImmediate(resolve))
    expect(ctx.enqueue).toHaveBeenCalledTimes(1)
    ctx.service.onModuleDestroy()
    ctx.bus.publish(event('session_status', { status: 'ready' }, 4))
    await new Promise(resolve => setImmediate(resolve))
    expect(ctx.enqueue).toHaveBeenCalledTimes(1)
  })

  it('stores a row and queues a job per webhook, with the same delivery id', async () => {
    const ctx = setup()
    ctx.forEvent.mockResolvedValue([webhook('w1'), webhook('w2', { sessionId: 'main' })])
    await dispatched(ctx, event('session_status', { status: 'ready' }))

    expect(ctx.create).toHaveBeenCalledTimes(2)
    expect(ctx.enqueue).toHaveBeenCalledTimes(2)
    const rows = ctx.create.mock.calls.map(([row]) => row)
    const jobs = ctx.enqueue.mock.calls.map(
      ([job]) => job as { deliveryId: string; webhookId: string }
    )
    expect(rows[0]).toMatchObject({
      webhookId: 'w1',
      sessionId: 'main',
      event: 'session_status',
      seq: 3n,
      payload: { id: 'evt_3', event: 'session_status', seq: 3 }
    })
    expect(new Set(rows.map(row => row.id)).size).toBe(2)
    expect(jobs.map(job => job.deliveryId)).toEqual(rows.map(row => row.id))
    // The job names its webhook, so it can be delivered when its row could not be stored
    expect(jobs.map(job => job.webhookId)).toEqual(['w1', 'w2'])
  })

  it('queues the full event and stores the redacted one', async () => {
    const ctx = setup()
    ctx.forEvent.mockResolvedValue([webhook('w1')])
    await dispatched(ctx, event('qr', { qr: '2@abcdefghijkl' }, 5))
    const [row] = ctx.create.mock.calls[0] ?? []
    const [job] = ctx.enqueue.mock.calls[0] ?? []
    expect((row as { payload: { data: unknown } }).payload.data).toEqual({ qr: '[Redacted]' })
    expect((job as { envelope: { data: unknown } }).envelope.data).toEqual({ qr: '2@abcdefghijkl' })
  })

  it('shapes the event for each webhook by its includeRaw and mediaMode', async () => {
    const ctx = setup({ includeRaw: true })
    ctx.forEvent.mockResolvedValue([
      webhook('keeps'),
      webhook('no-raw', { includeRaw: false }),
      webhook('no-media', { mediaMode: 'none' })
    ])
    await dispatched(ctx, event())
    const sent = Object.fromEntries(
      ctx.create.mock.calls.map(([row], index) => [
        (row as { webhookId: string }).webhookId,
        (ctx.enqueue.mock.calls[index]?.[0] as { envelope: { data: Record<string, unknown> } })
          .envelope.data
      ])
    )
    expect(sent['keeps']).toHaveProperty('raw')
    expect(sent['keeps']).toHaveProperty('media')
    expect(sent['no-raw']).not.toHaveProperty('raw')
    expect(sent['no-media']).not.toHaveProperty('media')
  })

  describe('media inline', () => {
    const photo = {
      id: 'm1',
      body: '',
      media: { mimetype: 'image/png', size: 4, downloadUrl: 'u' }
    }
    const sentTo = (ctx: ReturnType<typeof setup>) =>
      Object.fromEntries(
        ctx.create.mock.calls.map(([row], index) => [
          (row as { webhookId: string }).webhookId,
          (ctx.enqueue.mock.calls[index]?.[0] as { envelope: { data: { media?: object } } })
            .envelope.data.media
        ])
      )

    it('gives the downloaded bytes to the webhooks that take them inline and to no other', async () => {
      const ctx = setup()
      ctx.fetchInline.mockResolvedValue(new Map([['m1', 'AAAA']]))
      ctx.forEvent.mockResolvedValue([
        webhook('inline', { mediaMode: 'inline' }),
        webhook('reference', { mediaMode: 'reference' }),
        webhook('none', { mediaMode: 'none' })
      ])

      await dispatched(ctx, event('message', photo))

      expect(sentTo(ctx)).toEqual({
        inline: { mimetype: 'image/png', size: 4, downloadUrl: 'u', base64: 'AAAA' },
        reference: { mimetype: 'image/png', size: 4, downloadUrl: 'u' },
        none: undefined
      })
    })

    it('downloads once for the event, however many webhooks take it inline', async () => {
      const ctx = setup()
      ctx.forEvent.mockResolvedValue([
        webhook('one', { mediaMode: 'inline' }),
        webhook('two', { mediaMode: 'inline' })
      ])

      await dispatched(ctx, event('message', photo))

      expect(ctx.fetchInline).toHaveBeenCalledTimes(1)
    })

    it('downloads nothing when no webhook takes media inline', async () => {
      const ctx = setup()
      ctx.forEvent.mockResolvedValue([webhook('reference'), webhook('none', { mediaMode: 'none' })])

      await dispatched(ctx, event('message', photo))

      expect(ctx.fetchInline).not.toHaveBeenCalled()
    })

    it('still delivers the event, with the reference, when the download gave nothing', async () => {
      const ctx = setup()
      ctx.forEvent.mockResolvedValue([webhook('inline', { mediaMode: 'inline' })])

      await dispatched(ctx, event('message', photo))

      expect(sentTo(ctx)['inline']).toEqual({ mimetype: 'image/png', size: 4, downloadUrl: 'u' })
    })

    it('keeps the bytes out of the stored copy of the delivery', async () => {
      const ctx = setup()
      ctx.fetchInline.mockResolvedValue(new Map([['m1', 'AAAA']]))
      ctx.forEvent.mockResolvedValue([webhook('inline', { mediaMode: 'inline' })])

      await dispatched(ctx, event('message', photo))

      const row = ctx.create.mock.calls[0]?.[0] as { payload: { data: { media: object } } }
      expect(row.payload.data.media).not.toHaveProperty('base64')
    })
  })

  it('follows INCLUDE_RAW when the webhook has no choice', async () => {
    const ctx = setup({ includeRaw: false })
    ctx.forEvent.mockResolvedValue([webhook('follows'), webhook('asks', { includeRaw: true })])
    // With INCLUDE_RAW off the pipeline attached no `raw`, and a webhook cannot ask for more than there is
    const withoutRaw = { id: message.id, body: message.body, media: message.media }
    await dispatched(ctx, event('message', withoutRaw))
    const data = (index: number) =>
      (ctx.enqueue.mock.calls[index]?.[0] as { envelope: { data: object } }).envelope.data
    expect(data(0)).not.toHaveProperty('raw')
    expect(data(1)).not.toHaveProperty('raw')
  })

  it('does not change the envelope the bus gave it', async () => {
    const ctx = setup()
    ctx.forEvent.mockResolvedValue([webhook('w1', { includeRaw: false, mediaMode: 'none' })])
    const original = event()
    const snapshot = structuredClone(original)
    await dispatched(ctx, original)
    expect(original).toEqual(snapshot)
  })

  describe('a failure of one webhook', () => {
    it('does not stop the others when the insert fails, and the job still goes (TDD 6.9)', async () => {
      const ctx = setup()
      ctx.forEvent.mockResolvedValue([webhook('w1'), webhook('w2')])
      ctx.create.mockRejectedValueOnce(new Error('db down: secret-ish'))
      await dispatched(ctx, event())
      expect(ctx.enqueue).toHaveBeenCalledTimes(2)
      expect(ctx.failUnqueued).not.toHaveBeenCalled()
      expect(error).toHaveBeenCalledTimes(1)
    })

    it('counts the delivery that has no row', async () => {
      const ctx = setup()
      ctx.forEvent.mockResolvedValue([webhook('w1')])
      ctx.create.mockRejectedValueOnce(new Error('db down'))
      await dispatched(ctx, event())
      expect(await ctx.metrics.scrape()).toContain('result="unlogged"} 1')
    })

    it('sends a dead letter to the failed list when the job cannot be queued', async () => {
      const ctx = setup()
      ctx.forEvent.mockResolvedValue([webhook('w1'), webhook('w2')])
      ctx.enqueue.mockRejectedValueOnce(new Error('redis down'))
      await dispatched(ctx, event())
      expect(ctx.enqueue).toHaveBeenCalledTimes(2)
      const [firstRow] = ctx.create.mock.calls[0] ?? []
      expect(ctx.failUnqueued).toHaveBeenCalledTimes(1)
      expect(ctx.failUnqueued).toHaveBeenCalledWith(
        (firstRow as { id: string }).id,
        'The delivery could not be queued'
      )
      expect(await ctx.metrics.scrape()).toContain('result="not_queued"} 1')
    })

    it('survives a dead letter that cannot be marked either', async () => {
      const ctx = setup()
      ctx.forEvent.mockResolvedValue([webhook('w1'), webhook('w2')])
      ctx.enqueue.mockRejectedValueOnce(new Error('redis down'))
      ctx.failUnqueued.mockRejectedValueOnce(new Error('db down'))
      await expect(dispatched(ctx, event())).resolves.toBeUndefined()
      expect(ctx.enqueue).toHaveBeenCalledTimes(2)
    })

    it('does not mark a row that was never stored', async () => {
      const ctx = setup()
      ctx.forEvent.mockResolvedValue([webhook('w1')])
      ctx.create.mockRejectedValueOnce(new Error('db down'))
      ctx.enqueue.mockRejectedValueOnce(new Error('redis down'))
      await dispatched(ctx, event())
      expect(ctx.failUnqueued).not.toHaveBeenCalled()
    })

    it('never logs the payload, the URL, the secret or the error text', async () => {
      const ctx = setup()
      ctx.forEvent.mockResolvedValue([webhook('w1')])
      ctx.create.mockRejectedValueOnce(new Error('password=hunter2 hello'))
      ctx.enqueue.mockRejectedValueOnce(new Error('redis://:hunter2@host'))
      await dispatched(ctx, event())
      const logged = JSON.stringify([...error.mock.calls, ...warn.mock.calls])
      for (const secret of ['hunter2', 'hello', 'whsec_stored', 'hooks.example.test']) {
        expect(logged).not.toContain(secret)
      }
    })
  })

  it('survives an event it cannot shape', async () => {
    const ctx = setup()
    ctx.forEvent.mockResolvedValue([webhook('bad'), webhook('good')])
    const poisoned = event('message', {
      get media(): never {
        throw new Error('hello password=hunter2')
      }
    })
    await expect(dispatched(ctx, poisoned)).resolves.toBeUndefined()
    expect(error).toHaveBeenCalled()
    expect(JSON.stringify(error.mock.calls)).not.toContain('hunter2')
  })

  it('stays quiet when the webhook list cannot be read, and logs it once', async () => {
    const ctx = setup()
    ctx.forEvent.mockRejectedValueOnce(new Error('db down'))
    await expect(dispatched(ctx, event())).resolves.toBeUndefined()
    expect(ctx.create).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('reads the list again after a write: the cache lives in the webhook service', async () => {
    const ctx = setup()
    ctx.forEvent.mockResolvedValueOnce([webhook('old')]).mockResolvedValueOnce([webhook('new')])
    await dispatched(ctx, event())
    await dispatched(ctx, event('message', message, 4))
    const webhooks = ctx.create.mock.calls.map(([row]) => (row as { webhookId: string }).webhookId)
    expect(webhooks).toEqual(['old', 'new'])
  })
})
