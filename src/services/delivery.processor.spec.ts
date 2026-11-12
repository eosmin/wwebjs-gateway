import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { Logger } from '@nestjs/common'
import { UnrecoverableError } from 'bullmq'

import { TEST_ENV } from '../../tests/helpers/env.js'
import { NotFoundError } from '../common/errors.js'
import { signWebhook } from '../common/lib/crypto.js'
import * as retryModule from '../common/lib/retry.js'
import { parseEnv } from '../config/env.schema.js'
import type { Webhook, WebhookDelivery } from '../database/models.js'
import type {
  DeliveriesRepository,
  DeliveryAttempt
} from '../database/repositories/deliveries.repository.js'
import { REDACTED } from '../infra/logger/redaction.js'
import { MetricsService } from '../infra/metrics/metrics.service.js'
import type { RedisService } from '../infra/redis/redis.service.js'

import type { DeliveryEnvelope } from './delivery-queue.service.js'
import { DeliveryAttemptFailed, DeliveryProcessor } from './delivery.processor.js'
import type { WebhookService } from './webhook.service.js'

const LOOPBACK = '127.0.0.1'
const SECRET = 'whsec_current'
const SENTINEL = 'sentinel-message-text'

const workers: {
  name: string
  options: Record<string, unknown>
  handlers: Map<string, unknown>
}[] = []
const workerClose = jest.fn((_force?: boolean) => Promise.resolve())

// The classification of database errors has its own spec; here only what the processor does with it
jest.mock('../database/db-errors.js', () => ({
  isTransientDbError: (error: unknown) =>
    error instanceof Error && error.name === 'TransientDatabaseError'
}))

jest.mock('bullmq', () => ({
  ...jest.requireActual<object>('bullmq'),
  Worker: jest.fn((name: string, _processor: unknown, options: Record<string, unknown>) => {
    const handlers = new Map<string, unknown>()
    workers.push({ name, options, handlers })
    return {
      on: jest.fn((event: string, handler: unknown) => handlers.set(event, handler)),
      close: workerClose
    }
  })
}))

const envelope = (overrides: Partial<DeliveryEnvelope> = {}): DeliveryEnvelope => ({
  id: 'evt_1',
  event: 'message',
  sessionId: 'main',
  seq: 7,
  timestamp: '2026-01-01T00:00:00.000Z',
  data: { body: SENTINEL, text: 'añá 😀' },
  ...overrides
})

interface Received {
  headers: IncomingHttpHeaders
  body: string
}

