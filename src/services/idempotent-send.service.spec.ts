import { buildMessageDto } from '../../tests/helpers/fake-whatsapp-client.js'
import { NotFoundError, UnprocessableError } from '../common/errors.js'
import type { IdempotencyKey } from '../database/models.js'
import type {
  ClaimResult,
  IdempotencyOutcome,
  IdempotencyRepository
} from '../database/repositories/idempotency.repository.js'

import { IdempotentSendService, STALE_PENDING_MS } from './idempotent-send.service.js'
import {
  outcomeToJson,
  type NewSendJob,
  type SendJobOutcome,
  type SendJobStatus
} from './send-queue.job.js'
import type { SendQueueService, SubmitResult } from './send-queue.service.js'

const SESSION = 'sales'
const CHAT = '5215512345678@c.us'

const job = (body: string, idempotencyKey?: string): NewSendJob => ({
  sessionId: SESSION,
  chatId: CHAT,
  content: { type: 'text', body },
  ...(idempotencyKey === undefined ? {} : { idempotencyKey })
})

// The rules of the real repository that the flow relies on: one claim wins, a key ends once
class FakeKeys {
  readonly rows = new Map<string, IdempotencyKey>()
  released: string[] = []

  claim = jest.fn((sessionId: string, key: string, requestHash: string): Promise<ClaimResult> => {
    const existing = this.rows.get(`${sessionId}/${key}`)
    if (existing) return Promise.resolve({ claimed: false, existing: { ...existing } })
    this.rows.set(`${sessionId}/${key}`, {
      sessionId,
      key,
      requestHash,
      messageId: null,
      status: 'pending',
      response: null,
      createdAt: new Date()
    })
    return Promise.resolve({ claimed: true })
  })

  find = jest.fn((sessionId: string, key: string): Promise<IdempotencyKey | null> => {
    const existing = this.rows.get(`${sessionId}/${key}`)
    return Promise.resolve(existing ? { ...existing } : null)
  })

  complete = jest.fn((sessionId: string, key: string, outcome: IdempotencyOutcome) =>
    this.finish(sessionId, key, 'done', outcome)
  )

  fail = jest.fn((sessionId: string, key: string, outcome: IdempotencyOutcome) =>
    this.finish(sessionId, key, 'failed', outcome)
  )

  release = jest.fn((sessionId: string, key: string) => {
    this.released.push(key)
    if (this.rows.get(`${sessionId}/${key}`)?.status !== 'pending') return Promise.resolve(false)
    return Promise.resolve(this.rows.delete(`${sessionId}/${key}`))
  })

  private finish(
    sessionId: string,
    key: string,
    status: 'done' | 'failed',
    outcome: IdempotencyOutcome
  ): Promise<boolean> {
    const row = this.rows.get(`${sessionId}/${key}`)
    if (!row || row.status !== 'pending') return Promise.resolve(false)
    Object.assign(row, { status, messageId: outcome.messageId ?? null, response: outcome.response })
    return Promise.resolve(true)
  }

  asRepository(): IdempotencyRepository {
    return this as unknown as IdempotencyRepository
  }
}

