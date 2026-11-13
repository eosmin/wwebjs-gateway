import { randomUUID } from 'node:crypto'

import { Queue, Worker } from 'bullmq'

import { parseEnv } from '../../src/config/env.schema.js'
import { closeWorker } from '../../src/infra/redis/bullmq-close.js'
import { RedisService } from '../../src/infra/redis/redis.service.js'
import { REAL_ENV, TEST_ENV } from '../helpers/env.js'

const redisUrl = REAL_ENV.REDIS_URL
if (redisUrl === undefined) throw new Error('REDIS_URL is required by the integration suites')

// The real BullMQ: the unit spec only has a stand-in for how `close` behaves. A stuck job is not run
// here: a forced close leaves the blocking connection of the worker open until the process ends, which
// would keep Jest from exiting (the forced path is covered by the unit spec's stand-in of BullMQ).
describe('closeWorker with a real worker (integration)', () => {
  let redis: RedisService
  let queue: Queue

  beforeEach(() => {
    redis = new RedisService(parseEnv({ ...TEST_ENV, REDIS_URL: redisUrl }))
    queue = new Queue(`close-${randomUUID()}`, { connection: redis.client })
  })

  afterEach(async () => {
    await queue.obliterate({ force: true })
    await queue.close()
    await redis.onApplicationShutdown()
  })

  it('lets the job in hand finish and be recorded before the worker closes', async () => {
    let running: (() => void) | undefined
    const started = new Promise<void>(resolve => (running = resolve))
    const worker = new Worker(
      queue.name,
      async () => {
        running?.()
        await new Promise(resolve => setTimeout(resolve, 300))
        return 'done'
      },
      { connection: redis.client, concurrency: 1 }
    )
    const job = await queue.add('x', {})
    await started

    await closeWorker(worker, redis.client, 5000, 'test worker')

    expect(await job.isCompleted()).toBe(true)
    expect((await queue.getJob(job.id ?? ''))?.returnvalue).toBe('done')
  })
})
