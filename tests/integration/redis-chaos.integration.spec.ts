import { randomUUID } from 'node:crypto'

import { Logger } from '@nestjs/common'
import { Queue, Worker } from 'bullmq'

import { parseEnv } from '../../src/config/env.schema.js'
import { closeQueue, closeWorker } from '../../src/infra/redis/bullmq-close.js'
import type { RedisService } from '../../src/infra/redis/redis.service.js'
import { type ChaosGateway, bootGateway, gatewayEnv } from '../helpers/chaos-app.js'
import {
  type ChaosContainer,
  eventually,
  removeChaosContainers,
  startPostgres,
  startRedis
} from '../helpers/chaos.js'
import { TEST_ENV, setEnv } from '../helpers/env.js'

// Step 10.2: Redis restarts under the queues. The containers are the suite's own, so stopping Redis
// cannot touch another suite. Redis runs with AOF on, as in the compose files, and is stopped with
// SIGTERM (`docker stop`): a SIGKILL may lose the last second of writes by design of `everysec`.
describe('Redis restart under the queues (chaos)', () => {
  let redis: ChaosContainer
  let postgres: ChaosContainer
  let gateway: ChaosGateway | undefined

  const config = (extra: Record<string, string> = {}): ReturnType<typeof parseEnv> =>
    parseEnv({ ...TEST_ENV, REDIS_URL: redis.url, ...extra })

  // RedisService reaches the configuration module, which reads the environment when it first loads:
  // the variables go in before the first import of it, the same as in every integration suite
  let redisServiceClass: typeof RedisService
  let newRedisService: (extra?: Record<string, string>) => RedisService

  beforeAll(async () => {
    redis = await startRedis()
    postgres = await startPostgres()
    setEnv(
      gatewayEnv(
        { DATABASE_URL: postgres.url, REDIS_URL: redis.url },
        { SEND_ENQUEUE_TIMEOUT_MS: '1500' }
      )
    )
    const { RedisService } = await import('../../src/infra/redis/redis.service.js')
    redisServiceClass = RedisService
    newRedisService = extra => new RedisService(config(extra))
  }, 120_000)

  afterAll(async () => {
    await gateway?.close().catch(() => undefined)
    await removeChaosContainers()
  }, 60_000)

  // A test that failed between a stop and its start must not take the next ones down with it
  afterEach(async () => {
    await redis.ensureRunning()
  }, 60_000)

  describe('a BullMQ queue', () => {
    let service: RedisService
    let queue: Queue
    let worker: Worker | undefined
    const processed: string[] = []

    const startWorker = (): Worker =>
      new Worker(
        queue.name,
        job => {
          processed.push(job.id ?? '')
          return Promise.resolve()
        },
        { connection: service.client, concurrency: 4 }
      )

    beforeEach(() => {
      processed.length = 0
      service = newRedisService()
      queue = new Queue(`chaos-${randomUUID()}`, { connection: service.client })
    })

    afterEach(async () => {
      if (worker !== undefined) await closeWorker(worker, service.client, 5000, 'chaos worker')
      worker = undefined
      await closeQueue(queue, service.client, 'chaos queue')
      await service.onApplicationShutdown()
    })

    it('loses nothing that was waiting and runs each job once after the restart', async () => {
      const ids = Array.from({ length: 25 }, (_, n) => `waiting-${n}`)
      for (const id of ids) await queue.add('job', {}, { jobId: id })

      await redis.restart()
      worker = startWorker()

      await eventually(() => processed.length >= ids.length, { what: 'every job to run' })
      expect([...processed].sort()).toEqual([...ids].sort())
      expect(await queue.getWaitingCount()).toBe(0)
    })

    it('lands an add made while Redis is down, once, when it comes back', async () => {
      await redis.stop()
      await eventually(() => service.client.status !== 'ready', { what: 'the client to notice' })
      // maxRetriesPerRequest: null makes the command wait in the offline queue for the reconnection
      const adding = queue.add('job', {}, { jobId: 'during-outage' })
      await redis.start()
      await adding
      // The same add again, as a retry of an unknown outcome would do: the job id dedupes it
      await queue.add('job', {}, { jobId: 'during-outage' })
      worker = startWorker()

      await eventually(() => processed.length >= 1, { what: 'the job to run' })
      expect(await queue.getJobCounts('waiting', 'active', 'delayed')).toEqual({
        waiting: 0,
        active: 0,
        delayed: 0
      })
      expect(processed).toEqual(['during-outage'])
    })

    it('keeps a running worker working through the restart', async () => {
      worker = startWorker()
      await queue.add('job', {}, { jobId: 'before' })
      await eventually(() => processed.includes('before'), { what: 'the first job to run' })

      await redis.restart()
      await queue.add('job', {}, { jobId: 'after' })

      await eventually(() => processed.includes('after'), { what: 'the job after the restart' })
      expect(processed).toEqual(['before', 'after'])
    })
  })

  describe('the connection of the gateway', () => {
    it('fails the start with a clear message when Redis is down (REDIS_CONNECT_TIMEOUT_MS)', async () => {
      await redis.stop()
      const service = newRedisService({ REDIS_CONNECT_TIMEOUT_MS: '500' })
      try {
        await expect(service.onModuleInit()).rejects.toThrow(
          /Redis is not reachable at 127\.0\.0\.1:\d+ after 500 ms/
        )
      } finally {
        await service.onApplicationShutdown()
        await redis.start()
      }
    })

    it('shuts down within its bounds while Redis is down', async () => {
      const service = newRedisService()
      await service.onModuleInit()
      const queue = new Queue(`chaos-${randomUUID()}`, { connection: service.client })
      const worker = new Worker(queue.name, () => Promise.resolve(), {
        connection: service.createConnection()
      })
      await Promise.all([queue.waitUntilReady(), worker.waitUntilReady()])
      await redis.stop()
      const startedAt = Date.now()
      try {
        await closeWorker(worker, service.client, 3000, 'chaos worker')
        await closeQueue(queue, service.client, 'chaos queue')
        await service.onApplicationShutdown()

        // Two close bounds and the quit bound of the connections; the exact sum is not the point,
        // that it ends is (before F5 the process waited 30 s for the hard exit)
        expect(Date.now() - startedAt).toBeLessThan(15_000)
      } finally {
        await redis.start()
      }
    }, 40_000)

    it('logs one error per connection for an outage, not one per retry', async () => {
      const service = newRedisService()
      await service.onModuleInit()
      const extra = service.createConnection()
      const retries = { client: 0, extra: 0 }
      service.client.on('error', () => retries.client++)
      extra.on('error', () => retries.extra++)
      const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
      const info = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
      try {
        await redis.stop()
        await eventually(() => retries.client >= 3 && retries.extra >= 3, {
          what: 'three failed retries on each connection'
        })

        const lines = errors.mock.calls.filter(([message]) =>
          /Redis connection error/.test(String(message))
        )
        expect(lines).toHaveLength(2)

        await redis.start()
        await eventually(() => service.client.status === 'ready' && extra.status === 'ready')
        expect(
          info.mock.calls.filter(([message]) => message === 'Redis connection restored')
        ).toHaveLength(2)
      } finally {
        errors.mockRestore()
        info.mockRestore()
        await service.onApplicationShutdown()
      }
    }, 60_000)
  })

  describe('the whole gateway', () => {
    beforeAll(async () => {
      gateway = await bootGateway(
        { DATABASE_URL: postgres.url, REDIS_URL: redis.url },
        { SEND_ENQUEUE_TIMEOUT_MS: '1500' }
      )
    }, 60_000)

    beforeEach(async () => {
      await eventually(async () => (await statusOf('/ready')) === 200, {
        what: '/ready before the test'
      })
    }, 60_000)

    const running = (): ChaosGateway => {
      if (gateway === undefined) throw new Error('the gateway did not boot')
      return gateway
    }
    const statusOf = async (path: string): Promise<number> =>
      (await running().call('GET', path, undefined, {})).statusCode
    const sentTimes = (body: string): number =>
      running()
        .client()
        .callsOf('sendMessage')
        .filter(sent => JSON.stringify(sent.args).includes(body)).length

    // Repeats a keyed send until the gateway accepts it, the way the docs tell a client to
    const sendUntilAccepted = async (body: string, key: string): Promise<void> => {
      let last: Awaited<ReturnType<ChaosGateway['send']>> | undefined
      try {
        await eventually(
          async () => {
            last = await running().send(body, key)
            return last.statusCode === 201
          },
          { what: `the key of ${body} to be accepted` }
        )
      } catch (error) {
        throw new Error(`${String(error)}; last answer: ${last?.statusCode} ${last?.body}`, {
          cause: error
        })
      }
    }

    it('answers /ready 503 and /health 200 while Redis is down, and recovers by itself', async () => {
      expect(await statusOf('/ready')).toBe(200)

      await redis.stop()
      await eventually(async () => (await statusOf('/ready')) === 503, {
        what: '/ready to turn 503'
      })
      expect(await statusOf('/health')).toBe(200)

      await redis.start()
      await eventually(async () => (await statusOf('/ready')) === 200, {
        what: '/ready to turn 200 again'
      })
    }, 60_000)

    it('refuses a send while Redis is down and accepts the same key once it is back', async () => {
      const key = `down-${randomUUID()}`
      await redis.stop()
      let refused: Awaited<ReturnType<ChaosGateway['send']>> | undefined
      try {
        refused = await running().send('during-outage', key)
      } finally {
        await redis.start()
      }

      expect(refused.statusCode).toBe(503)
      expect(refused.json()).toMatchObject({ error: { code: 'QUEUE_UNAVAILABLE' } })
      const sentBefore = sentTimes('during-outage')

      await sendUntilAccepted('during-outage', key)
      expect(sentTimes('during-outage')).toBe(sentBefore + 1)
    }, 60_000)

    it('never sends twice a keyed message whose add was in flight when Redis stopped answering', async () => {
      const messages = Array.from({ length: 6 }, (_, n) => ({
        body: `in-flight-${n}-${randomUUID()}`,
        key: `key-${randomUUID()}`
      }))

      // A frozen Redis keeps its sockets open and answers nothing, so every command already written to
      // it is in flight, and runs when it thaws. A stop would race the sends; this does not.
      const redisService = running().app.get(redisServiceClass)
      await redis.pause()
      let answers: Promise<Awaited<ReturnType<ChaosGateway['send']>>>[]
      try {
        answers = messages.map(({ body, key }) => running().send(body, key))
        await eventually(() => redisService.client.commandQueue.length >= messages.length, {
          what: 'the sends to reach Redis'
        })
      } finally {
        await redis.unpause()
      }
      await Promise.all(answers)

      // The client repeats each key until the gateway accepts it, as the docs tell it to
      for (const { body, key } of messages) await sendUntilAccepted(body, key)
      for (const { body } of messages) expect(sentTimes(body)).toBe(1)
    }, 120_000)

    it('answers a repeated key with the first result after the restart', async () => {
      const key = `replay-${randomUUID()}`
      const first = await running().send('replayed', key)
      expect(first.statusCode).toBe(201)

      await redis.restart()
      await eventually(async () => (await statusOf('/ready')) === 200)
      const second = await running().send('replayed', key)

      expect(second.statusCode).toBe(201)
      expect(second.json<{ message: { id: string } }>().message.id).toBe(
        first.json<{ message: { id: string } }>().message.id
      )
      expect(sentTimes('replayed')).toBe(1)
    }, 60_000)
  })
})
