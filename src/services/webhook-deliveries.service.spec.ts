import {
  InternalError,
  NotFoundError,
  ServiceBusyError,
  ValidationError
} from '../common/errors.js'
import type { AppConfig } from '../config/env.schema.js'
import type { Webhook, WebhookDelivery } from '../database/models.js'
import type {
  DeliveriesRepository,
  DeliveryFilter
} from '../database/repositories/deliveries.repository.js'
import type { SessionsRepository } from '../database/repositories/sessions.repository.js'

import type { DeliveryJobData, DeliveryQueueService } from './delivery-queue.service.js'
import {
  RETRY_FAILED_LIMIT,
  WebhookDeliveriesService,
  toDeliveryDto
} from './webhook-deliveries.service.js'

const WEBHOOK_ID = '7f0c3f4e-2b1a-4c55-9a52-0c1c3f6f2d10'
const OTHER_WEBHOOK_ID = '3b9a1c0e-6d2f-4f7e-8a41-5e0d7c9b1a22'

const webhook = (overrides: Partial<Webhook> = {}): Webhook => ({
  id: WEBHOOK_ID,
  sessionId: 'main',
  url: 'https://hooks.example.test/in',
  secret: 'whsec_stored',
  events: ['*'],
  enabled: true,
  mediaMode: 'reference',
  includeRaw: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides
})

