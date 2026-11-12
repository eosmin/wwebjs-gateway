import { randomUUID } from 'node:crypto'

import { Logger } from '@nestjs/common'
import { Job, Queue } from 'bullmq'

import { REAL_ENV, TEST_ENV } from '../../tests/helpers/env.js'
import { buildMessageDto, FakeWhatsAppClient } from '../../tests/helpers/fake-whatsapp-client.js'
import { ConflictError, NotFoundError, ServiceBusyError } from '../common/errors.js'
import { parseEnv } from '../config/env.schema.js'
import type { IdempotencyRepository } from '../database/repositories/idempotency.repository.js'
import type { SessionsRepository } from '../database/repositories/sessions.repository.js'
import { MetricsService } from '../infra/metrics/metrics.service.js'
import { RedisService } from '../infra/redis/redis.service.js'
import type { PolicyDecision, PolicyRule } from '../types/send-policy.dto.js'
import type { EventPipelineService } from '../whatsapp/event-pipeline.service.js'
import type { SessionManager } from '../whatsapp/session-manager.service.js'
import { WaOperationError } from '../whatsapp/wa-errors.js'
import type { WatchdogService } from '../whatsapp/watchdog.service.js'

import type { SendPolicyService } from './send-policy.service.js'
import type { NewSendJob, SendJobData } from './send-queue.job.js'
import { SendQueueService, sendQueueName } from './send-queue.service.js'

const redisUrl = REAL_ENV.REDIS_URL
if (redisUrl === undefined) throw new Error('REDIS_URL is required by the integration suites')

const CHAT = '5215500000002@c.us'
const ALLOW: PolicyDecision = { decision: 'allow' }