describe('DeliveryProcessor', () => {
  let server: Server
  let port = 0
  let received: Received[] = []
  let answer: (index: number) => { status: number; delay?: number } = () => ({ status: 200 })
  const logged: string[] = []
  const delayed: NodeJS.Timeout[] = []

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        received.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') })
        const { status, delay } = answer(received.length - 1)
        const reply = (): void => {
          response.statusCode = status
          if (status >= 300 && status < 400) {
            response.setHeader('location', 'http://169.254.169.254/latest/meta-data')
          }
          response.end('x'.repeat(10))
        }
        if (delay === undefined) reply()
        else delayed.push(setTimeout(reply, delay))
      })
    })
    await new Promise<void>(resolve => server.listen(0, LOOPBACK, resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    for (const timer of delayed) clearTimeout(timer)
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  beforeEach(() => {
    received = []
    answer = () => ({ status: 200 })
    logged.length = 0
    workers.length = 0
    workerClose.mockClear()
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(String(args[0]))
      })
    }
  })
  afterEach(() => jest.restoreAllMocks())

  const webhook = (overrides: Partial<Webhook> = {}): Webhook => ({
    id: 'w1',
    sessionId: 'main',
    url: `http://${LOOPBACK}:${port}/in`,
    secret: SECRET,
    events: ['*'],
    enabled: true,
    mediaMode: 'reference',
    includeRaw: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides
  })

  function setup(
    options: { webhooks?: (Webhook | undefined)[]; env?: Record<string, string> } = {}
  ) {
    const hooks = options.webhooks ?? [webhook()]
    let reads = 0
    const require = jest.fn((id: string) => {
      const row = hooks[Math.min(reads, hooks.length - 1)]
      reads += 1
      return row === undefined
        ? Promise.reject(new NotFoundError('NOT_FOUND', `Webhook "${id}" does not exist`))
        : Promise.resolve(row)
    })
    const row: { current: Partial<WebhookDelivery> | null } = {
      current: { id: 'd1', webhookId: 'w1', status: 'pending' }
    }
    const attempts: DeliveryAttempt[] = []
    const findById = jest.fn((_id: string) =>
      Promise.resolve(row.current as WebhookDelivery | null)
    )
    const recordAttempt = jest.fn((_id: string, attempt: DeliveryAttempt, _at: Date) => {
      attempts.push(attempt)
      return Promise.resolve(row.current as WebhookDelivery | null)
    })
    const failUnqueued = jest.fn((_id: string, _error: string) => Promise.resolve())
    const metrics = new MetricsService()
    const config = parseEnv({
      ...TEST_ENV,
      WEBHOOK_PRIVATE_HOST_ALLOWLIST: LOOPBACK,
      WEBHOOK_TIMEOUT_MS: '2000',
      ...options.env
    })
    const processor = new DeliveryProcessor(
      config,
      { client: {} } as unknown as RedisService,
      { require } as unknown as WebhookService,
      { findById, recordAttempt, failUnqueued } as unknown as DeliveriesRepository,
      metrics
    )
    return { processor, require, row, attempts, findById, recordAttempt, failUnqueued, metrics }
  }

  const job = (
    overrides: { data?: unknown; attemptsMade?: number; attempts?: number } = {}
  ): Parameters<DeliveryProcessor['process']>[0] => ({
    data: overrides.data ?? { deliveryId: 'd1', webhookId: 'w1', envelope: envelope() },
    attemptsMade: overrides.attemptsMade ?? 0,
    opts: { attempts: overrides.attempts ?? 3 }
  })

  const results = async (metrics: MetricsService): Promise<Record<string, number>> => {
    const values = (await metrics.metrics.webhookDeliveries.get()).values
    return Object.fromEntries(values.map(v => [String(v.labels['result']), v.value]))
  }

  describe('the request', () => {
    it('posts the event with the headers and the signature of the TDD', async () => {
      const { processor, recordAttempt } = setup()
      const before = Math.floor(Date.now() / 1000)

      await processor.process(job())

      expect(received).toHaveLength(1)
      const { headers, body } = received[0] as Received
      expect(headers['content-type']).toBe('application/json')
      expect(headers['user-agent']).toMatch(/^wwebjs-gateway\/\d+\.\d+\.\d+/)
      expect(headers['x-gateway-event']).toBe('message')
      expect(headers['x-gateway-delivery']).toBe('d1')
      expect(headers['x-gateway-seq']).toBe('7')
      const timestamp = Number(headers['x-gateway-timestamp'])
      expect(timestamp).toBeGreaterThanOrEqual(before)
      expect(timestamp).toBeLessThanOrEqual(before + 5)
      expect(headers['x-gateway-signature']).toBe(signWebhook(SECRET, timestamp, body))
      expect(headers.host).toBe(`${LOOPBACK}:${port}`)
      expect(JSON.parse(body)).toEqual(envelope())
      expect(recordAttempt).toHaveBeenCalledWith(
        'd1',
        { status: 'success', statusCode: 200 },
        expect.any(Date)
      )
    })

    it('signs exactly the bytes it sends', async () => {
      const { processor } = setup()
      const text = 'ñ 😀 "quoted" \\ <tag>  '

      await processor.process(
        job({ data: { deliveryId: 'd1', webhookId: 'w1', envelope: envelope({ data: { text } }) } })
      )

      const { headers, body } = received[0] as Received
      expect(body).toBe(JSON.stringify(envelope({ data: { text } })))
      expect(headers['x-gateway-signature']).toBe(
        signWebhook(SECRET, Number(headers['x-gateway-timestamp']), body)
      )
    })

    it('counts the success and times the attempt', async () => {
      const { processor, metrics } = setup()

      await expect(processor.process(job())).resolves.toBe('delivered')

      expect(await results(metrics)).toEqual({ success: 1 })
      expect((await metrics.metrics.webhookDurationSeconds.get()).values.length).toBeGreaterThan(0)
    })
  })

  describe('a failed attempt', () => {
    it.each([500, 503, 404, 410, 429, 302])(
      'records a %s as a failure to retry, with the status',
      async status => {
        answer = () => ({ status })
        const { processor, attempts, metrics } = setup()

        await expect(processor.process(job())).rejects.toBeInstanceOf(DeliveryAttemptFailed)

        expect(attempts).toEqual([
          { status: 'pending', statusCode: status, error: `The receiver answered ${status}` }
        ])
        expect(await results(metrics)).toEqual({ retry: 1 })
        // A redirect is not followed: the one request is all the server saw
        expect(received).toHaveLength(1)
      }
    )

    it('goes to the dead letters when it was the last attempt', async () => {
      answer = () => ({ status: 500 })
      const { processor, attempts, metrics } = setup()

      await expect(processor.process(job({ attemptsMade: 2, attempts: 3 }))).rejects.toBeInstanceOf(
        DeliveryAttemptFailed
      )

      expect(attempts).toEqual([
        { status: 'failed', statusCode: 500, error: 'The receiver answered 500' }
      ])
      expect(await results(metrics)).toEqual({ failed: 1 })
    })

    it('stays pending on the attempt before the last one', async () => {
      answer = () => ({ status: 500 })
      const { processor, attempts } = setup()

      await expect(processor.process(job({ attemptsMade: 1, attempts: 3 }))).rejects.toThrow()

      expect(attempts[0]?.status).toBe('pending')
    })

    it('treats a job without a limit as a single attempt', async () => {
      answer = () => ({ status: 500 })
      const { processor, attempts } = setup()

      await expect(processor.process({ ...job(), opts: {} })).rejects.toBeInstanceOf(
        DeliveryAttemptFailed
      )

      expect(attempts[0]?.status).toBe('failed')
    })

    it('times out a receiver that does not answer', async () => {
      answer = () => ({ status: 200, delay: 1000 })
      const { processor, attempts } = setup({ env: { WEBHOOK_TIMEOUT_MS: '150' } })

      await expect(processor.process(job())).rejects.toBeInstanceOf(DeliveryAttemptFailed)

      expect(attempts).toEqual([
        { status: 'pending', statusCode: null, error: 'The receiver did not answer in 150 ms' }
      ])
    })

    it('records a connection that fails, without the URL', async () => {
      const closed = createServer()
      await new Promise<void>(resolve => closed.listen(0, LOOPBACK, resolve))
      const closedPort = (closed.address() as AddressInfo).port
      await new Promise<void>(resolve => closed.close(() => resolve()))
      const { processor, attempts } = setup({
        webhooks: [webhook({ url: `http://${LOOPBACK}:${closedPort}/secret-path-token` })]
      })

      await expect(processor.process(job())).rejects.toBeInstanceOf(DeliveryAttemptFailed)

      expect(attempts).toEqual([
        { status: 'pending', statusCode: null, error: 'The connection failed (ECONNREFUSED)' }
      ])
      expect(JSON.stringify(attempts)).not.toContain('secret-path-token')
    })
  })

  describe('the address check', () => {
    it('refuses a private target on every attempt, without connecting', async () => {
      const { processor, attempts } = setup({
        env: { WEBHOOK_PRIVATE_HOST_ALLOWLIST: '' },
        webhooks: [webhook({ url: `http://${LOOPBACK}:${port}/in` })]
      })

      await expect(processor.process(job())).rejects.toBeInstanceOf(DeliveryAttemptFailed)
      await expect(processor.process(job({ attemptsMade: 1 }))).rejects.toBeInstanceOf(
        DeliveryAttemptFailed
      )

      expect(received).toHaveLength(0)
      expect(attempts.map(attempt => attempt.error)).toEqual([
        'The URL is not allowed: the host does not resolve to a public address',
        'The URL is not allowed: the host does not resolve to a public address'
      ])
    })

    // DNS rebinding: `localhost` really is the loopback, so a name that was public at the check
    // would be too at the connection if the socket resolved it again
    it('does not follow a name to a private address after the check', async () => {
      const { processor } = setup({
        env: { WEBHOOK_PRIVATE_HOST_ALLOWLIST: '' },
        webhooks: [webhook({ url: `http://localhost:${port}/in` })]
      })

      await expect(processor.process(job())).rejects.toBeInstanceOf(DeliveryAttemptFailed)

      expect(received).toHaveLength(0)
    })

    it('applies a URL that changed since the last attempt', async () => {
      const { processor, attempts } = setup({
        env: { WEBHOOK_PRIVATE_HOST_ALLOWLIST: '' },
        webhooks: [webhook({ url: 'http://10.0.0.5/in' }), webhook({ url: 'http://8.8.8.8:1/in' })]
      })

      await expect(processor.process(job())).rejects.toBeInstanceOf(DeliveryAttemptFailed)
      expect(attempts[0]?.error).toContain('not allowed')
      await expect(processor.process(job({ attemptsMade: 1 }))).rejects.toBeInstanceOf(
        DeliveryAttemptFailed
      )

      // The second attempt went to the new URL (nothing listens there) and not to the old one
      expect(attempts[1]?.error).not.toContain('not allowed')
    })
  })

  describe('what is read at each attempt', () => {
    it('signs a retry with the secret the webhook has now', async () => {
      answer = index => ({ status: index === 0 ? 500 : 200 })
      const { processor } = setup({ webhooks: [webhook(), webhook({ secret: 'whsec_rotated' })] })

      await expect(processor.process(job())).rejects.toThrow()
      await processor.process(job({ attemptsMade: 1 }))

      const [first, second] = received as [Received, Received]
      const sign = (secret: string, request: Received): string =>
        signWebhook(secret, Number(request.headers['x-gateway-timestamp']), request.body)
      expect(first.headers['x-gateway-signature']).toBe(sign(SECRET, first))
      expect(second.headers['x-gateway-signature']).toBe(sign('whsec_rotated', second))
      expect(second.headers['x-gateway-signature']).not.toBe(sign(SECRET, second))
    })

    it('drops the job of a webhook that was deleted, as done', async () => {
      const { processor, attempts, recordAttempt, metrics } = setup({ webhooks: [undefined] })

      await expect(processor.process(job())).resolves.toBe('dropped')

      expect(received).toHaveLength(0)
      expect(recordAttempt).not.toHaveBeenCalled()
      expect(attempts).toEqual([])
      expect(await results(metrics)).toEqual({ dropped: 1 })
    })

    it('fails the read of the webhook so BullMQ retries it', async () => {
      const { processor, require } = setup()
      require.mockRejectedValueOnce(new Error('database down'))

      await expect(processor.process(job())).rejects.toThrow('database down')
      expect(received).toHaveLength(0)
    })
  })

  describe('a webhook that is disabled', () => {
    it('does not send an event, and leaves the delivery as a dead letter that can be retried', async () => {
      const { processor, failUnqueued, recordAttempt, metrics } = setup({
        webhooks: [webhook({ enabled: false })]
      })

      await expect(processor.process(job())).resolves.toBe('dropped')

      expect(received).toHaveLength(0)
      expect(recordAttempt).not.toHaveBeenCalled()
      expect(failUnqueued).toHaveBeenCalledWith('d1', 'The webhook is disabled')
      expect(await results(metrics)).toEqual({ dropped: 1 })
    })

    it('still sends a ping, so a receiver can be checked before it is turned on', async () => {
      const { processor } = setup({ webhooks: [webhook({ enabled: false })] })
      const ping = envelope({ event: 'ping', seq: 0, data: {} })

      await expect(
        processor.process(job({ data: { deliveryId: 'd1', webhookId: 'w1', envelope: ping } }))
      ).resolves.toBe('delivered')

      expect(received).toHaveLength(1)
      expect(received[0]?.headers['x-gateway-event']).toBe('ping')
      expect(received[0]?.headers['x-gateway-seq']).toBe('0')
    })
  })

  describe('the delivery row', () => {
    it('delivers a job whose row could not be stored, and records nothing', async () => {
      const { processor, row, recordAttempt, metrics } = setup()
      row.current = null

      await expect(processor.process(job())).resolves.toBe('delivered')

      expect(received).toHaveLength(1)
      expect(recordAttempt).toHaveBeenCalledTimes(1)
      expect(await results(metrics)).toEqual({ success: 1 })
    })

    it('still retries a failure of a job without a row', async () => {
      answer = () => ({ status: 500 })
      const { processor, row } = setup()
      row.current = null

      await expect(processor.process(job())).rejects.toBeInstanceOf(DeliveryAttemptFailed)
    })

    it('never sends a delivery that is already delivered', async () => {
      const { processor, row, recordAttempt } = setup()
      row.current = { id: 'd1', webhookId: 'w1', status: 'success' }

      await expect(processor.process(job())).resolves.toBe('dropped')

      expect(received).toHaveLength(0)
      expect(recordAttempt).not.toHaveBeenCalled()
    })

    // Only the gateway queues jobs, but a job that names one webhook for the delivery of another
    // must not send the event to the first nor write the result on the second
    it('drops a job whose delivery belongs to another webhook', async () => {
      const { processor, row, recordAttempt } = setup()
      row.current = { id: 'd1', webhookId: 'other', status: 'pending' }

      await expect(processor.process(job())).resolves.toBe('dropped')

      expect(received).toHaveLength(0)
      expect(recordAttempt).not.toHaveBeenCalled()
    })

    it('does not retry a delivery that arrived because the row could not be written', async () => {
      const { processor, recordAttempt } = setup()
      recordAttempt.mockRejectedValueOnce(new Error('database down'))

      await expect(processor.process(job())).resolves.toBe('delivered')

      expect(received).toHaveLength(1)
      expect(logged.join('\n')).toContain('could not be recorded')
    })

    describe('writing the result', () => {
      const transient = (): Error => {
        const error = new Error('connection lost')
        error.name = 'TransientDatabaseError'
        return error
      }

      // Full jitter picks a delay in [0, ceiling]: zero keeps the suite fast without faking timers
      beforeEach(() => {
        jest.spyOn(Math, 'random').mockReturnValue(0)
      })

      it('writes again when the first write fails with a transient error, and the job ends well', async () => {
        const { processor, recordAttempt } = setup()
        recordAttempt.mockRejectedValueOnce(transient())

        await expect(processor.process(job())).resolves.toBe('delivered')

        expect(recordAttempt).toHaveBeenCalledTimes(2)
        expect(logged.join('\n')).not.toContain('could not be recorded')
      })

      it('tries three times in all, then gives up without throwing and says only the kind of error', async () => {
        const { processor, recordAttempt } = setup()
        recordAttempt.mockRejectedValue(transient())

        await expect(processor.process(job())).resolves.toBe('delivered')

        expect(recordAttempt).toHaveBeenCalledTimes(3)
        const log = logged.filter(line => line.includes('could not be recorded'))
        expect(log).toHaveLength(1)
        expect(log[0]).toContain('TransientDatabaseError')
        expect(log[0]).not.toContain('connection lost')
      })

      it('does not write again after an error that waiting cannot cure', async () => {
        const { processor, recordAttempt } = setup()
        recordAttempt.mockRejectedValue(new Error('invalid input'))

        await expect(processor.process(job())).resolves.toBe('delivered')

        expect(recordAttempt).toHaveBeenCalledTimes(1)
      })

      it('writes the failure of an attempt again too, and still has BullMQ retry the job', async () => {
        answer = () => ({ status: 500 })
        const { processor, recordAttempt } = setup()
        recordAttempt.mockRejectedValueOnce(transient())

        await expect(processor.process(job())).rejects.toBeInstanceOf(DeliveryAttemptFailed)

        expect(recordAttempt).toHaveBeenCalledTimes(2)
      })

      it('waits less than a second in all, even with the longest pauses', async () => {
        jest.spyOn(Math, 'random').mockReturnValue(0.999999)
        const { processor, recordAttempt } = setup()
        recordAttempt.mockRejectedValue(transient())
        // The pauses are recorded, not slept: a measure of the real clock would count the load of the
        // machine as waiting
        const pauses: number[] = []
        const realRetry = jest.requireActual<typeof retryModule>('../common/lib/retry.js').retry
        jest.spyOn(retryModule, 'retry').mockImplementation((operation, options) =>
          realRetry(operation, {
            ...options,
            sleep: ms => {
              pauses.push(ms)
              return Promise.resolve()
            }
          })
        )

        await processor.process(job())

        expect(recordAttempt).toHaveBeenCalledTimes(3)
        expect(pauses).toEqual([100, 200])
        expect(pauses.reduce((total, ms) => total + ms, 0)).toBeLessThan(1000)
      })
    })

    it('reports the failure even when the row cannot be written', async () => {
      answer = () => ({ status: 500 })
      const { processor, recordAttempt } = setup()
      recordAttempt.mockRejectedValueOnce(new Error('database down'))

      await expect(processor.process(job())).rejects.toBeInstanceOf(DeliveryAttemptFailed)
    })

    it('does not touch the sequence of the session', async () => {
      const { processor } = setup()
      const ping = envelope({ event: 'ping', seq: 0, data: {} })

      await processor.process(job({ data: { deliveryId: 'd1', webhookId: 'w1', envelope: ping } }))

      // The processor has no handle on the counter of the session: a ping carries seq 0 as is
      expect(JSON.parse((received[0] as Received).body)).toMatchObject({ event: 'ping', seq: 0 })
    })
  })

  describe('events stored without their credential', () => {
    it.each([
      ['qr', { qr: REDACTED }],
      ['code', { code: REDACTED }]
    ])('does not send a %s that carries only the redaction', async (name, data) => {
      const { processor, failUnqueued } = setup()

      await expect(
        processor.process(
          job({
            data: { deliveryId: 'd1', webhookId: 'w1', envelope: envelope({ event: name, data }) }
          })
        )
      ).resolves.toBe('dropped')

      expect(received).toHaveLength(0)
      expect(failUnqueued).toHaveBeenCalledWith('d1', expect.stringContaining('credential'))
    })

    it('sends the real qr of an automatic retry', async () => {
      const { processor } = setup()

      await processor.process(
        job({
          data: {
            deliveryId: 'd1',
            webhookId: 'w1',
            envelope: envelope({ event: 'qr', data: { qr: '2@real-qr-payload' } })
          }
        })
      )

      expect(received).toHaveLength(1)
    })
  })

  describe('a job that is not a delivery', () => {
    it.each([
      ['no webhook', { deliveryId: 'd1', envelope: envelope() }],
      ['no envelope', { deliveryId: 'd1', webhookId: 'w1' }],
      ['a string', 'deliver']
    ])('is not retried: %s', async (_label, data) => {
      const { processor } = setup()

      await expect(processor.process(job({ data }))).rejects.toBeInstanceOf(UnrecoverableError)
      expect(received).toHaveLength(0)
    })
  })

  describe('what the logs and the row may say', () => {
    it('never writes the secret, the signature, the URL or the payload', async () => {
      answer = () => ({ status: 500 })
      const { processor, attempts } = setup({
        webhooks: [webhook({ url: `http://${LOOPBACK}:${port}/hook/path-token-123` })]
      })

      await expect(processor.process(job())).rejects.toThrow()
      const signature = (received[0] as Received).headers['x-gateway-signature'] as string

      const everything = JSON.stringify([logged, attempts])
      for (const secretThing of [
        SECRET,
        signature,
        signature.slice(7),
        'path-token-123',
        SENTINEL
      ]) {
        expect(everything).not.toContain(secretThing)
      }
    })
  })

  describe('the worker', () => {
    const start = (options: Parameters<typeof setup>[0] = {}) => {
      const ctx = setup(options)
      ctx.processor.onModuleInit()
      const worker = workers[0]
      if (worker === undefined) throw new Error('no worker was created')
      return { ...ctx, worker }
    }

    it('takes the deliveries of the queue with the configured concurrency and a lock longer than a request', () => {
      const { worker } = start({
        env: { WEBHOOK_WORKER_CONCURRENCY: '4', WEBHOOK_TIMEOUT_MS: '60000' }
      })

      expect(worker.name).toBe('webhook-deliveries')
      expect(worker.options['concurrency']).toBe(4)
      expect(worker.options['lockDuration']).toBeGreaterThan(60000)
      expect(worker.options['connection']).toEqual({})
    })

    it('keeps the default lock for the default timeout', () => {
      const { worker } = start()

      expect(worker.options['lockDuration']).toBeGreaterThanOrEqual(30000)
    })

    it('sends the last failure to the dead letters even when the attempt could not record it', () => {
      const { worker, failUnqueued } = start()
      const onFailed = worker.handlers.get('failed') as (j: unknown, e: Error) => void

      onFailed(
        { ...job({ attemptsMade: 3, attempts: 3 }), id: '1' },
        new Error('job stalled more than allowable limit')
      )

      expect(failUnqueued).toHaveBeenCalledWith('d1', 'The delivery could not be completed')
    })

    it('leaves a failure that will be retried alone', () => {
      const { worker, failUnqueued } = start()
      const onFailed = worker.handlers.get('failed') as (j: unknown, e: Error) => void

      onFailed({ ...job({ attemptsMade: 1, attempts: 3 }), id: '1' }, new Error('x'))

      expect(failUnqueued).not.toHaveBeenCalled()
    })

    it('survives a failure with no job and a row that cannot be updated', async () => {
      const { worker, failUnqueued } = start()
      const onFailed = worker.handlers.get('failed') as (j: unknown, e: Error) => void
      failUnqueued.mockRejectedValueOnce(new Error('database down'))

      onFailed(undefined, new Error('x'))
      onFailed(job({ attemptsMade: 3, attempts: 3 }), new Error('x'))
      // The handler does not return its work: let it finish, and see that nothing was left unhandled
      await new Promise(resolve => setImmediate(resolve))

      expect(failUnqueued).toHaveBeenCalledTimes(1)
      expect(logged.join('\n')).toContain('could not be marked failed')
    })

    it('logs the errors of the worker, which would otherwise be uncaught', () => {
      const { worker } = start()
      const onError = worker.handlers.get('error') as (e: Error) => void

      onError(new Error('redis down'))

      expect(logged.join('\n')).toContain('redis down')
    })

    it('closes the worker when the module is destroyed', async () => {
      const { processor } = start()

      await processor.onModuleDestroy()

      expect(workerClose).toHaveBeenCalledTimes(1)
    })

    it('forces the close when the job in hand does not finish', async () => {
      jest.useFakeTimers()
      try {
        const { processor } = start()
        workerClose.mockImplementationOnce(() => new Promise<void>(() => undefined))

        const closing = processor.onModuleDestroy()
        await jest.advanceTimersByTimeAsync(60_000)
        await closing

        expect(workerClose).toHaveBeenLastCalledWith(true)
      } finally {
        jest.useRealTimers()
      }
    })

    it('warns at start when the address check is lifted', () => {
      start({ env: { ALLOW_PRIVATE_WEBHOOK_TARGETS: 'true' } })

      expect(logged.join('\n')).toContain('ALLOW_PRIVATE_WEBHOOK_TARGETS')
    })

    it('does not warn when the address check is on', () => {
      start()

      expect(logged.join('\n')).not.toContain('ALLOW_PRIVATE_WEBHOOK_TARGETS')
    })
  })
})
