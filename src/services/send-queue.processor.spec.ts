import { FakeWhatsAppClient } from '../../tests/helpers/fake-whatsapp-client.js'
import { ConflictError } from '../common/errors.js'
import type { PolicyDecision } from '../types/send-policy.dto.js'
import { WaDisconnectedError, WaOperationError, WaTimeoutError } from '../whatsapp/wa-errors.js'

import type { SendJobData } from './send-queue.job.js'
import {
  SendJobYield,
  SendJobProcessor,
  type SendJobDependencies,
  type SendJobHooks
} from './send-queue.processor.js'

const ALLOW: PolicyDecision = { decision: 'allow' }
const CHAT = '5215500000002@c.us'

const CONFIG: SendJobDependencies['config'] = {
  SEND_MIN_INTERVAL_MS: 0,
  SEND_JITTER_MS: 0,
  SEND_MAX_WAIT_MS: 300_000,
  SEND_NOT_READY_RETRY_MS: 50,
  HUMANIZE_MIN_REPLY_DELAY_MS: 0
}

const job = (overrides: Partial<SendJobData> = {}): SendJobData => ({
  sessionId: 's1',
  chatId: CHAT,
  content: { type: 'text', body: 'hola' },
  enqueuedAt: Date.now(),
  ...overrides
})