const until = async (
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

interface Published {
  sessionId: string
  event: string
  data: Record<string, unknown>
}

describe('send queue (integration)', () => {
  const sessionId = `queue-${randomUUID().slice(0, 8)}`
  let client: FakeWhatsAppClient
  let ready: boolean
  let exists: boolean
  // What `whenLoaded` of the fake SessionManager returns: the boot has read the rows or not yet
  let loaded: Promise<void>
  let whenLoaded: () => Promise<void>
  let published: Published[]
  let removed: ((id: string) => Promise<void>) | undefined
  let policy: {
    admit: jest.Mock<Promise<PolicyDecision>>
    recordOutcome: jest.Mock<Promise<boolean>>
    forget: jest.Mock<Promise<void>>
  }
  let idempotency: {
    complete: jest.Mock<Promise<boolean>>
    fail: jest.Mock<Promise<boolean>>
  }
  const open: { service: SendQueueService; redis: RedisService }[] = []

  const config = (env: Record<string, string> = {}): ReturnType<typeof parseEnv> =>
    parseEnv({
      ...TEST_ENV,
      REDIS_URL: redisUrl,
      SEND_MIN_INTERVAL_MS: '0',
      SEND_JITTER_MS: '0',
      SEND_NOT_READY_RETRY_MS: '100',
      SEND_BREAKER_THRESHOLD: '2',
      SEND_BREAKER_COOLDOWN_MS: '400',
      ...env
    })

  // A new service over the same Redis: what a restarted process has
  const boot = async (
    env: Record<string, string> = {},
    onMetric?: () => void
  ): Promise<SendQueueService> => {
    const settings = config(env)
    const redis = new RedisService(settings)
    const sessions = {
      whenLoaded: () => whenLoaded(),
      status: () => {
        if (!exists) throw new NotFoundError('NOT_FOUND', 'no session')
        return 'ready'
      },
      requireReady: () => {
        // As the real one: the status is read first, so an unknown session is NOT_FOUND
        if (!exists) throw new NotFoundError('NOT_FOUND', 'no session')
        if (!ready) throw new ConflictError('SESSION_NOT_READY', 'not ready')
        return client
      },
      onRemoved: jest.fn((listener: (id: string) => Promise<void>) => {
        removed = listener
        return () => undefined
      })
    } as unknown as SessionManager
    const rows = {
      list: () => Promise.resolve([{ id: sessionId }])
    } as unknown as SessionsRepository
    const pipeline = {
      publish: (id: string, event: string, data: Record<string, unknown>) => {
        published.push({ sessionId: id, event, data })
        return Promise.resolve()
      }
    } as unknown as EventPipelineService
    const service = new SendQueueService(
      settings,
      redis,
      sessions,
      rows,
      policy as unknown as SendPolicyService,
      pipeline,
      brokenMetrics(onMetric),
      { addBusyCheck: jest.fn() } as unknown as WatchdogService,
      idempotency as unknown as IdempotencyRepository
    )
    open.push({ service, redis })
    await service.onModuleInit()
    return service
  }

  const brokenMetrics = (onMetric?: () => void): MetricsService => {
    const metrics = new MetricsService()
    if (onMetric) jest.spyOn(metrics.metrics.sends, 'inc').mockImplementation(onMetric)
    return metrics
  }

  const shutdown = async (service: SendQueueService): Promise<void> => {
    const entry = open.find(item => item.service === service)
    await service.onModuleDestroy()
    await entry?.redis.onApplicationShutdown()
    open.splice(open.indexOf(entry as (typeof open)[number]), 1)
  }

  const text = (body: string, extra: Partial<NewSendJob> = {}): NewSendJob => ({
    sessionId,
    chatId: CHAT,
    content: { type: 'text', body },
    ...extra
  })

  const sentBodies = (): string[] =>
    client.callsOf('sendMessage').map(call => (call.args[1] as { body: string }).body)

  beforeEach(() => {
    client = new FakeWhatsAppClient(sessionId)
    ready = true
    exists = true
    loaded = Promise.resolve()
    whenLoaded = () => loaded
    published = []
    idempotency = {
      complete: jest.fn<Promise<boolean>, []>().mockResolvedValue(true),
      fail: jest.fn<Promise<boolean>, []>().mockResolvedValue(true)
    }
    policy = {
      admit: jest.fn<Promise<PolicyDecision>, []>().mockResolvedValue(ALLOW),
      recordOutcome: jest.fn<Promise<boolean>, []>().mockResolvedValue(false),
      forget: jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined)
    }
  })

  afterEach(async () => {
    for (const { service } of [...open]) await shutdown(service)
    const redis = new RedisService(config())
    const queue = new Queue(sendQueueName(sessionId), { connection: redis.client })
    await queue.obliterate({ force: true })
    await queue.close()
    await redis.onApplicationShutdown()
  })

  it('sends the jobs of a chat in the order they were accepted', async () => {
    const service = await boot()
    ready = false
    const bodies = ['uno', 'dos', 'tres', 'cuatro', 'cinco']
    for (const body of bodies) await service.submit(text(body))
    ready = true

    await until(() => sentBodies().length === bodies.length)
    expect(sentBodies()).toEqual(bodies)
  })

  it('does not hold the order when the policy delays the first job', async () => {
    const service = await boot()
    policy.admit.mockResolvedValueOnce({
      decision: 'delay',
      delayMs: 300,
      rule: 'session_per_minute'
    })
    await service.submit(text('primero'))
    await service.submit(text('segundo'))

    await until(() => sentBodies().length === 2)
    expect(sentBodies()).toEqual(['primero', 'segundo'])
  })

  describe('a cold send held by the policy', () => {
    const OTHER_CHAT = '5215500000003@c.us'
    const COLD_RULES: PolicyRule[] = ['quiet_hours', 'cold_send_gap']

    // The first admission of COLD_CHAT is delayed for `delayMs`, the rest are allowed
    const holdFirstColdSend = (coldChat: string, delayMs: number, rule: PolicyRule): void => {
      let held = false
      policy.admit.mockImplementation((intent: { chatId: string }) => {
        if (intent.chatId === coldChat && !held) {
          held = true
          return Promise.resolve({ decision: 'delay', delayMs, rule })
        }
        return Promise.resolve(ALLOW)
      })
    }

    it.each(COLD_RULES)(
      'does not block the sends to other chats of the session (%s)',
      async rule => {
        const service = await boot()
        holdFirstColdSend(OTHER_CHAT, 60_000, rule)

        const cold = await service.submit(text('frio', { chatId: OTHER_CHAT }))
        await service.submit(text('tibio'))

        await until(() => sentBodies().includes('tibio'))
        expect(sentBodies()).toEqual(['tibio'])
        await expect(service.status(sessionId, cold.jobId)).resolves.toMatchObject({
          status: 'queued'
        })
      }
    )

    it('sends it once the hold ends', async () => {
      const service = await boot()
      holdFirstColdSend(OTHER_CHAT, 400, 'quiet_hours')

      await service.submit(text('frio', { chatId: OTHER_CHAT }))
      await service.submit(text('tibio'))

      await until(() => sentBodies().length === 2)
      expect(sentBodies()).toEqual(['tibio', 'frio'])
    })

    it('keeps the order of the messages of the cold chat itself', async () => {
      const service = await boot()
      holdFirstColdSend(OTHER_CHAT, 400, 'cold_send_gap')

      await service.submit(text('frio 1', { chatId: OTHER_CHAT }))
      await service.submit(text('frio 2', { chatId: OTHER_CHAT }))
      await service.submit(text('frio 3', { chatId: OTHER_CHAT }))

      await until(() => sentBodies().length === 3)
      expect(sentBodies()).toEqual(['frio 1', 'frio 2', 'frio 3'])
    })

    it('puts the later messages of the cold chat aside until the held one is due, not once a second', async () => {
      const service = await boot()
      holdFirstColdSend(OTHER_CHAT, 3000, 'cold_send_gap')
      const aside = jest.spyOn(Job.prototype, 'moveToDelayed')

      await service.submit(text('frio 1', { chatId: OTHER_CHAT }))
      await service.submit(text('frio 2', { chatId: OTHER_CHAT }))
      await service.submit(text('frio 3', { chatId: OTHER_CHAT }))
      await new Promise(resolve => setTimeout(resolve, 2300))

      // One for the held job and one for each later message; a turn every second would make 7 by now
      expect(aside.mock.calls.length).toBeLessThanOrEqual(4)
      expect(sentBodies()).toEqual([])
      await until(() => sentBodies().length === 3, 6000)
      expect(sentBodies()).toEqual(['frio 1', 'frio 2', 'frio 3'])
      aside.mockRestore()
    }, 15_000)

    it('still blocks the lane for a delay of the whole session, which every send shares', async () => {
      const service = await boot()
      holdFirstColdSend(CHAT, 400, 'session_per_minute')

      await service.submit(text('primero'))
      await service.submit(text('segundo', { chatId: OTHER_CHAT }))

      await until(() => sentBodies().length === 2)
      expect(sentBodies()).toEqual(['primero', 'segundo'])
    })
  })

  it('returns the outcome to a caller that waits and does not publish it as an event', async () => {
    const service = await boot()
    const result = await service.submit(text('hola'), { waitMs: 5000 })

    expect(result.outcome).toMatchObject({ ok: true })
    expect(published.filter(item => item.event.startsWith('message_'))).toEqual([])
    await expect(service.status(sessionId, result.jobId)).resolves.toMatchObject({ status: 'sent' })
  })

  it('answers 202 data when the wait runs out and publishes message_sent later', async () => {
    const service = await boot()
    ready = false
    const result = await service.submit(text('tarde', { idempotencyKey: 'k1' }), { waitMs: 150 })

    expect(result.outcome).toBeUndefined()
    await expect(service.status(sessionId, result.jobId)).resolves.toMatchObject({
      status: 'active'
    })
    ready = true
    await until(() => published.some(item => item.event === 'message_sent'))
    expect(published.find(item => item.event === 'message_sent')?.data).toMatchObject({
      jobId: result.jobId,
      idempotencyKey: 'k1'
    })
  })

  it('publishes message_failed with the error and the idempotency key', async () => {
    const service = await boot()
    policy.admit.mockResolvedValue({
      decision: 'reject',
      code: 'POLICY_BLOCKED',
      rule: 'cold_sends_disabled'
    })
    const { jobId } = await service.submit(text('no', { idempotencyKey: 'k2' }))

    await until(() => published.some(item => item.event === 'message_failed'))
    expect(published.find(item => item.event === 'message_failed')?.data).toMatchObject({
      jobId,
      idempotencyKey: 'k2',
      error: { code: 'POLICY_BLOCKED' }
    })
    await expect(service.status(sessionId, jobId)).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'POLICY_BLOCKED' }
    })
  })

  it('ends the idempotency key with the outcome of the job, sent or failed', async () => {
    const service = await boot()
    const sent = await service.submit(text('uno', { idempotencyKey: 'k-ok' }), { waitMs: 5000 })
    policy.admit.mockResolvedValue({
      decision: 'reject',
      code: 'POLICY_BLOCKED',
      rule: 'cold_sends_disabled'
    })
    await service.submit(text('dos', { idempotencyKey: 'k-bad' }), { waitMs: 5000 })

    expect(idempotency.complete).toHaveBeenCalledWith(sessionId, 'k-ok', {
      messageId: sent.outcome?.ok ? (sent.outcome.message?.id ?? null) : 'missing',
      response: sent.outcome
    })
    expect(idempotency.fail).toHaveBeenCalledWith(sessionId, 'k-bad', {
      response: {
        ok: false,
        error: expect.objectContaining({ code: 'POLICY_BLOCKED' }) as Record<string, unknown>
      }
    })
  })

  it('does not touch the idempotency table for a send without a key', async () => {
    const service = await boot()
    await service.submit(text('sin llave'), { waitMs: 5000 })

    expect(idempotency.complete).not.toHaveBeenCalled()
    expect(idempotency.fail).not.toHaveBeenCalled()
  })

  it('queues one job when the same jobId is submitted twice at once', async () => {
    const service = await boot()
    const [first, second] = await Promise.all([
      service.submit(text('una vez'), { jobId: 'fixed-id' }),
      service.submit(text('una vez'), { jobId: 'fixed-id' })
    ])

    expect(first.jobId).toBe(second.jobId)
    await until(() => sentBodies().length > 0)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(sentBodies()).toEqual(['una vez'])
    expect(policy.admit).toHaveBeenCalledTimes(1)
  })

  it('still answers the caller when the idempotency write fails', async () => {
    const service = await boot()
    idempotency.complete.mockRejectedValue(new Error('postgres down'))

    const result = await service.submit(text('uno', { idempotencyKey: 'k-down' }), {
      waitMs: 5000
    })

    expect(result.outcome).toMatchObject({ ok: true })
  })

  it('records an UNKNOWN_OUTCOME against the key', async () => {
    const service = await boot()
    policy.admit.mockRejectedValue(new Error('boom'))

    const result = await service.submit(text('uno', { idempotencyKey: 'k-throw' }), {
      waitMs: 5000
    })

    expect(result.outcome).toMatchObject({ ok: false })
    expect(idempotency.fail).toHaveBeenCalledWith(sessionId, 'k-throw', {
      response: {
        ok: false,
        error: expect.objectContaining({ code: 'INTERNAL' }) as Record<string, unknown>
      }
    })
  })

  describe('durability', () => {
    it('keeps a queued message through a restart and sends it once', async () => {
      const first = await boot()
      ready = false
      const { jobId } = await first.submit(text('sobrevivo'))
      await shutdown(first)
      expect(sentBodies()).toEqual([])

      ready = true
      const second = await boot()
      await until(() => sentBodies().length === 1)
      await until(async () => (await second.status(sessionId, jobId)).status === 'sent')
      expect(sentBodies()).toEqual(['sobrevivo'])
    })

    it('takes no job before the boot has loaded the sessions, then sends it once', async () => {
      const first = await boot()
      ready = false
      const { jobId } = await first.submit(text('espero al arranque'))
      await shutdown(first)

      // The restarted process: the queue is open, the session rows are not read yet
      let finishLoading!: () => void
      loaded = new Promise<void>(resolve => {
        finishLoading = resolve
      })
      exists = false
      ready = false
      const second = await boot()
      await new Promise(resolve => setTimeout(resolve, 500))
      // Not consumed as a failure, not sent: the job is still owed
      expect(sentBodies()).toEqual([])
      expect(published.filter(item => item.event === 'message_failed')).toEqual([])

      exists = true
      ready = true
      finishLoading()
      await until(() => sentBodies().length === 1)
      await until(async () => (await second.status(sessionId, jobId)).status === 'sent')
      expect(sentBodies()).toEqual(['espero al arranque'])
    })

    it('starts the worker once the sessions load, after a boot read that failed', async () => {
      const first = await boot()
      ready = false
      await first.submit(text('tras el fallo'))
      await shutdown(first)

      let attempts = 0
      loaded = Promise.resolve()
      const failing = jest.fn(() =>
        ++attempts < 3 ? Promise.reject(new Error('db down')) : loaded
      )
      whenLoaded = failing
      ready = true
      await boot()
      await until(() => sentBodies().length === 1)
      expect(attempts).toBeGreaterThanOrEqual(3)
    })

    it('carries the time already waited across the restart that interrupted the wait', async () => {
      const first = await boot()
      ready = false
      const { jobId } = await first.submit(text('espero'))
      await new Promise(resolve => setTimeout(resolve, 250))
      await shutdown(first)

      const redis = new RedisService(config())
      const queue = new Queue<SendJobData>(sendQueueName(sessionId), { connection: redis.client })
      const job = await queue.getJob(jobId)
      expect(job?.data.waitedMs).toBeGreaterThanOrEqual(200)
      expect(await job?.getState()).toBe('delayed')
      await queue.close()
      await redis.onApplicationShutdown()
    })

    it('ends a job that was being dispatched when the process died as UNKNOWN_OUTCOME', async () => {
      // The state a crash leaves: a job in Redis with the dispatch mark and no result
      const redis = new RedisService(config())
      const queue = new Queue<SendJobData>(sendQueueName(sessionId), { connection: redis.client })
      const job = await queue.add(
        'send',
        { ...text('quizá salió'), enqueuedAt: Date.now(), dispatchedAt: Date.now() - 500 },
        { jobId: randomUUID() }
      )
      await queue.close()
      await redis.onApplicationShutdown()

      const service = await boot()
      await until(async () => (await service.status(sessionId, job.id ?? '')).status === 'failed')

      expect(sentBodies()).toEqual([])
      await expect(service.status(sessionId, job.id ?? '')).resolves.toMatchObject({
        error: { code: 'UNKNOWN_OUTCOME' }
      })
      expect(published.find(item => item.event === 'message_failed')?.data).toMatchObject({
        error: { code: 'UNKNOWN_OUTCOME' }
      })
    })
  })

  describe('a job that throws', () => {
    it('answers the waiting caller with INTERNAL instead of leaving it hanging', async () => {
      const service = await boot()
      policy.admit.mockRejectedValue(new Error('postgres down'))
      const result = await service.submit(text('x'), { waitMs: 5000 })

      expect(result.outcome).toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
      await expect(service.status(sessionId, result.jobId)).resolves.toMatchObject({
        status: 'failed',
        error: { code: 'INTERNAL' }
      })
    })

    it('announces message_failed when nobody waits', async () => {
      const service = await boot()
      policy.admit.mockRejectedValue(new Error('postgres down'))
      const { jobId } = await service.submit(text('x', { idempotencyKey: 'k9' }))

      await until(() => published.some(item => item.event === 'message_failed'))
      expect(published.find(item => item.event === 'message_failed')?.data).toMatchObject({
        jobId,
        idempotencyKey: 'k9',
        error: { code: 'INTERNAL' }
      })
    })

    it('does not feed a failure of the gateway to the breaker', async () => {
      const service = await boot()
      policy.admit.mockRejectedValue(new Error('postgres down'))
      for (let n = 0; n < 3; n += 1) await service.submit(text(`x${n}`), { waitMs: 5000 })

      expect(published.some(item => item.data['code'] === 'SEND_BREAKER_OPEN')).toBe(false)
    })
  })

  describe('the accounting around a job', () => {
    it('does not turn a message that went out into a failure when the metrics throw', async () => {
      const service = await boot({}, () => {
        throw new Error('registry broken')
      })
      const result = await service.submit(text('salió'), { waitMs: 5000 })

      expect(result.outcome).toMatchObject({ ok: true })
      expect(sentBodies()).toEqual(['salió'])
      await expect(service.status(sessionId, result.jobId)).resolves.toMatchObject({
        status: 'sent'
      })
    })
  })

  describe('the order stamp of a job', () => {
    it('grows even when the clock stands still or steps back', async () => {
      const service = await boot()
      const stamp = (service as unknown as { nextStamp: () => number }).nextStamp.bind(service)
      const now = jest.spyOn(Date, 'now')
      try {
        now.mockReturnValue(5_000)
        const same = [stamp(), stamp(), stamp()]
        now.mockReturnValue(1_000)
        const back = stamp()

        expect(same).toEqual([5_000, 5_001, 5_002])
        expect(back).toBe(5_003)
      } finally {
        now.mockRestore()
      }
    })

    it('is the timestamp BullMQ keeps for the job, which the order check reads', async () => {
      const service = await boot()
      ready = false
      // A stamp far from the clock, so the timestamp BullMQ would take by itself is visibly different
      jest
        .spyOn(service as unknown as { nextStamp: () => number }, 'nextStamp')
        .mockReturnValue(9_000_000_000_000)
      const { jobId } = await service.submit(text('uno'))

      const redis = new RedisService(config())
      const queue = new Queue<SendJobData>(sendQueueName(sessionId), { connection: redis.client })
      const job = await queue.getJob(jobId)
      await queue.close()
      await redis.onApplicationShutdown()

      expect(job?.timestamp).toBe(9_000_000_000_000)
      expect(job?.data.enqueuedAt).toBe(9_000_000_000_000)
    })
  })

  describe('a job the queue itself fails', () => {
    it('puts a job that never started aside again when Redis fails once during the shutdown, and sends it after', async () => {
      const first = await boot()
      ready = false
      await first.submit(text('atrapado'))
      await new Promise(resolve => setTimeout(resolve, 200))
      const blip = jest
        .spyOn(Job.prototype, 'moveToDelayed')
        .mockRejectedValueOnce(new Error('redis blip'))
      try {
        await shutdown(first)
      } finally {
        blip.mockRestore()
      }
      expect(published.some(item => item.event === 'message_failed')).toBe(false)

      ready = true
      await boot()
      await until(() => sentBodies().includes('atrapado'))
      expect(sentBodies()).toEqual(['atrapado'])
      expect(published.some(item => item.event === 'message_failed')).toBe(false)
    })

    it('keeps a cold send held by the policy when Redis fails once while it leaves the lane', async () => {
      const service = await boot()
      let held = false
      policy.admit.mockImplementation(() => {
        if (held) return Promise.resolve(ALLOW)
        held = true
        return Promise.resolve({ decision: 'delay', delayMs: 300, rule: 'quiet_hours' })
      })
      const blip = jest
        .spyOn(Job.prototype, 'moveToDelayed')
        .mockRejectedValueOnce(new Error('redis blip'))

      await service.submit(text('frio'))
      await until(() => sentBodies().includes('frio'))

      blip.mockRestore()
      expect(published.some(item => item.event === 'message_failed')).toBe(false)
    })

    it('is still announced as failed when putting it aside keeps failing during the shutdown', async () => {
      const first = await boot()
      ready = false
      const { jobId } = await first.submit(text('atrapado', { idempotencyKey: 'k7' }))
      await new Promise(resolve => setTimeout(resolve, 200))
      const broken = jest
        .spyOn(Job.prototype, 'moveToDelayed')
        .mockRejectedValue(new Error('redis blip'))
      try {
        await shutdown(first)
        // Tried a few times before it gave up
        expect(broken.mock.calls.length).toBeGreaterThan(1)
      } finally {
        broken.mockRestore()
      }

      await until(() => published.some(item => item.event === 'message_failed'))
      expect(published.find(item => item.event === 'message_failed')?.data).toMatchObject({
        jobId,
        idempotencyKey: 'k7',
        error: { code: 'INTERNAL' }
      })
      expect(sentBodies()).toEqual([])
    })
  })

  describe('order across a restart, before and after the delay', () => {
    it('keeps the order when the restart is faster than the delay of the job put aside', async () => {
      const first = await boot()
      ready = false
      for (const body of ['a', 'b', 'c']) await first.submit(text(body))
      await new Promise(resolve => setTimeout(resolve, 250))
      await shutdown(first)

      ready = true
      await boot({ SEND_NOT_READY_RETRY_MS: '1500' })
      await until(() => sentBodies().length === 3, 15_000)
      expect(sentBodies()).toEqual(['a', 'b', 'c'])
    })

    it('still sends when the order check cannot read the queue, and says so', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation()
      try {
        const service = await boot()
        const client = open.find(item => item.service === service)?.redis.client
        if (!client) throw new Error('no connection')
        jest.spyOn(client, 'lrange').mockRejectedValueOnce(new Error('redis blip'))
        const result = await service.submit(text('igual'), { waitMs: 5000 })

        expect(result.outcome).toMatchObject({ ok: true })
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Order check failed'))
      } finally {
        warn.mockRestore()
      }
    })

    it('reads no job at all when the job is alone in the queue', async () => {
      const service = await boot()
      const client = open.find(item => item.service === service)?.redis.client
      if (!client) throw new Error('no connection')
      const pipeline = jest.spyOn(client, 'pipeline')
      const result = await service.submit(text('solo'), { waitMs: 5000 })

      expect(result.outcome).toMatchObject({ ok: true })
      expect(pipeline).not.toHaveBeenCalled()
    })

    it('reads one field of the other jobs and not their data when there is a backlog', async () => {
      const service = await boot()
      const client = open.find(item => item.service === service)?.redis.client
      if (!client) throw new Error('no connection')
      ready = false
      for (const body of ['x', 'y', 'z']) await service.submit(text(body))
      ready = true
      const pipeline = jest.spyOn(client, 'pipeline')
      const hgetall = jest.spyOn(client, 'hgetall')
      const getJobs = jest.spyOn(Queue.prototype, 'getJobs')
      try {
        await until(() => sentBodies().length === 3)

        // One pipeline of single-field reads per turn, never the jobs themselves
        expect(pipeline).toHaveBeenCalled()
        expect(hgetall).not.toHaveBeenCalled()
        expect(getJobs).not.toHaveBeenCalled()
      } finally {
        getJobs.mockRestore()
      }
    })
  })

  describe('order across a restart', () => {
    it('keeps the order of the chat when the job that waited was put aside by the shutdown', async () => {
      const first = await boot()
      ready = false
      for (const body of ['a', 'b', 'c']) await first.submit(text(body))
      // 'a' is now waiting for the session inside the worker; the shutdown puts it aside
      await new Promise(resolve => setTimeout(resolve, 250))
      await shutdown(first)
      // A restart takes longer than the delay the waiting job was put aside for, so it is already
      // due when the new worker starts and is promoted behind the jobs that kept waiting
      await new Promise(resolve => setTimeout(resolve, 400))

      ready = true
      await boot()
      await until(() => sentBodies().length === 3)
      expect(sentBodies()).toEqual(['a', 'b', 'c'])
    })
  })

  describe('making way for an older job', () => {
    it('sends the job anyway when it cannot be put aside, out of order but not lost', async () => {
      const first = await boot()
      ready = false
      await first.submit(text('viejo'))
      await new Promise(resolve => setTimeout(resolve, 250))
      await shutdown(first)

      ready = true
      const moved = jest
        .spyOn(Job.prototype, 'moveToDelayed')
        .mockRejectedValue(new Error('redis blip'))
      try {
        const second = await boot()
        await second.submit(text('nuevo'))
        await until(() => sentBodies().length === 2)
      } finally {
        moved.mockRestore()
      }

      expect([...sentBodies()].sort()).toEqual(['nuevo', 'viejo'])
      expect(published.some(item => item.event === 'message_failed')).toBe(false)
    })
  })

  describe('a session that is deleted', () => {
    it('answers the caller that was still waiting instead of leaving it until its timeout', async () => {
      const service = await boot()
      ready = false
      const waiting = service.submit(text('espero'), { waitMs: 30_000 })
      await new Promise(resolve => setTimeout(resolve, 200))
      await removed?.(sessionId)

      const result = await waiting
      expect(result.outcome).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    })

    it('is not given a new queue by a send that was already on its way', async () => {
      const service = await boot()
      await removed?.(sessionId)
      exists = false

      await expect(service.submit(text('tarde'))).rejects.toBeInstanceOf(NotFoundError)
      const queues: number[] = []
      service.watchQueues(list => queues.push(list.length))()
      expect(queues).toEqual([0])
    })

    it('drops the send policy state of the session, after its lane is closed', async () => {
      await boot()
      const order: string[] = []
      policy.forget.mockImplementation(() => {
        order.push('forget')
        return Promise.resolve()
      })

      await removed?.(sessionId)
      order.push('removed')

      expect(policy.forget).toHaveBeenCalledWith(sessionId)
      expect(order).toEqual(['forget', 'removed'])
    })

    it('drops the send policy state also when the session never had a lane', async () => {
      await boot()

      await removed?.('no-such-lane')

      expect(policy.forget).toHaveBeenCalledWith('no-such-lane')
    })

    it('fails the deletion call, not the lane cleanup, when the state cannot be dropped', async () => {
      await boot()
      policy.forget.mockRejectedValueOnce(new Error('redis down'))

      await expect(removed?.(sessionId)).rejects.toThrow('redis down')
    })

    it('does not fail the deletion when the lane never opened', async () => {
      const service = await boot()
      await removed?.('no-such-lane')
      await expect(service.status(sessionId, randomUUID())).rejects.toBeInstanceOf(NotFoundError)
    })
  })

  describe('the circuit breaker', () => {
    it('pauses the queue after SEND_BREAKER_THRESHOLD hard failures and resumes after the cooldown', async () => {
      const service = await boot()
      client.failNext('sendMessage', new WaOperationError('sendMessage', 'no'), 2)
      await service.submit(text('falla 1'))
      await service.submit(text('falla 2'))

      await until(() => published.some(item => item.data['code'] === 'SEND_BREAKER_OPEN'))
      await service.submit(text('detrás'))
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(sentBodies()).toEqual(['falla 1', 'falla 2'])

      await until(() => sentBodies().includes('detrás'))
    })

    it('resets the count on a send that works', async () => {
      const service = await boot()
      client.failNext('sendMessage', new WaOperationError('sendMessage', 'no'))
      await service.submit(text('falla'), { waitMs: 5000 })
      await service.submit(text('bien'), { waitMs: 5000 })
      client.failNext('sendMessage', new WaOperationError('sendMessage', 'no'))
      await service.submit(text('falla otra vez'), { waitMs: 5000 })

      expect(sentBodies()).toHaveLength(3)
      expect(published.some(item => item.data['code'] === 'SEND_BREAKER_OPEN')).toBe(false)
    })
  })

  describe('the health throttle', () => {
    it('feeds every outcome to the policy and publishes session_error when it trips', async () => {
      const service = await boot()
      policy.recordOutcome.mockResolvedValueOnce(true)
      await service.submit(text('uno'), { waitMs: 5000 })

      expect(policy.recordOutcome).toHaveBeenCalledWith(sessionId, 'ok')
      expect(published.find(item => item.event === 'session_error')?.data).toMatchObject({
        code: 'SEND_HEALTH_DEGRADED'
      })
    })

    it('does not lose the outcome when the bookkeeping fails', async () => {
      const service = await boot()
      policy.recordOutcome.mockRejectedValue(new Error('postgres down'))
      const result = await service.submit(text('uno'), { waitMs: 5000 })

      expect(result.outcome).toMatchObject({ ok: true })
    })
  })

  describe('reads', () => {
    it('refuses a send for a session that does not exist', async () => {
      const service = await boot()
      exists = false

      await expect(service.submit(text('x'))).rejects.toBeInstanceOf(NotFoundError)
    })

    it('answers 404 for a job that does not exist', async () => {
      const service = await boot()

      await expect(service.status(sessionId, randomUUID())).rejects.toBeInstanceOf(NotFoundError)
    })

    it('reports a queued job and tells when a call to WhatsApp is in flight', async () => {
      const service = await boot()
      let release: (() => void) | undefined
      client.script(
        'sendMessage',
        () => new Promise(resolve => (release = () => resolve(buildMessageDto())))
      )
      const { jobId } = await service.submit(text('lento'))

      await until(() => service.isSending(sessionId))
      await expect(service.status(sessionId, jobId)).resolves.toMatchObject({ status: 'active' })
      release?.()
      await until(() => !service.isSending(sessionId))
    })
  })

  describe('admission', () => {
    const depthOf = async (id: string): Promise<number> => {
      const redis = new RedisService(config())
      const queue = new Queue(sendQueueName(id), { connection: redis.client })
      const counts = await queue.getJobCounts('waiting', 'delayed', 'active')
      await queue.close()
      await redis.onApplicationShutdown()
      return Object.values(counts).reduce((sum, n) => sum + n, 0)
    }

    it('refuses the send that passes SEND_QUEUE_MAX_PER_SESSION, queues nothing and says when to retry', async () => {
      const service = await boot({ SEND_QUEUE_MAX_PER_SESSION: '3', SEND_MIN_INTERVAL_MS: '3000' })
      ready = false
      for (const body of ['a', 'b', 'c']) await service.submit(text(body))

      const refused = await service.submit(text('d')).catch((error: unknown) => error)

      expect(refused).toBeInstanceOf(ServiceBusyError)
      expect(refused).toMatchObject({
        code: 'SEND_QUEUE_FULL',
        status: 429,
        retryAfterSeconds: 3,
        nothingQueued: true,
        details: { scope: 'session', limit: 3 }
      })
      expect(await depthOf(sessionId)).toBe(3)
    })

    it('lets only the cap through when many sends arrive at once', async () => {
      const service = await boot({ SEND_QUEUE_MAX_PER_SESSION: '3' })
      ready = false

      const results = await Promise.allSettled(
        Array.from({ length: 12 }, (_, n) => service.submit(text(`m${n}`)))
      )

      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(3)
      expect(await depthOf(sessionId)).toBe(3)
    })

    it('takes sends again once the queue drains', async () => {
      const service = await boot({ SEND_QUEUE_MAX_PER_SESSION: '2' })
      ready = false
      await service.submit(text('a'))
      await service.submit(text('b'))
      await expect(service.submit(text('c'))).rejects.toMatchObject({ code: 'SEND_QUEUE_FULL' })

      ready = true
      await until(() => sentBodies().length === 2)
      await until(async () => (await depthOf(sessionId)) === 0)

      await expect(service.submit(text('d'))).resolves.toMatchObject({})
    })

    it('counts the sends of every session against SEND_QUEUE_MAX_TOTAL', async () => {
      const other = `${sessionId}-b`
      const service = await boot({ SEND_QUEUE_MAX_PER_SESSION: '3', SEND_QUEUE_MAX_TOTAL: '3' })
      ready = false
      try {
        await service.submit(text('a'))
        await service.submit(text('b'))
        await service.submit({ ...text('c'), sessionId: other })

        await expect(service.submit({ ...text('d'), sessionId: other })).rejects.toMatchObject({
          code: 'SEND_QUEUE_FULL',
          details: { scope: 'global', limit: 3 }
        })
        await expect(service.submit(text('e'))).rejects.toMatchObject({
          code: 'SEND_QUEUE_FULL',
          details: { scope: 'global' }
        })
      } finally {
        await shutdown(service)
        const redis = new RedisService(config())
        const queue = new Queue(sendQueueName(other), { connection: redis.client })
        await queue.obliterate({ force: true })
        await queue.close()
        await redis.onApplicationShutdown()
      }
    })

    it('answers 503 at once and queues nothing while Redis is not connected', async () => {
      const service = await boot()
      const entry = open.find(item => item.service === service)
      const client = entry?.redis.client as RedisService['client']
      const original = Object.getOwnPropertyDescriptor(client, 'status')
      Object.defineProperty(client, 'status', { configurable: true, get: () => 'reconnecting' })

      const started = Date.now()
      const refused = await service.submit(text('x')).catch((error: unknown) => error)
      if (original) Object.defineProperty(client, 'status', original)

      expect(Date.now() - started).toBeLessThan(500)
      expect(refused).toMatchObject({
        code: 'QUEUE_UNAVAILABLE',
        status: 503,
        nothingQueued: true,
        details: { queued: false }
      })
      expect(await depthOf(sessionId)).toBe(0)
    })

    afterEach(() => {
      jest.restoreAllMocks()
    })

    it('answers 503 with queued unknown when Redis does not confirm the add in time, and admits the next send', async () => {
      const service = await boot({ SEND_ENQUEUE_TIMEOUT_MS: '100' })
      jest.spyOn(Queue.prototype, 'add').mockImplementationOnce(() => new Promise(() => undefined))

      const refused = await service
        .submit(text('x'), { jobId: 'idem-test' })
        .catch((error: unknown) => error)

      expect(refused).toMatchObject({
        code: 'QUEUE_UNAVAILABLE',
        nothingQueued: false,
        details: { queued: 'unknown' },
        message: expect.stringContaining('same Idempotency-Key') as string
      })
      // The reservation of the failed add was given back: the queue is not slowly refusing sends
      await expect(service.submit(text('y'))).resolves.toMatchObject({})
    })

    it('withdraws the job of a send without a key when its late add finally lands', async () => {
      const service = await boot({ SEND_ENQUEUE_TIMEOUT_MS: '100' })
      ready = false
      // eslint-disable-next-line @typescript-eslint/unbound-method -- called with the queue as `this` below
      const realAdd = Queue.prototype.add
      jest.spyOn(Queue.prototype, 'add').mockImplementationOnce(function (
        this: Queue,
        ...args: Parameters<Queue['add']>
      ) {
        return new Promise(resolve => setTimeout(resolve, 300)).then(() =>
          realAdd.apply(this, args)
        )
      } as Queue['add'])

      const refused = await service.submit(text('x')).catch((error: unknown) => error)

      expect(refused).toMatchObject({ details: { queued: 'unknown' } })
      await until(async () => (await depthOf(sessionId)) === 0, 3000)
    })

    it('answers a send that is already queued even when the depth count after the add never returns', async () => {
      const service = await boot()
      // eslint-disable-next-line @typescript-eslint/unbound-method -- called with the queue as `this` below
      const realCounts = Queue.prototype.getJobCounts
      // The first call is the room check before the add; the one after the add hangs
      jest
        .spyOn(Queue.prototype, 'getJobCounts')
        .mockImplementationOnce(function (this: Queue, ...args: Parameters<Queue['getJobCounts']>) {
          return realCounts.apply(this, args)
        })
        .mockImplementation(() => new Promise(() => undefined))

      const answered = await Promise.race([
        service.submit(text('x'), { waitMs: 3000 }),
        new Promise<'hung'>(resolve => setTimeout(() => resolve('hung'), 1500))
      ])

      expect(answered).not.toBe('hung')
      expect(answered).toMatchObject({ outcome: { ok: true } })
      expect(sentBodies()).toEqual(['x'])
    })

    it('answers 503 not queued, and gives the place back, when Redis fails while the room is counted', async () => {
      const service = await boot({ SEND_QUEUE_MAX_PER_SESSION: '1' })
      jest
        .spyOn(Queue.prototype, 'getJobCounts')
        .mockRejectedValueOnce(new Error('Connection is closed.'))

      await expect(service.submit(text('x'))).rejects.toMatchObject({
        code: 'QUEUE_UNAVAILABLE',
        nothingQueued: true
      })
      await expect(service.submit(text('y'))).resolves.toMatchObject({})
    })
  })
})
