import { Logger } from '@nestjs/common'

import type { AppConfig } from '../config/env.schema.js'
import type { DeliveriesRepository } from '../database/repositories/deliveries.repository.js'
import type { IdempotencyRepository } from '../database/repositories/idempotency.repository.js'
import type { MetricsService } from '../infra/metrics/metrics.service.js'
import type { RedisService } from '../infra/redis/redis.service.js'

import type { DeliveryJobState, DeliveryQueueService } from './delivery-queue.service.js'
import type { MessageStoreService } from './message-store.service.js'
import { RetentionService } from './retention.service.js'

interface FakeQueue {
  name: string
  options: unknown
  upsertJobScheduler: jest.Mock<Promise<unknown>, [string, unknown, unknown]>
  close: jest.Mock
  on: jest.Mock
}
interface FakeWorker {
  name: string
  processor: (job: { name: string }) => Promise<unknown>
  options: unknown
  close: jest.Mock
  on: jest.Mock
}

const queues: FakeQueue[] = []
const workers: FakeWorker[] = []

jest.mock('bullmq', () => ({
  UnrecoverableError: class UnrecoverableError extends Error {},
  Queue: jest.fn((name: string, options: unknown) => {
    const queue = {
      name,
      options,
      upsertJobScheduler: jest.fn<Promise<unknown>, [string, unknown, unknown]>(() =>
        Promise.resolve({})
      ),
      close: jest.fn(() => Promise.resolve()),
      on: jest.fn()
    }
    queues.push(queue)
    return queue
  }),
  Worker: jest.fn(
    (name: string, processor: FakeWorker['processor'], options: unknown): FakeWorker => {
      const worker = {
        name,
        processor,
        options,
        close: jest.fn(() => Promise.resolve()),
        on: jest.fn()
      }
      workers.push(worker)
      return worker
    }
  )
}))

const NOW = new Date('2026-06-15T12:00:00.000Z')
const DAY = 24 * 3600 * 1000
const MINUTE = 60 * 1000

const key = (id: string, minutesAgo: number) => ({
  id,
  createdAt: new Date(NOW.getTime() - minutesAgo * MINUTE)
})

function setup(
  overrides: {
    stale?: ReturnType<typeof key>[][]
    states?: Record<string, DeliveryJobState>
  } = {}
) {
  queues.length = 0
  workers.length = 0
  const pages = [...(overrides.stale ?? [[]])]
  const deliveries = {
    deleteOlderThan: jest.fn(() => Promise.resolve(3)),
    listStalePending: jest.fn(() => Promise.resolve(pages.shift() ?? [])),
    failUnqueued: jest.fn(() => Promise.resolve(true))
  }
  const idempotency = { deleteOlderThan: jest.fn(() => Promise.resolve(5)) }
  const messages = { purgeExpired: jest.fn(() => Promise.resolve(7)) }
  const queue = {
    jobStates: jest.fn(() => Promise.resolve(new Map(Object.entries(overrides.states ?? {}))))
  }
  const client = {}
  const inc = jest.fn()
  const service = new RetentionService(
    { DELIVERY_RETENTION_DAYS: 14 } as AppConfig,
    { client } as unknown as RedisService,
    deliveries as unknown as DeliveriesRepository,
    idempotency as unknown as IdempotencyRepository,
    messages as unknown as MessageStoreService,
    queue as unknown as DeliveryQueueService,
    { metrics: { webhookDeliveries: { inc } } } as unknown as MetricsService
  )
  return { service, deliveries, idempotency, messages, queue, client, inc }
}

describe('RetentionService.purgeExpired', () => {
  it('deletes the deliveries after DELIVERY_RETENTION_DAYS, the messages by their own rule and the idempotency keys after 24 h', async () => {
    const { service, deliveries, idempotency, messages } = setup()

    const result = await service.purgeExpired(NOW)

    expect(deliveries.deleteOlderThan).toHaveBeenCalledWith(new Date(NOW.getTime() - 14 * DAY))
    expect(idempotency.deleteOlderThan).toHaveBeenCalledWith(new Date(NOW.getTime() - DAY))
    expect(messages.purgeExpired).toHaveBeenCalledWith(NOW)
    expect(result).toEqual({ deliveries: 3, messages: 7, idempotencyKeys: 5 })
  })

  it('still purges the rest when one purge fails, and then reports the failure', async () => {
    const { service, deliveries, idempotency, messages } = setup()
    deliveries.deleteOlderThan.mockRejectedValueOnce(new Error('database down'))

    await expect(service.purgeExpired(NOW)).rejects.toThrow('The purge of deliveries failed')

    expect(messages.purgeExpired).toHaveBeenCalled()
    expect(idempotency.deleteOlderThan).toHaveBeenCalled()
  })
})

