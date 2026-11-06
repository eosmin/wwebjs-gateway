import type { AppConfig } from '../config/env.schema.js'
import type { RedisService } from '../infra/redis/redis.service.js'

import { DeliveryQueueService } from './delivery-queue.service.js'

// The reads the service made of a job hash: [key, field]
const hgets: [string, string][] = []
// What the hash of a job says in `returnvalue`, by job key
const returnvalues = new Map<string, string | Error>()

const queues: {
  name: string
  options: unknown
  add: jest.Mock<Promise<void>, [string, unknown, unknown]>
  getJobs: jest.Mock<Promise<{ data: unknown }[]>, [string[], number, number]>
  getRanges: jest.Mock<Promise<string[]>, [string[], number, number]>
  toKey: (id: string) => string
  getBackend: () => {
    client: Promise<{ hget: (key: string, field: string) => Promise<string | null> }>
  }
  close: jest.Mock
  on: jest.Mock
}[] = []

jest.mock('bullmq', () => ({
  Queue: jest.fn((name: string, options: unknown) => {
    const queue = {
      name,
      options,
      add: jest.fn<Promise<void>, [string, unknown, unknown]>(() => Promise.resolve()),
      getJobs: jest.fn<Promise<{ data: unknown }[]>, [string[], number, number]>(() =>
        Promise.resolve([])
      ),
      getRanges: jest.fn<Promise<string[]>, [string[], number, number]>(() => Promise.resolve([])),
      toKey: (id: string) => `bull:${name}:${id}`,
      getBackend: () => ({
        client: Promise.resolve({
          hget: (key: string, field: string) => {
            hgets.push([key, field])
            const value = returnvalues.get(key)
            return value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? null)
          }
        })
      }),
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
  hgets.length = 0
  returnvalues.clear()
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
      jobId: expect.stringMatching(/^d1_/) as string,
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

  // The id of the job starts with the id of the delivery, so the sweep can tell whose job it is from
  // the id alone, without loading the job (its data can carry a file). Each enqueue still gets an id of
  // its own, so a retry is never taken for a duplicate of the failed job it follows.
  it('names each job after its delivery, with a part that is new every time', async () => {
    const { service } = setup()

    await service.enqueue(JOB)
    await service.enqueue(JOB)

    const [first, second] = opened().add.mock.calls.map(
      call => (call[2] as { jobId: string }).jobId
    )
    expect(first).toMatch(/^d1_[0-9a-f-]{36}$/)
    expect(second).toMatch(/^d1_[0-9a-f-]{36}$/)
    expect(first).not.toBe(second)
  })

  // The id of the job is split at the first '_' to find the delivery: an id with one would be misread
  it.each(['a_b', 'a:b', ''])(
    'refuses a delivery id that cannot be told from a job id: %j',
    async id => {
      const { service } = setup()

      await expect(service.enqueue({ ...JOB, deliveryId: id })).rejects.toThrow('delivery id')
      expect(queues).toHaveLength(0)
    }
  )

  // A job of a webhook that takes the media inline carries the file in base64 (up to 5 MB)
  it('keeps a failed job of an inline webhook for an hour, not a day', async () => {
    const { service } = setup()

    await service.enqueue(JOB, { inlineMedia: true })
    await service.enqueue(JOB, { inlineMedia: false })
    await service.enqueue(JOB)

    const options = opened().add.mock.calls.map(call => call[2] as Record<string, unknown>)
    expect(options[0]).toMatchObject({
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 3600 }
    })
    expect(options[1]).toMatchObject({ removeOnFail: { age: 86400 } })
    expect(options[2]).toMatchObject({ removeOnFail: { age: 86400 } })
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

  describe('jobStates', () => {
    // The id of a job as the service names it
    const id = (deliveryId: string, n = 1) =>
      `${deliveryId}_00000000-0000-0000-0000-00000000000${n}`
    const live = 'active,waiting,delayed,prioritized,waiting-children'
    // What the queue answers for each group of states, page by page
    const answer = (pages: Record<string, string[][]>) => {
      opened().getRanges.mockImplementation((types, start) => {
        const page = Math.floor(start / 500)
        return Promise.resolve(pages[types.join(',')]?.[page] ?? [])
      })
    }
    const returned = (jobId: string, value: unknown) =>
      returnvalues.set(`bull:webhook-deliveries:${jobId}`, JSON.stringify(value))

    it('says for each delivery whether a job of it is alive, finished or exhausted', async () => {
      const { service } = setup()
      await service.enqueue(JOB)
      answer({
        [live]: [[id('a'), id('b')]],
        completed: [[id('c')]],
        failed: [[id('d')]]
      })

      const states = await service.jobStates()

      expect([...states]).toEqual([
        ['a', 'live'],
        ['b', 'live'],
        ['c', 'completed'],
        ['d', 'failed']
      ])
    })

    // The point of reading ids: a job can carry a file of several MB in its data
    it('never loads a job: it reads ids, and of a finished job only what it returned', async () => {
      const { service } = setup()
      await service.enqueue(JOB)
      answer({ [live]: [[id('a')]], completed: [[id('c'), id('e')]], failed: [[id('d')]] })

      await service.jobStates()

      expect(opened().getJobs).not.toHaveBeenCalled()
      expect(hgets).toEqual([
        [`bull:webhook-deliveries:${id('c')}`, 'returnvalue'],
        [`bull:webhook-deliveries:${id('e')}`, 'returnvalue']
      ])
    })

    // What the processor returns is the only record of a 2xx whose row could not be written
    it('tells a finished job that delivered from one that was dropped or says nothing', async () => {
      const { service } = setup()
      await service.enqueue(JOB)
      answer({ completed: [[id('sent'), id('dropped'), id('none'), id('odd'), id('text')]] })
      returned(id('sent'), 'delivered')
      returned(id('dropped'), 'dropped')
      returned(id('odd'), { url: 'https://secret.example/token' })
      returned(id('text'), 'something else')

      const states = await service.jobStates()

      expect(states.get('sent')).toBe('delivered')
      expect(states.get('dropped')).toBe('completed')
      expect(states.get('none')).toBe('completed')
      expect(states.get('odd')).toBe('completed')
      expect(states.get('text')).toBe('completed')
    })

    it('reads a result that is not JSON as nothing said', async () => {
      const { service } = setup()
      await service.enqueue(JOB)
      answer({ completed: [[id('bad')]] })
      returnvalues.set(`bull:webhook-deliveries:${id('bad')}`, '{not json')

      expect((await service.jobStates()).get('bad')).toBe('completed')
    })

    // Reading it as "said nothing" would send a delivered row to the dead letters
    it('lets a failed read of a result reach the caller instead of guessing', async () => {
      const { service } = setup()
      await service.enqueue(JOB)
      answer({ completed: [[id('err')]] })
      returnvalues.set(`bull:webhook-deliveries:${id('err')}`, new Error('boom'))

      await expect(service.jobStates()).rejects.toThrow('boom')
    })

    it('lets a job that delivered outrank a finished one that was dropped, in any order', async () => {
      const { service } = setup()
      await service.enqueue(JOB)
      answer({
        completed: [[id('a', 1), id('a', 2), id('b', 1), id('b', 2)]],
        failed: [[id('a', 3), id('b', 3)]]
      })
      returned(id('a', 1), 'dropped')
      returned(id('a', 2), 'delivered')
      returned(id('b', 1), 'delivered')
      returned(id('b', 2), 'dropped')

      const states = await service.jobStates()

      expect(states.get('a')).toBe('delivered')
      expect(states.get('b')).toBe('delivered')
    })

    // A manual retry queues a new job while the failed one it follows is still kept
    it('lets a live job outrank the finished ones of the same delivery', async () => {
      const { service } = setup()
      await service.enqueue(JOB)
      answer({
        [live]: [[id('a')]],
        completed: [[id('a', 2), id('b')]],
        failed: [[id('a', 3), id('b', 2)]]
      })
      returned(id('a', 2), 'delivered')

      const states = await service.jobStates()

      expect(states.get('a')).toBe('live')
      expect(states.get('b')).toBe('completed')
    })

    it('reads every page of a long queue', async () => {
      const { service } = setup()
      await service.enqueue(JOB)
      const full = Array.from({ length: 500 }, (_, index) => id(`p${index}`))
      answer({ completed: [full, [id('last')]] })

      const states = await service.jobStates()

      expect(states.size).toBe(501)
      expect(states.get('last')).toBe('completed')
    })

    // Jobs queued before the id carried the delivery (an integer id from BullMQ) are not known to the
    // sweep: they count as no job, which is what it does with a delivery whose job is gone
    it('leaves out a job whose id does not name a delivery', async () => {
      const { service } = setup()
      await service.enqueue(JOB)
      answer({ completed: [['17', '_x', id('ok')]] })

      expect([...(await service.jobStates()).keys()]).toEqual(['ok'])
    })

    it('lets the error of Redis reach the caller', async () => {
      const { service } = setup()
      await service.enqueue(JOB)
      opened().getRanges.mockRejectedValueOnce(new Error('redis down'))

      await expect(service.jobStates()).rejects.toThrow('redis down')
    })
  })

  it('closes the queue when the module is destroyed', async () => {
    const { service } = setup()
    await service.enqueue(JOB)

    await service.onModuleDestroy()

    expect(opened().close).toHaveBeenCalledTimes(1)
  })
})