describe('IdempotentSendService', () => {
  const sent: SendJobOutcome = { ok: true, message: buildMessageDto({ id: 'm1' }) }
  let keys: FakeKeys
  let submit: jest.Mock<Promise<SubmitResult>, [NewSendJob, { waitMs?: number; jobId?: string }]>
  let status: jest.Mock<Promise<SendJobStatus>, [string, string]>
  let service: IdempotentSendService

  beforeEach(() => {
    keys = new FakeKeys()
    submit = jest.fn<Promise<SubmitResult>, [NewSendJob, { waitMs?: number; jobId?: string }]>()
    submit.mockResolvedValue({ jobId: 'job-1', outcome: sent })
    status = jest.fn<Promise<SendJobStatus>, [string, string]>()
    service = new IdempotentSendService(keys.asRepository(), {
      submit,
      status
    } as unknown as SendQueueService)
  })

  it('queues a send without a key straight away and never touches the table', async () => {
    const result = await service.send(job('hola'), { waitMs: 100 })

    expect(result).toEqual({ jobId: 'job-1', outcome: sent, replayed: false })
    expect(submit).toHaveBeenCalledWith(job('hola'), { waitMs: 100 })
    expect(keys.claim).not.toHaveBeenCalled()
  })

  it('claims the key and queues the send under an id that follows from the key', async () => {
    const first = await service.send(job('hola', 'k1'))
    await service.send(job('hola', 'k2'))

    expect(first.replayed).toBe(false)
    const [firstCall, secondCall] = submit.mock.calls
    expect(firstCall?.[1].jobId).toMatch(/^idem-[0-9a-f]{32}$/)
    expect(secondCall?.[1].jobId).not.toBe(firstCall?.[1].jobId)
  })

  describe('replay', () => {
    it('gives back the stored result of a finished send and queues nothing', async () => {
      await service.send(job('hola', 'k1'))
      await keys.complete(SESSION, 'k1', {
        messageId: 'm1',
        response: outcomeToJson(sent)
      })
      submit.mockClear()

      const replay = await service.send(job('hola', 'k1'))

      expect(replay).toMatchObject({ replayed: true, outcome: { ok: true } })
      expect(replay.jobId).toBe((await service.send(job('hola', 'k1'))).jobId)
      expect(submit).not.toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
    })

    it('gives back the stored failure instead of sending again', async () => {
      await service.send(job('hola', 'k1'))
      const failed: SendJobOutcome = { ok: false, error: { code: 'POLICY_BLOCKED', message: 'no' } }
      await keys.fail(SESSION, 'k1', { response: outcomeToJson(failed) })
      submit.mockClear()

      await expect(service.send(job('hola', 'k1'))).resolves.toMatchObject({
        replayed: true,
        outcome: failed
      })
      expect(submit).not.toHaveBeenCalled()
    })

    it('treats a request that differs only in the order of its keys as the same', async () => {
      await service.send(job('hola', 'k1'))
      const reordered: NewSendJob = {
        idempotencyKey: 'k1',
        content: { body: 'hola', type: 'text' },
        chatId: CHAT,
        sessionId: SESSION
      }
      status.mockResolvedValue({ jobId: 'x', status: 'queued' })

      await expect(service.send(reordered)).resolves.toMatchObject({ replayed: true })
    })

    it('answers with the job while it is queued or active, without waiting or queueing', async () => {
      await service.send(job('hola', 'k1'))
      submit.mockClear()
      status.mockResolvedValue({ jobId: 'x', status: 'active' })

      const replay = await service.send(job('hola', 'k1'), { waitMs: 100 })

      expect(replay).toMatchObject({ replayed: true })
      expect(replay.outcome).toBeUndefined()
      expect(submit).not.toHaveBeenCalled()
    })

    it('ends the key when the job ended but the key did not hear about it', async () => {
      await service.send(job('hola', 'k1'))
      status.mockResolvedValue({
        jobId: 'x',
        status: 'sent',
        message: buildMessageDto({ id: 'm1' })
      })

      await expect(service.send(job('hola', 'k1'))).resolves.toMatchObject({
        replayed: true,
        outcome: { ok: true }
      })
      expect(keys.rows.get(`${SESSION}/k1`)).toMatchObject({ status: 'done', messageId: 'm1' })
    })
  })

  describe('a send that ends without a message (a forward)', () => {
    it('ends the key as done with no message id, and replays the stored result', async () => {
      await service.send(job('hola', 'k1'))
      status.mockResolvedValue({ jobId: 'x', status: 'sent' })

      await expect(service.send(job('hola', 'k1'))).resolves.toEqual({
        jobId: expect.stringMatching(/^idem-/) as unknown,
        replayed: true,
        outcome: { ok: true }
      })
      expect(keys.rows.get(`${SESSION}/k1`)).toMatchObject({ status: 'done', messageId: null })
    })
  })

  describe('peek', () => {
    it('knows nothing of a key that was never used, and claims nothing', async () => {
      await expect(service.peek(SESSION, 'new', 'any-hash')).resolves.toBeUndefined()

      expect(keys.claim).not.toHaveBeenCalled()
      expect(submit).not.toHaveBeenCalled()
    })

    it('answers a finished key with its stored result, without queueing', async () => {
      await service.send(job('hola', 'k1'), { requestHash: 'h1' })
      keys.rows.set(`${SESSION}/k1`, {
        ...(keys.rows.get(`${SESSION}/k1`) as IdempotencyKey),
        status: 'done',
        response: outcomeToJson(sent) as IdempotencyKey['response']
      })
      submit.mockClear()

      await expect(service.peek(SESSION, 'k1', 'h1')).resolves.toMatchObject({
        replayed: true,
        outcome: { ok: true }
      })
      expect(submit).not.toHaveBeenCalled()
    })

    it('refuses the same key with another request hash', async () => {
      await service.send(job('hola', 'k1'), { requestHash: 'h1' })

      await expect(service.peek(SESSION, 'k1', 'h2')).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED'
      })
    })
  })

  describe('a hash given by the caller', () => {
    it('is the one the key is claimed with, instead of the hash of the job', async () => {
      await service.send(job('hola', 'k1'), { requestHash: 'raw-request' })

      expect(keys.claim).toHaveBeenCalledWith(SESSION, 'k1', 'raw-request')
    })

    it('does not reach the queue, which takes only the wait and the job id', async () => {
      await service.send(job('hola', 'k1'), { waitMs: 5, requestHash: 'raw-request' })

      expect(submit.mock.calls[0]?.[1]).toEqual({
        waitMs: 5,
        jobId: expect.stringMatching(/^idem-/) as unknown
      })
    })

    it('makes two resolved jobs the same request when the raw request is the same', async () => {
      await service.send(job('hola', 'k1'), { requestHash: 'same' })
      status.mockResolvedValue({ jobId: 'x', status: 'queued' })

      await expect(
        service.send(job('texto resuelto distinto', 'k1'), { requestHash: 'same' })
      ).resolves.toMatchObject({ replayed: true })
    })
  })

  describe('a stored answer that does not fit the shape of one', () => {
    it('is not trusted: a failure with a code that no longer exists is not replayed as one', async () => {
      await service.send(job('hola', 'k1'))
      keys.rows.set(`${SESSION}/k1`, {
        ...(keys.rows.get(`${SESSION}/k1`) as IdempotencyKey),
        status: 'failed',
        response: { ok: false, error: { code: 'GONE_CODE', message: 'x' } }
      })

      await expect(service.send(job('hola', 'k1'))).resolves.toEqual({
        jobId: expect.stringMatching(/^idem-/) as unknown,
        replayed: true
      })
    })
  })

  describe('conflict', () => {
    it('refuses the same key with another payload as IDEMPOTENCY_KEY_REUSED', async () => {
      await service.send(job('hola', 'k1'))
      submit.mockClear()

      const attempt = service.send(job('otra cosa', 'k1'))

      await expect(attempt).rejects.toBeInstanceOf(UnprocessableError)
      await expect(attempt).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
      expect(submit).not.toHaveBeenCalled()
    })

    it('refuses even after the first send ended', async () => {
      await service.send(job('hola', 'k1'))
      await keys.complete(SESSION, 'k1', {
        messageId: 'm1',
        response: outcomeToJson(sent)
      })

      await expect(service.send(job('otra cosa', 'k1'))).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED'
      })
    })

    it('keeps keys apart per session', async () => {
      await service.send(job('hola', 'k1'))

      const other = await service.send({ ...job('otra cosa', 'k1'), sessionId: 'support' })

      expect(other.replayed).toBe(false)
    })
  })

  describe('a key whose process died', () => {
    const age = (ms: number): void => {
      const row = keys.rows.get(`${SESSION}/k1`)
      if (row) row.createdAt = new Date(Date.now() - ms)
    }

    it('reports UNKNOWN_OUTCOME and never resends once the claim is stale and no job exists', async () => {
      await service.send(job('hola', 'k1'))
      age(STALE_PENDING_MS + 1000)
      status.mockRejectedValue(new NotFoundError('NOT_FOUND', 'gone'))
      submit.mockClear()

      const replay = await service.send(job('hola', 'k1'))

      expect(replay).toMatchObject({
        replayed: true,
        outcome: { ok: false, error: { code: 'UNKNOWN_OUTCOME' } }
      })
      expect(submit).not.toHaveBeenCalled()
      expect(keys.rows.get(`${SESSION}/k1`)?.status).toBe('failed')
      // and it keeps answering the same from then on
      await expect(service.send(job('hola', 'k1'))).resolves.toMatchObject({
        outcome: { error: { code: 'UNKNOWN_OUTCOME' } }
      })
    })

    it('does not call a fresh claim stale: the job may be about to be queued', async () => {
      await service.send(job('hola', 'k1'))
      status.mockRejectedValue(new NotFoundError('NOT_FOUND', 'not yet'))

      const replay = await service.send(job('hola', 'k1'))

      expect(replay).toMatchObject({ replayed: true })
      expect(replay.outcome).toBeUndefined()
      expect(keys.rows.get(`${SESSION}/k1`)?.status).toBe('pending')
    })

    it('lets other errors of the lookup through', async () => {
      await service.send(job('hola', 'k1'))
      status.mockRejectedValue(new Error('redis down'))

      await expect(service.send(job('hola', 'k1'))).rejects.toThrow('redis down')
    })
  })

  describe('a send that fails while it is queued', () => {
    it('releases the key when the session does not exist, so the client can retry with it', async () => {
      submit.mockRejectedValueOnce(new NotFoundError('NOT_FOUND', 'no session'))

      await expect(service.send(job('hola', 'k1'))).rejects.toBeInstanceOf(NotFoundError)

      expect(keys.released).toEqual(['k1'])
      await expect(service.send(job('hola', 'k1'))).resolves.toMatchObject({ replayed: false })
    })

    it('keeps the key pending on any other error, because the job may be in Redis', async () => {
      submit.mockRejectedValueOnce(new Error('redis timeout'))

      await expect(service.send(job('hola', 'k1'))).rejects.toThrow('redis timeout')

      expect(keys.released).toEqual([])
      expect(keys.rows.get(`${SESSION}/k1`)?.status).toBe('pending')
      // another payload under the key is still refused, and the same one is not queued twice
      await expect(service.send(job('otra cosa', 'k1'))).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED'
      })
      status.mockResolvedValue({ jobId: 'x', status: 'queued' })
      submit.mockClear()
      await expect(service.send(job('hola', 'k1'))).resolves.toMatchObject({ replayed: true })
      expect(submit).not.toHaveBeenCalled()
    })

    it('does not mask the error of the queue with the one of the release', async () => {
      submit.mockRejectedValueOnce(new NotFoundError('NOT_FOUND', 'no session'))
      keys.release.mockRejectedValueOnce(new Error('postgres down'))

      await expect(service.send(job('hola', 'k1'))).rejects.toBeInstanceOf(NotFoundError)
    })
  })

  describe('the job id', () => {
    it('is the one the replay looks the job up under', async () => {
      await service.send(job('hola', 'k1'))
      status.mockResolvedValue({ jobId: 'x', status: 'active' })

      await service.send(job('hola', 'k1'))

      const queuedAs = submit.mock.calls[0]?.[1].jobId
      expect(status).toHaveBeenCalledWith(SESSION, queuedAs)
    })

    it('is the same for the same key after a release', async () => {
      submit.mockRejectedValueOnce(new NotFoundError('NOT_FOUND', 'no session'))
      await service.send(job('hola', 'k1')).catch(() => undefined)
      await service.send(job('hola', 'k1'))

      expect(submit.mock.calls[0]?.[1].jobId).toBe(submit.mock.calls[1]?.[1].jobId)
    })

    it('differs between sessions for the same key', async () => {
      await service.send(job('hola', 'k1'))
      await service.send({ ...job('hola', 'k1'), sessionId: 'support' })

      expect(submit.mock.calls[0]?.[1].jobId).not.toBe(submit.mock.calls[1]?.[1].jobId)
    })
  })

  describe('concurrent requests with one key', () => {
    it('queues once and answers the other as a replay', async () => {
      status.mockRejectedValue(new NotFoundError('NOT_FOUND', 'not yet'))

      const [a, b] = await Promise.all([
        service.send(job('hola', 'k1')),
        service.send(job('hola', 'k1'))
      ])

      expect(submit).toHaveBeenCalledTimes(1)
      expect([a.replayed, b.replayed].sort()).toEqual([false, true])
    })
  })

  describe('what makes two requests different', () => {
    const base = (): NewSendJob => ({ ...job('hola', 'k1'), options: { quotedMessageId: 'q1' } })

    it.each<[string, Partial<NewSendJob>]>([
      ['the chat', { chatId: '5215599999999@c.us' }],
      ['the options', { options: { quotedMessageId: 'q2' } }],
      ['the humanize settings', { humanize: { typing: 'auto' } }],
      ['the content', { content: { type: 'text', body: 'adios' } }]
    ])('refuses the same key when %s changes', async (_name, change) => {
      await service.send(base())

      await expect(service.send({ ...base(), ...change })).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED'
      })
    })

    it('takes an option that is absent and one set to undefined as the same', async () => {
      await service.send(job('hola', 'k1'))
      status.mockResolvedValue({ jobId: 'x', status: 'queued' })

      await expect(
        service.send({ ...job('hola', 'k1'), options: undefined, humanize: undefined })
      ).resolves.toMatchObject({ replayed: true })
    })
  })

  describe('more replays', () => {
    it('ends the key as failed when the job ended with an error the key did not hear about', async () => {
      await service.send(job('hola', 'k1'))
      status.mockResolvedValue({
        jobId: 'x',
        status: 'failed',
        error: { code: 'POLICY_BLOCKED', message: 'no' }
      })

      await expect(service.send(job('hola', 'k1'))).resolves.toMatchObject({
        replayed: true,
        outcome: { ok: false, error: { code: 'POLICY_BLOCKED' } }
      })
      expect(keys.rows.get(`${SESSION}/k1`)).toMatchObject({
        status: 'failed',
        response: { ok: false, error: { code: 'POLICY_BLOCKED' } }
      })
    })

    it('returns the stored message intact', async () => {
      await service.send(job('hola', 'k1'))
      await keys.complete(SESSION, 'k1', { messageId: 'm1', response: outcomeToJson(sent) })

      const replay = await service.send(job('hola', 'k1'))

      expect(replay.outcome).toEqual(outcomeToJson(sent))
    })

    it('answers without an outcome when a finished key has no readable response', async () => {
      await service.send(job('hola', 'k1'))
      await keys.complete(SESSION, 'k1', { messageId: 'm1' })

      const replay = await service.send(job('hola', 'k1'))

      expect(replay.replayed).toBe(true)
      expect(replay.outcome).toBeUndefined()
    })

    it('does not call a key lost while its job is still queued, however old the claim', async () => {
      await service.send(job('hola', 'k1'))
      const row = keys.rows.get(`${SESSION}/k1`)
      if (row) row.createdAt = new Date(Date.now() - STALE_PENDING_MS * 2)
      status.mockResolvedValue({ jobId: 'x', status: 'active' })

      const replay = await service.send(job('hola', 'k1'))

      expect(replay.outcome).toBeUndefined()
      expect(keys.rows.get(`${SESSION}/k1`)?.status).toBe('pending')
    })

    it('keeps a claim just under the margin pending and closes one just over it', async () => {
      await service.send(job('hola', 'k1'))
      const row = keys.rows.get(`${SESSION}/k1`)
      status.mockRejectedValue(new NotFoundError('NOT_FOUND', 'gone'))

      if (row) row.createdAt = new Date(Date.now() - (STALE_PENDING_MS - 5000))
      await service.send(job('hola', 'k1'))
      expect(row?.status).toBe('pending')

      if (row) row.createdAt = new Date(Date.now() - (STALE_PENDING_MS + 5000))
      await service.send(job('hola', 'k1'))
      expect(row?.status).toBe('failed')
    })
  })
})