describe('RetentionService.sweepPending', () => {
  it('looks at the rows older than 30 minutes and does not read the queue when there are none', async () => {
    const { service, deliveries, queue } = setup()

    const result = await service.sweepPending(NOW)

    expect(deliveries.listStalePending).toHaveBeenCalledWith(
      new Date(NOW.getTime() - 30 * MINUTE),
      500,
      undefined
    )
    expect(queue.jobStates).not.toHaveBeenCalled()
    expect(result).toEqual({ failed: 0, alive: 0 })
  })

  it('leaves alone a row whose job is still going to run', async () => {
    const { service, deliveries } = setup({
      stale: [[key('d1', 90)]],
      states: { d1: 'live' }
    })

    const result = await service.sweepPending(NOW)

    expect(deliveries.failUnqueued).not.toHaveBeenCalled()
    expect(result).toEqual({ failed: 0, alive: 1 })
  })

  // A crash between storing the row and queueing the job leaves exactly this: nothing will ever run it
  it('sends a row with no job to the dead letters, where retry can pick it up', async () => {
    const { service, deliveries } = setup({ stale: [[key('d1', 90)]] })

    const result = await service.sweepPending(NOW)

    expect(deliveries.failUnqueued).toHaveBeenCalledWith(
      'd1',
      expect.stringContaining('no job in the queue')
    )
    expect(result).toEqual({ failed: 1, alive: 0 })
  })

  // The receiver may have answered 2xx while the database was down: the row says pending, the event
  // is delivered. The sweep cannot know, so it says so instead of claiming either
  it('counts the rows it sends to the dead letters, so an operator can alert on them', async () => {
    const { service, inc } = setup({
      stale: [[key('a', 90), key('b', 80), key('c', 70)]],
      states: { c: 'live' }
    })

    await service.sweepPending(NOW)

    expect(inc).toHaveBeenCalledWith({ result: 'swept' }, 2)
  })

  // The processor can finish the delivery between the list and the update
  it('counts only the rows that really changed', async () => {
    const { service, deliveries, inc } = setup({ stale: [[key('a', 90), key('b', 80)]] })
    deliveries.failUnqueued.mockResolvedValueOnce(false)

    const result = await service.sweepPending(NOW)

    expect(result.failed).toBe(1)
    expect(inc).toHaveBeenCalledWith({ result: 'swept' }, 1)
  })

  it('counts nothing when it sweeps nothing', async () => {
    const { service, inc } = setup()

    await service.sweepPending(NOW)

    expect(inc).not.toHaveBeenCalled()
  })

  it('tells a finished job from a missing one, and says the receiver may have the event', async () => {
    const { service, deliveries } = setup({
      stale: [[key('done', 90), key('gone', 80), key('dead', 70)]],
      states: { done: 'completed', dead: 'failed' }
    })

    await service.sweepPending(NOW)

    const reasons = new Map(deliveries.failUnqueued.mock.calls as unknown as [string, string][])
    expect(reasons.get('done')).toMatch(/finished.*not recorded.*may already have/)
    expect(reasons.get('dead')).toMatch(/gave up.*not recorded/)
    expect(reasons.get('gone')).toMatch(/no job in the queue/)
    expect(new Set(reasons.values()).size).toBe(3)
  })

  it('works a backlog page by page from the key of the last row, reading the queue again for each page', async () => {
    const full = Array.from({ length: 500 }, (_, index) => key(`a${index}`, 100 + index))
    const last = key('z', 40)
    const { service, deliveries, queue } = setup({ stale: [full, [last]] })

    const result = await service.sweepPending(NOW)

    expect(deliveries.listStalePending).toHaveBeenCalledTimes(2)
    expect(deliveries.listStalePending).toHaveBeenLastCalledWith(
      new Date(NOW.getTime() - 30 * MINUTE),
      500,
      full[499]
    )
    expect(queue.jobStates).toHaveBeenCalledTimes(2)
    expect(result.failed).toBe(501)
  })

  it('stops after a bounded number of pages so one run never goes on for ever', async () => {
    const page = Array.from({ length: 500 }, (_, index) => key(`a${index}`, 100))
    const { service, deliveries } = setup({ stale: Array.from({ length: 30 }, () => page) })

    await service.sweepPending(NOW)

    expect(deliveries.listStalePending).toHaveBeenCalledTimes(20)
  })

  it('lets a failure of the database reach BullMQ, which keeps the run as failed', async () => {
    const { service, deliveries } = setup({ stale: [[key('d1', 90)]] })
    deliveries.failUnqueued.mockRejectedValueOnce(new Error('database down'))

    await expect(service.sweepPending(NOW)).rejects.toThrow('database down')
  })
})