const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`

const envelope = (n: number) => ({
  id: `evt_${n}`,
  event: 'message',
  sessionId: 'main',
  seq: n,
  timestamp: '2026-01-01T00:00:00.000Z',
  data: { body: 'redacted' }
})

const delivery = (n: number, overrides: Partial<WebhookDelivery> = {}): WebhookDelivery => ({
  id: uuid(n),
  webhookId: WEBHOOK_ID,
  sessionId: 'main',
  event: 'message',
  seq: BigInt(n),
  payload: envelope(n),
  status: 'failed',
  attempts: 3,
  lastStatusCode: 500,
  lastError: 'HTTP 500',
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 1000 - n)),
  deliveredAt: null,
  ...overrides
})

function setup() {
  const store = new Map<string, WebhookDelivery>()
  const deliveries = {
    create: jest.fn((data: Record<string, unknown>) => {
      const row = delivery(1, {
        ...(data as Partial<WebhookDelivery>),
        id: uuid(900),
        status: 'pending',
        attempts: 0,
        lastStatusCode: null,
        lastError: null
      })
      store.set(row.id, row)
      return Promise.resolve(row)
    }),
    findById: jest.fn((id: string) => Promise.resolve(store.get(id) ?? null)),
    listForWebhook: jest.fn((webhookId: string, filter: DeliveryFilter) => {
      const rows = [...store.values()]
        .filter(row => row.webhookId === webhookId)
        .filter(row => filter.status === undefined || row.status === filter.status)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
        .filter(
          row =>
            filter.before === undefined ||
            row.createdAt < filter.before.createdAt ||
            (row.createdAt.getTime() === filter.before.createdAt.getTime() &&
              row.id < filter.before.id)
        )
      return Promise.resolve(rows.slice(0, filter.limit))
    }),
    resetForRetry: jest.fn((id: string) => {
      const row = store.get(id)
      if (row?.status !== 'failed') return Promise.resolve(null)
      const reset = { ...row, status: 'pending' as const }
      store.set(id, reset)
      return Promise.resolve(reset)
    }),
    failUnqueued: jest.fn(() => Promise.resolve())
  }
  const sessions = {
    findById: jest.fn((id: string) => Promise.resolve(id === 'main' ? { id } : null))
  }
  const queue = {
    enqueue: jest.fn<Promise<void>, [DeliveryJobData]>(() => Promise.resolve())
  }
  const service = new WebhookDeliveriesService(
    deliveries as unknown as DeliveriesRepository,
    sessions as unknown as SessionsRepository,
    queue as unknown as DeliveryQueueService,
    { WEBHOOK_TEST_MAX_PER_MINUTE: 3 } as AppConfig
  )
  const seed = (...rows: WebhookDelivery[]): void => {
    for (const row of rows) store.set(row.id, row)
  }
  return { service, deliveries, sessions, queue, store, seed }
}

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise
  } catch (error) {
    return error
  }
  return undefined
}

describe('toDeliveryDto', () => {
  it('turns the bigint seq into a number and leaves the payload in the gateway', () => {
    const dto = toDeliveryDto(delivery(5))

    expect(dto.seq).toBe(5)
    expect(dto).not.toHaveProperty('payload')
    expect(dto.createdAt).toBe('2026-01-01T00:00:00.995Z')
  })
})

describe('WebhookDeliveriesService.test', () => {
  it('queues a ping of the session of the webhook and answers the pending delivery', async () => {
    const { service, deliveries, queue } = setup()

    const dto = await service.test(webhook(), {})

    expect(dto).toMatchObject({ webhookId: WEBHOOK_ID, event: 'ping', status: 'pending' })
    expect(deliveries.create).toHaveBeenCalledWith(
      expect.objectContaining({ webhookId: WEBHOOK_ID, sessionId: 'main', event: 'ping' })
    )
    const job = queue.enqueue.mock.calls[0]?.[0]
    expect(job?.deliveryId).toBe(dto.id)
    expect(job?.envelope).toMatchObject({
      event: 'ping',
      sessionId: 'main',
      data: {},
      seq: 0
    })
    expect(job?.envelope.id).toMatch(/^evt_[0-9a-f-]{36}$/)
  })

  it('stores the same envelope that it queues, so a retry sends what the first try sent', async () => {
    const { service, deliveries, queue } = setup()

    await service.test(webhook(), {})

    const stored = (deliveries.create.mock.calls[0]?.[0] as { payload: unknown }).payload
    expect(stored).toEqual(queue.enqueue.mock.calls[0]?.[0].envelope)
  })

  it('refuses another session for a webhook that belongs to one', async () => {
    const { service, queue } = setup()

    expect(await rejection(service.test(webhook(), { sessionId: 'other' }))).toBeInstanceOf(
      ValidationError
    )
    expect(queue.enqueue).not.toHaveBeenCalled()
  })

  it('needs a session for a webhook of every session, and that it exists', async () => {
    const { service, queue } = setup()
    const global = webhook({ sessionId: null })

    expect(await rejection(service.test(global, {}))).toBeInstanceOf(ValidationError)
    expect(await rejection(service.test(global, { sessionId: 'nope' }))).toBeInstanceOf(
      NotFoundError
    )
    expect(await service.test(global, { sessionId: 'main' })).toMatchObject({ sessionId: 'main' })
    expect(queue.enqueue).toHaveBeenCalledTimes(1)
  })

  it('sends the delivery to the dead letters when the queue fails, and passes the error on', async () => {
    const { service, deliveries, queue } = setup()
    queue.enqueue.mockRejectedValueOnce(new Error('redis down'))

    await expect(service.test(webhook(), {})).rejects.toThrow('redis down')

    expect(deliveries.failUnqueued).toHaveBeenCalledWith(uuid(900), expect.any(String))
  })
})

// A ping goes out to the URL of the webhook with the signature of the gateway: without a limit of its
// own, a key could use it to send a stream of POSTs to a third party, or to probe an internal host
// the operator allowed for webhooks, as fast as the general rate limit lets it
describe('WebhookDeliveriesService.test, the limit of pings', () => {
  const START = Date.parse('2026-03-01T00:00:00Z')
  let now = START
  beforeEach(() => {
    now = START
    jest.spyOn(Date, 'now').mockImplementation(() => now)
  })
  afterEach(() => jest.restoreAllMocks())

  it('refuses the ping after WEBHOOK_TEST_MAX_PER_MINUTE in a minute, saying when to try again', async () => {
    const { service, queue } = setup()
    for (let i = 0; i < 3; i += 1) await service.test(webhook(), {})

    const error = await rejection(service.test(webhook(), {}))

    expect(error).toBeInstanceOf(ServiceBusyError)
    expect(error).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 60 })
    expect(queue.enqueue).toHaveBeenCalledTimes(3)
  })

  it('counts a refused ping out, and lets a ping through again as the minute passes', async () => {
    const { service, queue } = setup()
    await service.test(webhook(), {})
    now += 20_000
    await service.test(webhook(), {})
    await service.test(webhook(), {})
    expect(await rejection(service.test(webhook(), {}))).toMatchObject({ retryAfterSeconds: 40 })

    now += 40_000
    await service.test(webhook(), {})

    expect(queue.enqueue).toHaveBeenCalledTimes(4)
  })

  it('gives the ping back when the queue or the database fails, so a dead Redis does not turn into a 429', async () => {
    const { service, queue } = setup()
    queue.enqueue.mockRejectedValue(new Error('redis down'))
    for (let i = 0; i < 5; i += 1) {
      await expect(service.test(webhook(), {})).rejects.toThrow('redis down')
    }
    queue.enqueue.mockResolvedValue(undefined)

    await expect(service.test(webhook(), {})).resolves.toBeDefined()
  })

  it('limits each webhook apart', async () => {
    const { service } = setup()
    for (let i = 0; i < 3; i += 1) await service.test(webhook(), {})

    await expect(service.test(webhook({ id: OTHER_WEBHOOK_ID }), {})).resolves.toBeDefined()
  })

  it('does not spend the allowance on a ping that was refused for another reason', async () => {
    const { service } = setup()
    for (let i = 0; i < 5; i += 1) {
      await rejection(service.test(webhook(), { sessionId: 'other' }))
    }

    await expect(service.test(webhook(), {})).resolves.toBeDefined()
  })
})

describe('WebhookDeliveriesService.list', () => {
  it('pages newest first and gives a cursor that continues after the last one', async () => {
    const { service, deliveries, seed } = setup()
    seed(delivery(1), delivery(2), delivery(3))

    const first = await service.list(WEBHOOK_ID, { limit: 2 })
    expect(first.items.map(item => item.seq)).toEqual([1, 2])
    expect(first.nextCursor).not.toBeNull()

    const second = await service.list(WEBHOOK_ID, {
      limit: 2,
      cursor: first.nextCursor ?? undefined
    })
    expect(second.items.map(item => item.seq)).toEqual([3])
    expect(second.nextCursor).toBeNull()
    expect(deliveries.listForWebhook).toHaveBeenCalledWith(
      WEBHOOK_ID,
      expect.objectContaining({ limit: 3 })
    )
  })

  it('filters by status', async () => {
    const { service, seed } = setup()
    seed(delivery(1), delivery(2, { status: 'success' }))

    const page = await service.list(WEBHOOK_ID, { limit: 10, status: 'failed' })

    expect(page.items.map(item => item.seq)).toEqual([1])
  })

  it('refuses a cursor that was not issued by the gateway', async () => {
    const { service } = setup()

    for (const cursor of [
      'not-base64-json',
      Buffer.from('{"createdAt":1}').toString('base64url')
    ]) {
      expect(await rejection(service.list(WEBHOOK_ID, { limit: 10, cursor }))).toBeInstanceOf(
        ValidationError
      )
    }
  })
})

describe('WebhookDeliveriesService.retry', () => {
  it('puts a dead letter back to pending and queues its stored event', async () => {
    const { service, queue, seed } = setup()
    seed(delivery(4))

    const dto = await service.retry(WEBHOOK_ID, uuid(4))

    expect(dto).toMatchObject({ id: uuid(4), status: 'pending', attempts: 3 })
    expect(queue.enqueue).toHaveBeenCalledWith({
      deliveryId: uuid(4),
      webhookId: WEBHOOK_ID,
      envelope: envelope(4)
    })
  })

  it('answers 404 for a delivery that does not exist or belongs to another webhook', async () => {
    const { service, deliveries, queue, seed } = setup()
    seed(delivery(4, { webhookId: OTHER_WEBHOOK_ID }))

    expect(await rejection(service.retry(WEBHOOK_ID, uuid(4)))).toBeInstanceOf(NotFoundError)
    expect(await rejection(service.retry(WEBHOOK_ID, uuid(5)))).toBeInstanceOf(NotFoundError)
    expect(deliveries.resetForRetry).not.toHaveBeenCalled()
    expect(queue.enqueue).not.toHaveBeenCalled()
  })

  it('never queues a delivery that is delivered or still pending', async () => {
    const { service, queue, seed } = setup()
    seed(delivery(1, { status: 'success' }), delivery(2, { status: 'pending' }))

    expect(await rejection(service.retry(WEBHOOK_ID, uuid(1)))).toBeInstanceOf(NotFoundError)
    expect(await rejection(service.retry(WEBHOOK_ID, uuid(2)))).toBeInstanceOf(NotFoundError)
    expect(queue.enqueue).not.toHaveBeenCalled()
  })

  // The stored copy of these two has the credential redacted (TDD §6.9): sending it would deliver
  // "[Redacted]" as if it were a QR, and both expire within a minute anyway
  it.each(['qr', 'code'])(
    'refuses to retry a %s delivery, which is stored redacted',
    async name => {
      const { service, deliveries, queue, store, seed } = setup()
      seed(delivery(4, { event: name, payload: { ...envelope(4), event: name } }))

      expect(await rejection(service.retry(WEBHOOK_ID, uuid(4)))).toBeInstanceOf(ValidationError)
      expect(deliveries.resetForRetry).not.toHaveBeenCalled()
      expect(queue.enqueue).not.toHaveBeenCalled()
      expect(store.get(uuid(4))?.status).toBe('failed')
    }
  )

  it('queues it once when two retries come at the same time', async () => {
    const { service, queue, seed } = setup()
    seed(delivery(4))

    const results = await Promise.allSettled([
      service.retry(WEBHOOK_ID, uuid(4)),
      service.retry(WEBHOOK_ID, uuid(4))
    ])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(queue.enqueue).toHaveBeenCalledTimes(1)
  })

  it('leaves a delivery whose stored event is unreadable as a dead letter', async () => {
    const { service, deliveries, store, seed } = setup()
    seed(delivery(4, { payload: 'not an event' }))

    expect(await rejection(service.retry(WEBHOOK_ID, uuid(4)))).toBeInstanceOf(InternalError)
    expect(deliveries.resetForRetry).not.toHaveBeenCalled()
    expect(store.get(uuid(4))?.status).toBe('failed')
  })

  it('sends it back to the dead letters when the queue fails', async () => {
    const { service, deliveries, queue, seed } = setup()
    seed(delivery(4))
    queue.enqueue.mockRejectedValueOnce(new Error('redis down'))

    await expect(service.retry(WEBHOOK_ID, uuid(4))).rejects.toThrow('redis down')

    expect(deliveries.failUnqueued).toHaveBeenCalledWith(uuid(4), expect.any(String))
  })
})

describe('WebhookDeliveriesService.retryFailed', () => {
  it('queues every dead letter of the webhook and only those', async () => {
    const { service, queue, seed } = setup()
    seed(
      delivery(1),
      delivery(2, { status: 'success' }),
      delivery(3),
      delivery(4, { webhookId: OTHER_WEBHOOK_ID })
    )

    expect(await service.retryFailed(WEBHOOK_ID)).toEqual({ retried: 2, more: false })
    expect(queue.enqueue.mock.calls.map(([job]) => job.deliveryId).sort()).toEqual([
      uuid(1),
      uuid(3)
    ])
  })

  it('leaves the dead letters of qr and code as they are', async () => {
    const { service, queue, store, seed } = setup()
    seed(
      delivery(1),
      delivery(2, { event: 'qr', payload: { ...envelope(2), event: 'qr' } }),
      delivery(3, { event: 'code', payload: { ...envelope(3), event: 'code' } })
    )

    expect(await service.retryFailed(WEBHOOK_ID)).toEqual({ retried: 1, more: false })
    expect(queue.enqueue.mock.calls.map(([job]) => job.deliveryId)).toEqual([uuid(1)])
    expect(store.get(uuid(2))?.status).toBe('failed')
    expect(store.get(uuid(3))?.status).toBe('failed')
  })

  it('answers zero for a webhook without dead letters', async () => {
    const { service, queue } = setup()

    expect(await service.retryFailed(WEBHOOK_ID)).toEqual({ retried: 0, more: false })
    expect(queue.enqueue).not.toHaveBeenCalled()
  })

  it('does not count a dead letter that another caller claimed first', async () => {
    const { service, deliveries, queue, seed } = setup()
    seed(delivery(1), delivery(2))
    deliveries.resetForRetry.mockResolvedValueOnce(null)

    expect(await service.retryFailed(WEBHOOK_ID)).toEqual({ retried: 1, more: false })
    expect(queue.enqueue).toHaveBeenCalledTimes(1)
  })

  it('stops at the limit of one call and says there are more', async () => {
    const { service, queue, seed } = setup()
    seed(...Array.from({ length: RETRY_FAILED_LIMIT + 3 }, (_, i) => delivery(i + 1)))

    expect(await service.retryFailed(WEBHOOK_ID)).toEqual({
      retried: RETRY_FAILED_LIMIT,
      more: true
    })
    expect(queue.enqueue).toHaveBeenCalledTimes(RETRY_FAILED_LIMIT)
  })

  it('does not say there are more when the limit is exactly the number of dead letters', async () => {
    const { service, seed } = setup()
    seed(...Array.from({ length: RETRY_FAILED_LIMIT }, (_, i) => delivery(i + 1)))

    expect(await service.retryFailed(WEBHOOK_ID)).toEqual({
      retried: RETRY_FAILED_LIMIT,
      more: false
    })
  })

  it('skips a dead letter whose stored event is unreadable and retries the rest', async () => {
    const { service, queue, store, seed } = setup()
    seed(delivery(1), delivery(2, { payload: 'not an event' }), delivery(3))

    expect(await service.retryFailed(WEBHOOK_ID)).toEqual({ retried: 2, more: false })
    expect(queue.enqueue).toHaveBeenCalledTimes(2)
    expect(store.get(uuid(2))?.status).toBe('failed')
  })

  it('stops on the first queue error, leaving the rest as dead letters', async () => {
    const { service, queue, store, seed } = setup()
    seed(delivery(1), delivery(2))
    queue.enqueue.mockRejectedValueOnce(new Error('redis down'))

    await expect(service.retryFailed(WEBHOOK_ID)).rejects.toThrow('redis down')

    expect(queue.enqueue).toHaveBeenCalledTimes(1)
    expect([...store.values()].filter(row => row.status === 'failed')).toHaveLength(1)
  })
})
