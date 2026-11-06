import type { AppConfig } from '../config/env.schema.js'
import type { RedisService } from '../infra/redis/redis.service.js'

import { DeliveryQueueService } from './delivery-queue.service.js'

const queues: {
  name: string
  options: unknown
  add: jest.Mock<Promise<void>, [string, unknown, unknown]>
  close: jest.Mock
  on: jest.Mock
}[] = []

jest.mock('bullmq', () => ({
  Queue: jest.fn((name: string, options: unknown) => {
    const queue = {
      name,
      options,
      add: jest.fn<Promise<void>, [string, unknown, unknown]>(() => Promise.resolve()),
      close: jest.fn(() => Promise.resolve()),
      on: jest.fn()
    }
    queues.push(queue)
    return queue
  })
}))

const ENVELOPE = {
  id: 'evt_1',
  event: 'ping',
  sessionId: 'main',
  seq: 1,
  timestamp: '2026-01-01T00:00:00.000Z',
  data: {}
}

const JOB = { deliveryId: 'd1', webhookId: 'w1', envelope: ENVELOPE }

function setup() {
  queues.length = 0
  const client = {}
  const service = new DeliveryQueueService(
    { WEBHOOK_MAX_ATTEMPTS: 7, WEBHOOK_BACKOFF_MS: 1500 } as AppConfig,
    { client } as unknown as RedisService
  )
  return { service, client }
}

// The queue the service opened, once it has used it
const opened = (): (typeof queues)[number] => {
  const [queue] = queues
  if (queue === undefined) throw new Error('the service did not open a queue')
  return queue
}

describe('DeliveryQueueService', () => {
  it('opens no queue until it is used, so building the module needs no Redis', async () => {
    const { service } = setup()

    await service.onModuleDestroy()

    expect(queues).toHaveLength(0)
  })

  it('opens the queue of the deliveries on the shared Redis connection, once', async () => {
    const { service, client } = setup()

    await service.enqueue(JOB)
    await service.enqueue({ ...JOB, deliveryId: 'd2' })

    expect(queues).toHaveLength(1)
    expect(opened().name).toBe('webhook-deliveries')
    expect(opened().options).toEqual({ connection: client })
  })

  it('queues a deliver job with the retry policy of the configuration (TDD 6.9)', async () => {
    const { service } = setup()

    await service.enqueue(JOB)

    expect(opened().add).toHaveBeenCalledWith('deliver', JOB, {
      attempts: 7,
      backoff: { type: 'exponential', delay: 1500 },
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86400 }
    })
  })

  // The job carries the live QR or pairing code, which is good for about a minute; a day in Redis
  // (and on the Bull Board) is not
  it.each(['qr', 'code'])('keeps the finished jobs of a %s for minutes, not hours', async name => {
    const { service } = setup()

    await service.enqueue({ ...JOB, envelope: { ...ENVELOPE, event: name } })

    expect(opened().add).toHaveBeenCalledWith(
      'deliver',
      expect.anything(),
      expect.objectContaining({ removeOnComplete: { age: 300 }, removeOnFail: { age: 300 } })
    )
  })

  it('gives no job id, so a retry is never taken for a duplicate of the failed job it follows', async () => {
    const { service } = setup()

    await service.enqueue(JOB)

    expect(opened().add.mock.calls[0]?.[2]).not.toHaveProperty('jobId')
  })

  it('lets the error of Redis reach the caller', async () => {
    const { service } = setup()
    await service.enqueue(JOB)
    opened().add.mockRejectedValueOnce(new Error('redis down'))

    await expect(service.enqueue(JOB)).rejects.toThrow('redis down')
  })

  it('listens to the errors of the queue, which would otherwise crash the process', async () => {
    const { service } = setup()
    await service.enqueue(JOB)

    expect(opened().on).toHaveBeenCalledWith('error', expect.any(Function))
  })

  it('hands the queue to the dashboard, opening it once', () => {
    const { service } = setup()
    const listener = jest.fn()

    service.watchQueues(listener)
    service.watchQueues(listener)

    expect(queues).toHaveLength(1)
    expect(listener).toHaveBeenNthCalledWith(1, [opened()])
    expect(listener).toHaveBeenNthCalledWith(2, [opened()])
  })

  it('closes the queue when the module is destroyed', async () => {
    const { service } = setup()
    await service.enqueue(JOB)

    await service.onModuleDestroy()

    expect(opened().close).toHaveBeenCalledTimes(1)
  })
})