describe('RetentionService scheduling', () => {
  it('registers the daily purge and the sweep on a queue of its own, idempotently', async () => {
    const { service, client } = setup()

    await service.onModuleInit()

    const [queue] = queues
    expect(queue?.name).toBe('retention')
    expect(queue?.options).toEqual({ connection: client })
    expect(queue?.upsertJobScheduler).toHaveBeenCalledWith(
      'purge',
      { pattern: '0 3 * * *' },
      expect.objectContaining({ name: 'purge' })
    )
    expect(queue?.upsertJobScheduler).toHaveBeenCalledWith(
      'sweep-pending',
      { every: 10 * MINUTE },
      expect.objectContaining({ name: 'sweep-pending' })
    )
  })

  it('keeps only a few finished runs, so the history cannot grow', async () => {
    const { service } = setup()

    await service.onModuleInit()

    const template = queues[0]?.upsertJobScheduler.mock.calls[0]?.[2] as {
      opts: { removeOnComplete: number; removeOnFail: number }
    }
    expect(template.opts.removeOnComplete).toBe(10)
    expect(template.opts.removeOnFail).toBe(50)
  })

  it('runs the job the worker is handed by its name', async () => {
    const { service, deliveries, messages } = setup()
    await service.onModuleInit()
    const [worker] = workers

    await worker?.processor({ name: 'purge' })
    await worker?.processor({ name: 'sweep-pending' })

    expect(messages.purgeExpired).toHaveBeenCalledTimes(1)
    expect(deliveries.listStalePending).toHaveBeenCalledTimes(1)
  })

  it('refuses a job it does not know instead of retrying it', async () => {
    const { service } = setup()
    await service.onModuleInit()

    await expect(workers[0]?.processor({ name: 'other' })).rejects.toThrow('Unknown retention job')
  })

  it('works one job at a time and listens to the errors of the connection', async () => {
    const { service, client } = setup()
    await service.onModuleInit()

    expect(workers[0]?.options).toMatchObject({ connection: client, concurrency: 1 })
    expect(workers[0]?.on).toHaveBeenCalledWith('error', expect.any(Function))
    expect(queues[0]?.on).toHaveBeenCalledWith('error', expect.any(Function))
  })

  it('logs a run that failed for good, so a retention that stopped working is seen', async () => {
    const { service } = setup()
    await service.onModuleInit()

    const failed = (workers[0]?.on.mock.calls as [string, unknown][] | undefined)?.find(
      call => call[0] === 'failed'
    )?.[1] as
      | ((
          job: { name: string; attemptsMade: number; opts: { attempts?: number } },
          error: Error
        ) => void)
      | undefined
    expect(failed).toBeDefined()
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    failed?.({ name: 'purge', attemptsMade: 3, opts: { attempts: 3 } }, new Error('database down'))
    failed?.({ name: 'purge', attemptsMade: 1, opts: { attempts: 3 } }, new Error('database down'))

    expect(logged).toHaveBeenCalledTimes(1)
    expect(String(logged.mock.calls[0]?.[0])).toContain('purge')
    logged.mockRestore()
  })

  it('closes the worker and then the queue before Redis closes', async () => {
    const { service } = setup()
    await service.onModuleInit()

    await service.onModuleDestroy()

    expect(workers[0]?.close).toHaveBeenCalled()
    expect(queues[0]?.close).toHaveBeenCalled()
  })

  it('closes cleanly when it never started', async () => {
    const { service } = setup()

    await expect(service.onModuleDestroy()).resolves.toBeUndefined()
  })
})
