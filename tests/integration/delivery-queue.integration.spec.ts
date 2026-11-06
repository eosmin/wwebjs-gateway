import { randomUUID } from 'node:crypto'

import { Queue, Worker } from 'bullmq'
import { Redis } from 'ioredis'

import type { AppConfig } from '../../src/config/env.schema.js'
import type { RedisService } from '../../src/infra/redis/redis.service.js'
import {
  DELIVERY_QUEUE_NAME,
  type DeliveryJobData,
  DeliveryQueueService
} from '../../src/services/delivery-queue.service.js'
import { REAL_ENV } from '../helpers/env.js'

const BIG = 2 * 1024 * 1024

// `DeliveryQueueService.jobStates` over a real Redis and real BullMQ jobs: the state of each delivery
// comes from the job ids and the result they kept, and no job is loaded, because the data of one
// can carry a file of several MB.
describe('DeliveryQueueService.jobStates (integration)', () => {
  let redis: Redis | undefined
  let monitor: Redis | undefined
  let queue: Queue | undefined
  let service: DeliveryQueueService | undefined
  const suffix = randomUUID().slice(0, 8)
  const ids: string[] = []

  const get = <T>(value: T | undefined): T => {
    if (value === undefined) throw new Error('the suite did not start')
    return value
  }
  const newId = (): string => {
    const id = `${suffix}-${randomUUID()}`
    ids.push(id)
    return id
  }
  const job = (deliveryId: string, data = ''): DeliveryJobData => ({
    deliveryId,
    webhookId: randomUUID(),
    envelope: {
      id: `evt_${deliveryId}`,
      event: 'message',
      sessionId: 'main',
      seq: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      data: { body: data }
    }
  })
  const until = async <T>(read: () => Promise<T | undefined>, what: string): Promise<T> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const value = await read()
      if (value !== undefined) return value
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`timed out waiting for ${what}`)
  }

  beforeAll(async () => {
    const { REDIS_URL } = REAL_ENV
    if (REDIS_URL === undefined) throw new Error('REDIS_URL is required by the integration suites')
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null })
    monitor = new Redis(REDIS_URL)
    queue = new Queue(DELIVERY_QUEUE_NAME, { connection: redis })
    service = new DeliveryQueueService(
      { WEBHOOK_MAX_ATTEMPTS: 1, WEBHOOK_BACKOFF_MS: 10 } as AppConfig,
      { client: redis } as unknown as RedisService
    )
    // Nothing runs the jobs but this suite
    await queue.pause()
  })

  afterAll(async () => {
    try {
      for (const id of ids) {
        for (const job of await get(queue).getJobs(
          ['active', 'waiting', 'delayed', 'completed', 'failed'],
          0,
          -1
        )) {
          if (job.id?.startsWith(`${id}_`) === true) await job.remove().catch(() => undefined)
        }
      }
      await get(queue).resume()
    } finally {
      await service?.onModuleDestroy()
      await queue?.close()
      monitor?.disconnect()
      await redis?.quit()
    }
  })

  it('tells a live job from one that delivered, one that was dropped and one that gave up', async () => {
    const waiting = newId()
    const delivered = newId()
    const dropped = newId()
    const exhausted = newId()
    const payloads = new Map([
      [delivered, 'delivered'],
      [dropped, 'dropped']
    ])
    const worker = new Worker(
      DELIVERY_QUEUE_NAME,
      ({ data }: { data: DeliveryJobData }) => {
        const outcome = payloads.get(data.deliveryId)
        return outcome === undefined
          ? Promise.reject(new Error('gave up'))
          : Promise.resolve(outcome)
      },
      { connection: get(redis), autorun: false }
    )
    try {
      await get(service).enqueue(job(waiting))
      await get(queue).resume()
      // Only the jobs of the other three are for this worker: the queue is the shared one, so wait
      // for them before reading, and pause again so the live one stays live
      await get(queue).pause()
      for (const id of [delivered, dropped, exhausted]) await get(service).enqueue(job(id))
      await get(queue).resume()
      void worker.run()
      await until(async () => {
        const states = await get(service).jobStates()
        return states.get(exhausted) === 'failed' &&
          states.get(delivered) === 'delivered' &&
          states.get(dropped) === 'completed'
          ? true
          : undefined
      }, 'the three jobs to finish')
      await worker.close()
      await get(queue).pause()
    } finally {
      await worker.close(true)
    }

    const states = await get(service).jobStates()

    expect(states.get(delivered)).toBe('delivered')
    expect(states.get(dropped)).toBe('completed')
    expect(states.get(exhausted)).toBe('failed')
    // The first job was queued while the queue was paused, then the worker took it as well: it is known
    expect(states.has(waiting)).toBe(true)
  })

  it('names the delivery of a job it queued, and keeps a retry apart from the job it follows', async () => {
    const id = newId()

    await get(service).enqueue(job(id))
    await get(service).enqueue(job(id))

    const found = (await get(queue).getJobs(['waiting'], 0, -1)).filter(
      queued => queued.id?.startsWith(`${id}_`) === true
    )
    expect(found).toHaveLength(2)
    expect(new Set(found.map(queued => queued.id)).size).toBe(2)
    expect((await get(service).jobStates()).get(id)).toBe('live')
  })

  // The reason to read ids: the commands that read a hash would carry the file of every job
  it('does not read the data of a job, however big it is', async () => {
    const id = newId()
    await get(service).enqueue(job(id, 'x'.repeat(BIG)))
    const seen: string[] = []
    const watcher = get(monitor)
    const stream = await watcher.monitor()
    stream.on('monitor', (_time: string, args: string[]) => {
      seen.push(args.join(' ').slice(0, 200))
    })
    try {
      await get(service).jobStates()
      // Give the stream a moment to deliver what Redis ran
      await new Promise(resolve => setTimeout(resolve, 300))
    } finally {
      stream.disconnect()
    }

    expect(seen.length).toBeGreaterThan(0)
    const commands = seen.map(line => line.split(' ')[0]?.toLowerCase() ?? '')
    expect(commands).not.toContain('hgetall')
    expect(commands).not.toContain('hmget')
    // Of a hash it reads at most the result field of a finished job
    for (const line of seen.filter(entry => /^hget /i.test(entry))) {
      expect(line).toMatch(/ returnvalue$/)
    }
    expect((await get(service).jobStates()).get(id)).toBe('live')
  })

  it('leaves out a job queued before the id named the delivery', async () => {
    const legacyDelivery = newId()
    const legacy = await get(queue).add('deliver', job(legacyDelivery), {
      removeOnComplete: true
    })

    const states = await get(service).jobStates()

    expect(legacy.id).toMatch(/^\d+$/)
    expect([...states.keys()]).not.toContain(legacyDelivery)
    await legacy.remove()
  })

  it('keeps a failed job of an inline webhook for an hour, and the others for a day', async () => {
    const inline = newId()
    const reference = newId()
    await get(service).enqueue(job(inline), { inlineMedia: true })
    await get(service).enqueue(job(reference), { inlineMedia: false })

    const kept = async (id: string): Promise<unknown> => {
      const found = (await get(queue).getJobs(['waiting'], 0, -1)).find(
        queued => queued.id?.startsWith(`${id}_`) === true
      )
      return found?.opts.removeOnFail
    }

    expect(await kept(inline)).toEqual({ age: 3600 })
    expect(await kept(reference)).toEqual({ age: 86400 })
  })
})