describe('SendJobProcessor', () => {
  let client: FakeWhatsAppClient
  let ready: boolean
  let admit: jest.MockedFunction<SendJobDependencies['policy']['admit']>
  let hooks: { markDispatched: jest.Mock; clearDispatched: jest.Mock } & SendJobHooks
  let signal: AbortController

  const build = (config: Partial<SendJobDependencies['config']> = {}): SendJobProcessor =>
    new SendJobProcessor('s1', {
      config: { ...CONFIG, ...config },
      requireReady: () => {
        if (!ready) throw new ConflictError('SESSION_NOT_READY', 'not ready')
        return client
      },
      policy: { admit },
      random: () => 0.5
    })

  beforeEach(() => {
    client = new FakeWhatsAppClient('s1')
    ready = true
    admit = jest.fn<ReturnType<typeof admit>, Parameters<typeof admit>>().mockResolvedValue(ALLOW)
    hooks = { markDispatched: jest.fn(), clearDispatched: jest.fn() }
    signal = new AbortController()
  })

  const run = (processor: SendJobProcessor, data: SendJobData = job()) =>
    processor.run(data, hooks, signal.signal)

  describe('a plain send', () => {
    it('marks the dispatch, sends and reports the message', async () => {
      const result = await run(build())

      expect(result.outcome.ok).toBe(true)
      expect(result.hardFailure).toBe(false)
      expect(hooks.markDispatched).toHaveBeenCalledTimes(1)
      expect(client.callsOf('sendMessage')).toHaveLength(1)
      expect(admit.mock.calls[0]?.[0]).toMatchObject({
        sessionId: 's1',
        chatId: CHAT,
        body: 'hola'
      })
    })

    it('passes the caption of a media send to the policy as its body', async () => {
      const media = { type: 'media', media: { mimetype: 'image/png', data: 'AA==' } } as const
      await run(build(), job({ content: media, options: { caption: 'una foto' } }))

      expect(admit).toHaveBeenCalledWith(expect.objectContaining({ body: 'una foto' }))
    })

    it('turns an event start time back into a Date after the trip through Redis', async () => {
      const content = JSON.parse(
        JSON.stringify({ type: 'event', name: 'x', startTime: new Date(1_000) })
      ) as SendJobData['content']
      await run(build(), job({ content }))

      const [, sent] = client.callsOf('sendMessage')[0]?.args ?? []
      expect(sent).toEqual(expect.objectContaining({ startTime: new Date(1_000) }))
    })

    it('forwards a message through the port and reports success without a message', async () => {
      const result = await run(
        build(),
        job({ content: { type: 'forward', messageId: 'm-1' }, chatId: '5215500000009@c.us' })
      )

      expect(result).toEqual({ outcome: { ok: true }, hardFailure: false })
      expect(client.callsOf('forwardMessage')[0]?.args).toEqual(['m-1', '5215500000009@c.us'])
      expect(client.callsOf('sendMessage')).toHaveLength(0)
      expect(hooks.markDispatched).toHaveBeenCalledTimes(1)
    })

    it('ends a forward whose outcome is unknown as UNKNOWN_OUTCOME, marked first and never retried', async () => {
      const order: string[] = []
      hooks.markDispatched.mockImplementation(() => order.push('mark'))
      client.script('forwardMessage', () => {
        order.push('forward')
        throw new Error('page crashed')
      })
      const result = await run(build(), job({ content: { type: 'forward', messageId: 'm-1' } }))

      expect(result.outcome).toMatchObject({ ok: false, error: { code: 'UNKNOWN_OUTCOME' } })
      expect(result.hardFailure).toBe(true)
      expect(order).toEqual(['mark', 'forward'])
      expect(hooks.clearDispatched).not.toHaveBeenCalled()
    })

    it('reports a forward WhatsApp refused with its own code, as a hard failure', async () => {
      client.failNext('forwardMessage', new WaOperationError('forwardMessage', 'not allowed'))
      const result = await run(build(), job({ content: { type: 'forward', messageId: 'm-1' } }))

      expect(result.outcome).toMatchObject({ ok: false, error: { code: 'WHATSAPP_ERROR' } })
      expect(result.hardFailure).toBe(true)
    })

    it('counts an ack of -1 as a hard failure of a message that did go out', async () => {
      client.script('sendMessage', () => ({ ...client.sent[0], ack: -1 }) as never)
      const result = await run(build())

      expect(result.hardFailure).toBe(true)
    })
  })

  describe('a job that may have been sent already', () => {
    it('ends as UNKNOWN_OUTCOME without calling WhatsApp', async () => {
      const result = await run(build(), job({ dispatchedAt: Date.now() - 1000 }))

      expect(result).toMatchObject({
        outcome: { ok: false, error: { code: 'UNKNOWN_OUTCOME' } },
        // A stale mark is not a fault of WhatsApp: it must not feed the throttle or the breaker
        hardFailure: false
      })
      expect(client.callsOf('sendMessage')).toHaveLength(0)
      expect(admit).not.toHaveBeenCalled()
    })
  })

  describe('the send policy', () => {
    it('turns a rejection into a failure that names the rule', async () => {
      admit.mockResolvedValue({
        decision: 'reject',
        code: 'POLICY_BLOCKED',
        rule: 'cold_sends_disabled'
      })
      const result = await run(build())

      expect(result).toMatchObject({
        outcome: {
          ok: false,
          error: { code: 'POLICY_BLOCKED', details: { rule: 'cold_sends_disabled' } }
        },
        hardFailure: false
      })
      expect(client.callsOf('sendMessage')).toHaveLength(0)
    })

    it('waits out a delay in place and asks again, so the order of the queue holds', async () => {
      admit
        .mockResolvedValueOnce({ decision: 'delay', delayMs: 20, rule: 'session_per_minute' })
        .mockResolvedValueOnce(ALLOW)
      const result = await run(build())

      expect(result.outcome.ok).toBe(true)
      expect(admit).toHaveBeenCalledTimes(2)
    })
  })

  describe('a session that is not ready', () => {
    it('waits until it is ready and then sends', async () => {
      ready = false
      setTimeout(() => (ready = true), 80)
      const result = await run(build())

      expect(result.outcome.ok).toBe(true)
    })

    it('gives up with SESSION_NOT_READY after SEND_MAX_WAIT_MS from the moment it was queued', async () => {
      ready = false
      const result = await run(
        build({ SEND_MAX_WAIT_MS: 100 }),
        job({ enqueuedAt: Date.now() - 200 })
      )

      expect(result.outcome).toMatchObject({ ok: false, error: { code: 'SESSION_NOT_READY' } })
      expect(result.hardFailure).toBe(false)
    })

    it('fails with NOT_FOUND when the session no longer exists', async () => {
      const { NotFoundError } = await import('../common/errors.js')
      const processor = new SendJobProcessor('s1', {
        config: CONFIG,
        requireReady: () => {
          throw new NotFoundError('NOT_FOUND', 'gone')
        },
        policy: { admit }
      })
      const result = await processor.run(job(), hooks, signal.signal)

      expect(result.outcome).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    })
  })

  describe('errors from the send', () => {
    it('retries a failure proven to be before the dispatch and clears the mark', async () => {
      client.failNext('sendMessage', new WaDisconnectedError('sendMessage', false))
      const result = await run(build())

      expect(result.outcome.ok).toBe(true)
      expect(hooks.clearDispatched).toHaveBeenCalledTimes(1)
      expect(client.callsOf('sendMessage')).toHaveLength(2)
    })

    it('stops retrying a pre-dispatch failure once the job is out of time', async () => {
      client.failNext('sendMessage', new WaTimeoutError('sendMessage', false), 5)
      const result = await run(
        build({ SEND_MAX_WAIT_MS: 100 }),
        job({ enqueuedAt: Date.now() - 200 })
      )

      expect(result.outcome).toMatchObject({ ok: false, error: { code: 'WHATSAPP_TIMEOUT' } })
    })

    it.each([
      ['a timeout after the dispatch', new WaTimeoutError('sendMessage', true)],
      ['a disconnection with the call in flight', new WaDisconnectedError('sendMessage', true)]
    ])('is UNKNOWN_OUTCOME and never retried after %s', async (_name, error) => {
      client.failNext('sendMessage', error)
      const result = await run(build())

      expect(result).toMatchObject({
        outcome: { ok: false, error: { code: 'UNKNOWN_OUTCOME' } },
        hardFailure: true
      })
      expect(client.callsOf('sendMessage')).toHaveLength(1)
    })

    it('treats an error nobody expected after the dispatch as an unknown outcome', async () => {
      client.script('sendMessage', () => {
        throw new TypeError('boom')
      })
      const result = await run(build())

      expect(result.outcome).toMatchObject({ ok: false, error: { code: 'UNKNOWN_OUTCOME' } })
    })

    it('reports a failure WhatsApp gave as a hard failure with its own code', async () => {
      client.failNext('sendMessage', new WaOperationError('sendMessage', 'rejected'))
      const result = await run(build())

      expect(result).toMatchObject({
        outcome: { ok: false, error: { code: 'WHATSAPP_ERROR' } },
        hardFailure: true
      })
    })

    it('lets a failure of the queue itself reach the worker instead of reporting a send', async () => {
      hooks.markDispatched.mockRejectedValue(new Error('redis down'))

      await expect(run(build())).rejects.toThrow('redis down')
      expect(client.callsOf('sendMessage')).toHaveLength(0)
    })
  })

  describe('a failure before the dispatch mark', () => {
    it('retries a typing failure even when it says it was dispatched, because no message was', async () => {
      client.failNext('sendChatState', new WaTimeoutError('sendChatState', true))
      const pending = run(build(), job({ humanize: { typing: 30 } }))
      const result = await pending

      expect(result.outcome.ok).toBe(true)
      expect(client.callsOf('sendMessage')).toHaveLength(1)
    })

    it('reports a typing failure of WhatsApp as a failure, never as UNKNOWN_OUTCOME', async () => {
      client.failNext('sendChatState', new WaOperationError('sendChatState', 'no'))
      const result = await run(build(), job({ humanize: { typing: 30 } }))

      expect(result.outcome).toMatchObject({ ok: false, error: { code: 'WHATSAPP_ERROR' } })
      expect(client.callsOf('sendMessage')).toHaveLength(0)
    })
  })

  describe('retrying a failure proven to be before the dispatch', () => {
    beforeEach(() => jest.useFakeTimers())
    afterEach(() => jest.useRealTimers())

    it('waits SEND_NOT_READY_RETRY_MS first, so a broken client is not hammered', async () => {
      client.failNext('sendMessage', new WaDisconnectedError('sendMessage', false))
      const pending = run(build())
      await jest.advanceTimersByTimeAsync(49)
      expect(client.callsOf('sendMessage')).toHaveLength(1)
      await jest.advanceTimersByTimeAsync(1)
      await pending
      expect(client.callsOf('sendMessage')).toHaveLength(2)
    })
  })

  describe('pacing', () => {
    beforeEach(() => jest.useFakeTimers())
    afterEach(() => jest.useRealTimers())

    it('keeps SEND_MIN_INTERVAL_MS plus the jitter between two sends of the session', async () => {
      const processor = build({ SEND_MIN_INTERVAL_MS: 1000, SEND_JITTER_MS: 400 })
      await run(processor)

      const second = run(processor)
      await jest.advanceTimersByTimeAsync(1199)
      expect(client.callsOf('sendMessage')).toHaveLength(1)
      await jest.advanceTimersByTimeAsync(1)
      await second
      expect(client.callsOf('sendMessage')).toHaveLength(2)
    })
  })

  describe('humanize', () => {
    beforeEach(() => jest.useFakeTimers())
    afterEach(() => jest.useRealTimers())

    it('marks the chat as seen, types for the given time, clears the state and then sends', async () => {
      const pending = run(build(), job({ humanize: { typing: 1500, markSeenFirst: true } }))
      await jest.advanceTimersByTimeAsync(1500)
      await pending

      expect(client.calls.map(call => call.method)).toEqual([
        'sendSeen',
        'sendChatState',
        'sendChatState',
        'sendMessage'
      ])
      expect(client.callsOf('sendChatState').map(call => call.args[1])).toEqual(['typing', 'clear'])
    })

    it('records instead of typing, and renews a long state every 20 s', async () => {
      const pending = run(build(), job({ humanize: { typing: 45_000, recording: true } }))
      await jest.advanceTimersByTimeAsync(45_000)
      await pending

      expect(client.callsOf('sendChatState').map(call => call.args[1])).toEqual([
        'recording',
        'recording',
        'recording',
        'clear'
      ])
    })

    it('waits at least HUMANIZE_MIN_REPLY_DELAY_MS before a reply', async () => {
      const pending = run(
        build({ HUMANIZE_MIN_REPLY_DELAY_MS: 1500 }),
        job({ humanize: { typing: 100 } })
      )
      await jest.advanceTimersByTimeAsync(1499)
      expect(client.callsOf('sendMessage')).toHaveLength(0)
      await jest.advanceTimersByTimeAsync(1)
      await pending
      expect(client.callsOf('sendMessage')).toHaveLength(1)
    })

    it('replaces HUMANIZE_MIN_REPLY_DELAY_MS with the minimum pause of the job, shorter or longer', async () => {
      const shorter = run(
        build({ HUMANIZE_MIN_REPLY_DELAY_MS: 1500 }),
        job({ humanize: { typing: 100, minReplyDelayMs: 300 } })
      )
      await jest.advanceTimersByTimeAsync(299)
      expect(client.callsOf('sendMessage')).toHaveLength(0)
      await jest.advanceTimersByTimeAsync(1)
      await shorter
      expect(client.callsOf('sendMessage')).toHaveLength(1)

      const longer = run(
        build({ HUMANIZE_MIN_REPLY_DELAY_MS: 1500 }),
        job({ humanize: { typing: 100, minReplyDelayMs: 3000 } })
      )
      await jest.advanceTimersByTimeAsync(2999)
      expect(client.callsOf('sendMessage')).toHaveLength(1)
      await jest.advanceTimersByTimeAsync(1)
      await longer
      expect(client.callsOf('sendMessage')).toHaveLength(2)
    })

    it('still sends when marking the chat as seen fails', async () => {
      client.failNext('sendSeen', new WaOperationError('sendSeen', 'no'))
      const pending = run(build(), job({ humanize: { typing: 0, markSeenFirst: true } }))
      await jest.advanceTimersByTimeAsync(1)
      const result = await pending

      expect(result.outcome.ok).toBe(true)
    })

    it('clears the typing state when the wait is interrupted by a shutdown', async () => {
      const pending = run(build(), job({ humanize: { typing: 5000 } }))
      const outcome = expect(pending).rejects.toBeInstanceOf(SendJobYield)
      await jest.advanceTimersByTimeAsync(100)
      signal.abort()
      await outcome

      expect(client.callsOf('sendChatState').map(call => call.args[1])).toEqual(['typing', 'clear'])
      expect(client.callsOf('sendMessage')).toHaveLength(0)
    })
  })

  describe('a shutdown while the job waits', () => {
    it('yields with the time already waited, so the job goes back to the queue', async () => {
      ready = false
      const pending = run(build(), job({ waitedMs: 1000 }))
      const outcome = pending.then(
        () => undefined,
        (error: unknown) => error
      )
      signal.abort()

      const error = await outcome
      expect(error).toBeInstanceOf(SendJobYield)
      expect((error as SendJobYield).waitedMs).toBeGreaterThanOrEqual(1000)
    })
  })
})
