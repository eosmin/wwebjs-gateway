import { randomUUID } from 'node:crypto'

import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'

import type { SessionsRepository } from '../../src/database/repositories/sessions.repository.js'
import type { RedisService } from '../../src/infra/redis/redis.service.js'
import type { MessageDto } from '../../src/types/dto.js'
import { WaOperationError } from '../../src/whatsapp/wa-errors.js'
import { REAL_ENV, TEST_ENV, setEnv } from '../helpers/env.js'
import {
  FakeWhatsAppClientFactory,
  buildMessageDto,
  type FakeWhatsAppClient
} from '../helpers/fake-whatsapp-client.js'

const ADMIN = { 'x-api-key': TEST_ENV.ADMIN_API_KEY }
const MIB = 1024 * 1024
const PEER = '5215500000001@c.us'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await sleep(10)
  }
}

interface SendBody {
  jobId: string
  status: string
  message?: { id: string; body: string; chatId: string }
  error?: { code: string }
}

// Step 5.5 over the whole application with real Postgres and Redis, and the fake client in place of
// Chromium: every type of message goes through the route, the queue and the worker to the client
describe('messages API (integration)', () => {
  const factory = new FakeWhatsAppClientFactory()
  const id = `msg-${randomUUID().slice(0, 8)}`
  const otherId = `${id}-other`
  // A different number every run: the answer is cached for minutes, and a fixed one would hide the look-up
  const unregistered = `5215${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
  let app: NestFastifyApplication | undefined
  let sessions: SessionsRepository | undefined
  let redis: RedisService | undefined

  const application = (): NestFastifyApplication => {
    if (app === undefined) throw new Error('the application did not boot')
    return app
  }
  const client = (): FakeWhatsAppClient => {
    const found = factory.clientFor(id)
    if (found === undefined) throw new Error('the session did not build a client')
    return found
  }

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object | string,
    headers: Record<string, string> = ADMIN
  ) =>
    application().inject({
      method,
      url,
      headers: {
        ...headers,
        ...(typeof payload === 'string' && { 'content-type': 'application/json' })
      },
      ...(payload !== undefined && { payload })
    })
  const post = (path: string, payload?: object, headers?: Record<string, string>) =>
    call('POST', `/v1/sessions/${id}/${path}`, payload, { ...ADMIN, ...headers })

  const sendCalls = () => client().callsOf('sendMessage')

  beforeAll(async () => {
    const { DATABASE_URL, REDIS_URL } = REAL_ENV
    if (DATABASE_URL === undefined || REDIS_URL === undefined) {
      throw new Error('DATABASE_URL and REDIS_URL are required by the integration suites')
    }
    // A fresh account would be paced like a newborn number, and these tests send to strangers
    setEnv({
      DATABASE_URL,
      REDIS_URL,
      RATE_LIMIT_MAX: '100000',
      ALLOW_COLD_SENDS: 'true',
      WARMUP_DAYS: '0',
      SEND_MIN_INTERVAL_MS: '0',
      SEND_JITTER_MS: '0',
      PER_CHAT_MIN_INTERVAL_MS: '0',
      COLD_SEND_MIN_GAP_MS: '0',
      COLD_SENDS_PER_DAY: '200',
      PER_CHAT_MAX_PER_MINUTE: '60',
      SESSION_MAX_PER_MINUTE: '600',
      SESSION_MAX_PER_HOUR: '10000',
      ALLOW_PRIVATE_WEBHOOK_TARGETS: 'false'
    })
    const { AppModule } = await import('../../src/app.module.js')
    const { createFastifyAdapter } = await import('../../src/infra/logger/fastify-adapter.js')
    const { SessionsRepository } =
      await import('../../src/database/repositories/sessions.repository.js')
    const { RedisService } = await import('../../src/infra/redis/redis.service.js')
    const { WHATSAPP_CLIENT_FACTORY } = await import('../../src/whatsapp/whatsapp-client.port.js')

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WHATSAPP_CLIENT_FACTORY)
      .useValue(factory.create)
      .compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    sessions = app.get(SessionsRepository)
    redis = app.get(RedisService)

    expect((await call('POST', '/v1/sessions', { id })).statusCode).toBe(201)
    expect((await call('POST', `/v1/sessions/${id}/start`)).statusCode).toBe(200)
    client().emit({ event: 'ready', data: {} })
    // Typing before every text would only slow the tests; the humanize tests switch it on
    expect(
      (await call('PATCH', `/v1/sessions/${id}`, { settings: { humanize: { enabled: false } } }))
        .statusCode
    ).toBe(200)
    await until(
      async () =>
        (await call('GET', `/v1/sessions/${id}`)).json<{ status: string }>().status === 'ready'
    )
  })

  afterAll(async () => {
    try {
      await sessions?.delete(id)
      await sessions?.delete(otherId)
      await redis?.client.del(`numid:${unregistered}`)
      const keys = [...((await redis?.client.keys(`*${id}*`)) ?? []), `seq:${id}`]
      await redis?.client.del(...keys)
    } finally {
      await app?.close()
    }
  })

  describe('every type of message reaches the client', () => {
    const cases: [string, object, (content: unknown, options: unknown) => void][] = [
      [
        'text to a phone number',
        { to: '+52 1 55 0000 0001', type: 'text', body: 'hola' },
        content => expect(content).toEqual({ type: 'text', body: 'hola' })
      ],
      [
        'media from base64',
        {
          to: PEER,
          type: 'media',
          source: { base64: Buffer.from('abc').toString('base64'), mimetype: 'image/png' },
          caption: 'foto',
          asDocument: true
        },
        (content, options) => {
          expect(content).toEqual({ type: 'media', media: { mimetype: 'image/png', data: 'YWJj' } })
          expect(options).toMatchObject({ caption: 'foto', sendMediaAsDocument: true })
        }
      ],
      [
        'a location',
        { to: PEER, type: 'location', latitude: 19.43, longitude: -99.13, name: 'Zócalo' },
        content =>
          expect(content).toEqual({
            type: 'location',
            latitude: 19.43,
            longitude: -99.13,
            name: 'Zócalo'
          })
      ],
      [
        'a contact by id',
        { to: PEER, type: 'contact', contactId: '5215500000002@c.us' },
        content => expect(content).toEqual({ type: 'contacts', contactIds: ['5215500000002@c.us'] })
      ],
      [
        'several contacts',
        { to: PEER, type: 'contacts', contactIds: ['5215500000002@c.us', '5215500000003@c.us'] },
        content =>
          expect(content).toEqual({
            type: 'contacts',
            contactIds: ['5215500000002@c.us', '5215500000003@c.us']
          })
      ],
      [
        'a vCard',
        { to: PEER, type: 'contact', vcard: 'BEGIN:VCARD\nVERSION:3.0\nFN:Ana\nEND:VCARD' },
        (content, options) => {
          expect(content).toMatchObject({ type: 'text' })
          expect(options).toMatchObject({ parseVCards: true })
        }
      ],
      [
        'a poll',
        { to: PEER, type: 'poll', name: '¿Cuándo?', options: ['Hoy', 'Mañana'] },
        content =>
          expect(content).toEqual({ type: 'poll', name: '¿Cuándo?', options: ['Hoy', 'Mañana'] })
      ],
      [
        'an event',
        { to: PEER, type: 'event', name: 'Demo', startTime: '2030-02-01T10:00:00.000Z' },
        content =>
          expect(content).toEqual({
            type: 'event',
            name: 'Demo',
            startTime: new Date('2030-02-01T10:00:00.000Z')
          })
      ],
      [
        'a group invite',
        { to: PEER, type: 'groupInvite', inviteCode: 'AbCdEfGhIjKlMn' },
        content =>
          expect(content).toEqual({
            type: 'text',
            body: 'https://chat.whatsapp.com/AbCdEfGhIjKlMn'
          })
      ]
    ]

    it.each(cases)('%s', async (_label, body, check) => {
      const before = sendCalls().length

      const response = await post('messages', body)

      expect(response.statusCode).toBe(201)
      expect(response.json<SendBody>()).toMatchObject({ status: 'sent' })
      expect(sendCalls()).toHaveLength(before + 1)
      const [chatId, content, options] = sendCalls().at(-1)?.args ?? []
      expect(chatId).toBe(PEER)
      check(content, options)
    })

    it('refuses a media URL on the loopback', async () => {
      const response = await post('messages', {
        to: PEER,
        type: 'media',
        source: { url: 'http://127.0.0.1:9/a.png' }
      })

      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    })
  })

  it('refuses a media URL that points at the metadata address, and never calls the client', async () => {
    const before = sendCalls().length

    const response = await post('messages', {
      to: PEER,
      type: 'media',
      source: { url: 'http://169.254.169.254/latest/meta-data' }
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    expect(sendCalls()).toHaveLength(before)
  })

  it('answers NUMBER_NOT_ON_WHATSAPP for an unregistered number, from the cache the second time', async () => {
    client().script('getNumberId', () => null)
    const calls = client().callsOf('getNumberId').length

    const first = await post('messages', { to: unregistered, type: 'text', body: 'hola' })
    const second = await post('messages', { to: unregistered, type: 'text', body: 'hola' })
    client().script('getNumberId', number => `${number}@c.us`)

    expect(first.statusCode).toBe(422)
    expect(first.json()).toMatchObject({ error: { code: 'NUMBER_NOT_ON_WHATSAPP' } })
    expect(first.body).not.toContain(unregistered)
    expect(second.statusCode).toBe(422)
    expect(
      client()
        .callsOf('getNumberId')
        .slice(calls)
        .map(call => call.args[0])
    ).toEqual([unregistered])
  })

  describe('idempotency', () => {
    const key = `key-${randomUUID()}`

    it('answers a repeated request with the first result and sends once', async () => {
      const before = sendCalls().length
      const first = await post(
        'messages',
        { to: PEER, type: 'text', body: 'una vez' },
        { 'idempotency-key': key }
      )
      const second = await post(
        'messages',
        { to: PEER, type: 'text', body: 'una vez' },
        { 'idempotency-key': key }
      )

      expect(first.statusCode).toBe(201)
      expect(second.statusCode).toBe(201)
      expect(second.headers['idempotent-replayed']).toBe('true')
      expect(second.json<SendBody>().message?.id).toBe(first.json<SendBody>().message?.id)
      expect(sendCalls()).toHaveLength(before + 1)
    })

    it('refuses the same key with another request', async () => {
      const response = await post(
        'messages',
        { to: PEER, type: 'text', body: 'otra cosa' },
        { 'idempotency-key': key }
      )

      expect(response.statusCode).toBe(422)
      expect(response.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED' } })
    })

    it('refuses a key longer than 128 characters', async () => {
      const response = await post(
        'messages',
        { to: PEER, type: 'text', body: 'x' },
        { 'idempotency-key': 'k'.repeat(129) }
      )

      expect(response.statusCode).toBe(400)
    })
  })

  it('answers 202 with the job for wait=false, and the job ends as sent', async () => {
    const response = await call('POST', `/v1/sessions/${id}/messages?wait=false`, {
      to: PEER,
      type: 'text',
      body: 'async'
    })

    expect(response.statusCode).toBe(202)
    const { jobId } = response.json<SendBody>()
    await until(async () => {
      const job = await call('GET', `/v1/sessions/${id}/send-jobs/${jobId}`)
      return job.json<SendBody>().status === 'sent'
    })
    const job = await call('GET', `/v1/sessions/${id}/send-jobs/${jobId}`)
    expect(job.json<SendBody>().message?.body).toBe('async')
  })

  it('answers 404 for a job that does not exist', async () => {
    expect((await call('GET', `/v1/sessions/${id}/send-jobs/nope`)).statusCode).toBe(404)
  })

  it('answers the error a failed send ended with', async () => {
    client().failNext('sendMessage', new WaOperationError('sendMessage', 'WhatsApp said no'))

    const response = await post('messages', { to: PEER, type: 'text', body: 'falla' })

    expect(response.statusCode).toBe(502)
    expect(response.json()).toMatchObject({ error: { code: 'WHATSAPP_ERROR' } })
  })

  describe('humanize defaults of the session', () => {
    const setHumanize = (humanize: object) =>
      call('PATCH', `/v1/sessions/${id}`, { settings: { humanize } })

    afterAll(async () => {
      await setHumanize({ enabled: false })
    })

    const states = () =>
      client()
        .callsOf('sendChatState')
        .map(entry => entry.args[1])

    it('types before a text, and not before a media', async () => {
      expect((await setHumanize({ typing: 20, minReplyDelayMs: 0 })).statusCode).toBe(200)
      const before = states().length

      const text = await post('messages', { to: PEER, type: 'text', body: 'con escritura' })
      const afterText = states().slice(before)
      const media = await post('messages', {
        to: PEER,
        type: 'media',
        source: { base64: 'QUJD', mimetype: 'image/png' }
      })

      expect(text.statusCode).toBe(201)
      expect(media.statusCode).toBe(201)

      expect(afterText).toEqual(['typing', 'clear'])
      expect(states().slice(before + afterText.length)).toEqual([])
    })

    it('lets the request switch the typing off', async () => {
      const before = states().length

      const response = await post('messages', {
        to: PEER,
        type: 'text',
        body: 'sin escritura',
        humanize: { enabled: false }
      })

      expect(response.statusCode).toBe(201)
      expect(states().slice(before)).toEqual([])
    })

    it('lets the request replace the defaults', async () => {
      const before = states().length

      const response = await post('messages', {
        to: PEER,
        type: 'text',
        body: 'grabando',
        humanize: { typing: 20, recording: true }
      })

      expect(response.statusCode).toBe(201)
      expect(states().slice(before)).toEqual(['recording', 'clear'])
    })
  })

  describe('bodies the schema refuses before any work', () => {
    const refused = async (body: object) => {
      const calls = client().callsOf('getNumberId').length
      const response = await post('messages', body)
      expect(client().callsOf('getNumberId')).toHaveLength(calls)
      return response
    }

    it('refuses a contact with both or neither of contactId and vcard, without a look-up', async () => {
      const neither = await refused({ to: '5215500000123', type: 'contact' })
      const both = await refused({
        to: '5215500000123',
        type: 'contact',
        contactId: '5215500000002@c.us',
        vcard: 'x'
      })

      expect(neither.statusCode).toBe(400)
      expect(both.statusCode).toBe(400)
    })

    it.each(['to', 'body', 'caption', 'mentionedJidList', 'mimetype'])(
      'refuses extra.%s, which would change what the policy approved, and sends nothing',
      async key => {
        const before = sendCalls().length

        const response = await post('messages', {
          to: PEER,
          type: 'text',
          body: 'hola',
          extra: { [key]: '5215500000999@c.us' }
        })

        expect(response.statusCode).toBe(400)
        expect(sendCalls()).toHaveLength(before)
      }
    )

    it('refuses a media type that is not type/subtype', async () => {
      const response = await refused({
        to: '5215500000123',
        type: 'media',
        source: { base64: 'QUJD', mimetype: 'image/png\r\nx-evil: 1' }
      })

      expect(response.statusCode).toBe(400)
    })
  })

  describe('body limits', () => {
    it('takes a body of several MiB on the send route', async () => {
      const base64 = Buffer.alloc(3 * MIB, 1).toString('base64')

      const response = await post('messages', {
        to: PEER,
        type: 'media',
        source: { base64, mimetype: 'application/pdf' },
        asDocument: true
      })

      expect(response.statusCode).toBe(201)
    })

    it('refuses a body over 40 MiB on the send route with 413', async () => {
      const response = await call('POST', `/v1/sessions/${id}/messages`, 'x'.repeat(41 * MIB))

      expect(response.statusCode).toBe(413)
      expect(response.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } })
    })

    it('refuses a body over 40 MiB on the reply route with 413', async () => {
      const response = await call(
        'POST',
        `/v1/sessions/${id}/messages/m1/reply`,
        'x'.repeat(41 * MIB)
      )

      expect(response.statusCode).toBe(413)
      expect(response.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } })
    })

    it('keeps 1 MiB on the other routes', async () => {
      const response = await call(
        'POST',
        `/v1/sessions/${id}/messages/m1/react`,
        JSON.stringify({ reaction: 'x'.repeat(2 * MIB) })
      )

      expect(response.statusCode).toBe(413)
    })
  })

  describe('authentication comes before a large body', () => {
    const large = 'x'.repeat(2 * MIB)
    const sendLarge = (headers: Record<string, string>, sessionId = id) =>
      application().inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/messages`,
        headers: { 'content-type': 'application/json', ...headers },
        // Not JSON: if the body were read first the answer would be 400
        payload: large
      })

    it('refuses a request without a key', async () => {
      const response = await sendLarge({})

      expect(response.statusCode).toBe(401)
      expect(response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } })
      expect(response.headers['x-request-id']).toBeDefined()
    })

    it('refuses a wrong key', async () => {
      expect((await sendLarge({ 'x-api-key': 'wrong'.repeat(8) })).statusCode).toBe(401)
    })

    it('refuses a key without the send scope, and a key of another session', async () => {
      const reader = await call('POST', '/v1/api-keys', {
        name: 'r',
        sessionId: id,
        scopes: ['read']
      })
      expect((await call('POST', '/v1/sessions', { id: otherId })).statusCode).toBe(201)
      const other = await call('POST', '/v1/api-keys', {
        name: 'o',
        sessionId: otherId,
        scopes: ['send']
      })

      const noScope = await sendLarge({ 'x-api-key': reader.json<{ key: string }>().key })
      const wrongSession = await sendLarge({ 'x-api-key': other.json<{ key: string }>().key })

      expect(noScope.statusCode).toBe(403)
      expect(noScope.json()).toMatchObject({ error: { code: 'INSUFFICIENT_SCOPE' } })
      expect(wrongSession.statusCode).toBe(403)
    })

    it('lets a valid key through to the body, which then fails as JSON', async () => {
      expect((await sendLarge(ADMIN)).statusCode).toBe(400)
    })

    it('leaves a small body to the normal pipeline, which also refuses it without a key', async () => {
      const response = await application().inject({
        method: 'POST',
        url: `/v1/sessions/${id}/messages`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ to: PEER, type: 'text', body: 'x' })
      })

      expect(response.statusCode).toBe(401)
    })
  })

  describe('permissions', () => {
    it('lets a read key read but not send', async () => {
      const created = await call('POST', '/v1/api-keys', {
        name: 'reader',
        sessionId: id,
        scopes: ['read']
      })
      const reader = { 'x-api-key': created.json<{ key: string }>().key }

      const denied = await post('messages', { to: PEER, type: 'text', body: 'no' }, reader)
      const allowed = await call('GET', `/v1/sessions/${id}/stored-messages`, undefined, reader)

      expect(denied.statusCode).toBe(403)
      expect(denied.json()).toMatchObject({ error: { code: 'INSUFFICIENT_SCOPE' } })
      expect(allowed.statusCode).toBe(200)
    })
  })

  describe('reading and acting on one message', () => {
    const message = buildMessageDto({
      id: 'true_x@c.us_ABC',
      chatId: '120363000000000000@g.us',
      body: 'original'
    })
    const messagePath = `messages/${encodeURIComponent(message.id)}`

    beforeAll(() => {
      client().sent.push(message)
    })

    it('replies to the chat of the message, quoting it', async () => {
      const response = await post(`${messagePath}/reply`, { type: 'text', body: 'respuesta' })

      expect(response.statusCode).toBe(201)
      const call = sendCalls().at(-1)
      expect(call?.args[0]).toBe('120363000000000000@g.us')
      expect(call?.args[2]).toMatchObject({ quotedMessageId: message.id })
    })

    it('reads the message and 404s on an unknown one', async () => {
      const found = await call('GET', `/v1/sessions/${id}/${messagePath}`)
      const missing = await call('GET', `/v1/sessions/${id}/messages/unknown`)

      expect(found.json()).toMatchObject({ id: message.id, body: 'original' })
      expect(missing.statusCode).toBe(404)
    })

    it('reacts, stars, unstars, pins, unpins and deletes', async () => {
      const react = await post(`${messagePath}/react`, { reaction: '👍' })
      const star = await post(`${messagePath}/star`)
      const unstar = await post(`${messagePath}/unstar`)
      const pin = await post(`${messagePath}/pin`, { duration: 604_800 })
      const unpin = await post(`${messagePath}/unpin`)
      const deleted = await call(
        'DELETE',
        `/v1/sessions/${id}/${messagePath}?everyone=true&clearMedia=true`
      )

      for (const response of [react, star, unstar, pin, unpin, deleted]) {
        expect(response.statusCode).toBe(204)
      }
      expect(client().callsOf('sendReaction').at(-1)?.args).toEqual([message.id, '👍'])
      expect(client().callsOf('pinMessage').at(-1)?.args).toEqual([message.id, 604_800])
      expect(client().callsOf('deleteMessage').at(-1)?.args).toEqual([message.id, true, true])
    })

    it('refuses a pin duration WhatsApp does not accept', async () => {
      expect((await post(`${messagePath}/pin`, { duration: 60 })).statusCode).toBe(400)
    })

    it('queues a forward like any send, to a phone number, with no message in the answer', async () => {
      const before = client().callsOf('forwardMessage').length
      const key = `fwd-${randomUUID()}`
      const first = await post(
        `${messagePath}/forward`,
        { chatId: '5215500000004' },
        { 'idempotency-key': key }
      )
      const replay = await post(
        `${messagePath}/forward`,
        { chatId: '5215500000004' },
        { 'idempotency-key': key }
      )

      expect(first.statusCode).toBe(201)
      expect(first.json<Record<string, unknown>>()).toEqual({
        jobId: expect.stringMatching(/^idem-/) as unknown,
        status: 'sent'
      })
      expect(replay.statusCode).toBe(201)
      expect(replay.headers['idempotent-replayed']).toBe('true')
      expect(client().callsOf('forwardMessage')).toHaveLength(before + 1)
      expect(client().callsOf('forwardMessage').at(-1)?.args).toEqual([
        message.id,
        '5215500000004@c.us'
      ])
    })

    it('edits a message, and says so when WhatsApp refuses', async () => {
      client().script('editMessage', () => null)
      const refused = await call('PATCH', `/v1/sessions/${id}/${messagePath}`, { body: 'nuevo' })
      client().script('editMessage', (_messageId, content) =>
        buildMessageDto({ id: message.id, body: content.body })
      )
      const edited = await call('PATCH', `/v1/sessions/${id}/${messagePath}`, { body: 'nuevo' })

      expect(refused.statusCode).toBe(502)
      expect(refused.json()).toMatchObject({ error: { code: 'WHATSAPP_ERROR' } })
      expect(edited.statusCode).toBe(200)
      expect(edited.json()).toMatchObject({ body: 'nuevo' })
    })

    it('serves a document inline with its own content type, sandboxed and not sniffed', async () => {
      client().script('downloadMedia', () => ({
        mimetype: 'application/pdf',
        data: Buffer.from('%PDF-1.7').toString('base64'),
        filename: 'a "b".pdf'
      }))

      const response = await call('GET', `/v1/sessions/${id}/${messagePath}/media`)

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toBe('application/pdf')
      expect(response.headers['content-disposition']).toBe('inline; filename="a _b_.pdf"')
      expect(response.headers['x-content-type-options']).toBe('nosniff')
      expect(response.headers['cache-control']).toBe('private, no-store')
      expect(response.headers['content-security-policy']).toBe("sandbox; default-src 'none'")
      expect(response.body).toBe('%PDF-1.7')
    })

    it('hands the bytes of a type a browser would run over as an opaque download', async () => {
      client().script('downloadMedia', () => ({
        mimetype: 'text/html',
        data: Buffer.from('<script>alert(1)</script>').toString('base64'),
        filename: 'x.html'
      }))

      const response = await call('GET', `/v1/sessions/${id}/${messagePath}/media`)

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toBe('application/octet-stream')
      expect(response.headers['content-disposition']).toBe('attachment; filename="x.html"')
      expect(response.headers['x-content-type-options']).toBe('nosniff')
    })

    it('404s when the media is gone', async () => {
      client().script('downloadMedia', () => null)

      expect((await call('GET', `/v1/sessions/${id}/${messagePath}/media`)).statusCode).toBe(404)
    })

    it('reads receipts, reactions and mentions', async () => {
      client().script('getMessageInfo', () => ({
        delivery: [],
        deliveryRemaining: 0,
        played: [],
        playedRemaining: 0,
        read: [],
        readRemaining: 1
      }))

      const info = await call('GET', `/v1/sessions/${id}/${messagePath}/info`)
      const reactions = await call('GET', `/v1/sessions/${id}/${messagePath}/reactions`)
      const mentions = await call('GET', `/v1/sessions/${id}/${messagePath}/mentions`)

      expect(info.json()).toMatchObject({ readRemaining: 1 })
      expect(reactions.json()).toEqual({ items: [] })
      expect(mentions.json()).toEqual({ items: [] })
    })

    it('searches the messages of WhatsApp Web', async () => {
      client().script('searchMessages', () => [message])

      const response = await call('GET', `/v1/sessions/${id}/messages/search?query=orig&limit=5`)

      expect(response.json()).toMatchObject({ items: [{ id: message.id }] })
      expect(client().callsOf('searchMessages').at(-1)?.args).toEqual([
        'orig',
        { limit: 5, page: 1 }
      ])
    })

    it('lists what the gateway stored, with the cursor of the page', async () => {
      const response = await call('GET', `/v1/sessions/${id}/stored-messages?limit=2`)

      expect(response.statusCode).toBe(200)
      expect(response.json<{ items: unknown[] }>().items.length).toBeLessThanOrEqual(2)
      expect(response.json()).toHaveProperty('nextCursor')
    })
  })

  // Step 5.6
  describe('polls, events and group invites', () => {
    const messageId = 'false_x@c.us_POLL1'
    const encoded = encodeURIComponent(messageId)
    const path = (suffix: string) => `/v1/sessions/${id}/${suffix}`
    const poll = buildMessageDto({
      id: messageId,
      type: 'poll_creation',
      pollName: 'Dia de entrega',
      pollOptions: ['Martes', 'Jueves']
    })
    const event = buildMessageDto({
      id: messageId,
      type: 'scheduled_event_creation',
      fromMe: true
    })
    const invite = {
      inviteCode: 'ABCDEF',
      inviteCodeExp: 1_767_225_600,
      groupId: '120363000000000001@g.us',
      fromId: '5215500000002@c.us',
      toId: '5215500000001@c.us'
    }
    const vote = {
      voter: '5215500000002@c.us',
      selectedOptions: [{ id: 0, name: 'Martes' }],
      interactedAtTs: 1_767_225_600_000,
      parentMessageId: messageId
    }
    const eventBody = {
      name: 'Entrega',
      startTime: '2026-02-01T18:00:00.000Z',
      endTime: '2026-02-01T19:00:00.000Z',
      description: 'Pedidos del mes',
      location: 'Bodega',
      callType: 'video',
      isEventCanceled: false
    }
    const calls = (method: Parameters<FakeWhatsAppClient['callsOf']>[0]) =>
      client().callsOf(method).length

    // The scripts live on the client every test of the file shares
    afterEach(() => {
      for (const method of [
        'getMessageById',
        'getPollVotes',
        'sendResponseToScheduledEvent',
        'editScheduledEvent'
      ] as const) {
        client().unscript(method)
      }
    })

    describe('poll votes', () => {
      it('reads the votes from both routes, and an empty poll gives no items', async () => {
        client().script('getMessageById', () => poll)
        client().script('getPollVotes', () => [vote])

        const byPoll = await call('GET', path(`polls/${encoded}/votes`))
        const byMessage = await call('GET', path(`messages/${encoded}/poll-votes`))
        client().unscript('getPollVotes')
        const empty = await call('GET', path(`polls/${encoded}/votes`))

        expect(byPoll.json()).toEqual({ items: [vote] })
        expect(byMessage.json()).toEqual({ items: [vote] })
        expect(empty.json()).toEqual({ items: [] })
      })

      it('404s on a missing message and 400s on a message that is not a poll', async () => {
        client().script('getMessageById', () => null)
        const missing = await call('GET', path(`polls/${encoded}/votes`))
        client().script('getMessageById', () => event)
        const notPoll = await call('GET', path(`messages/${encoded}/poll-votes`))

        expect(missing.statusCode).toBe(404)
        expect(notPoll.statusCode).toBe(400)
        expect(notPoll.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
      })

      it('votes, and removes the vote with an empty list', async () => {
        client().script('getMessageById', () => poll)
        const before = calls('vote')

        const voted = await post(`messages/${encoded}/vote`, { selectedOptions: ['Martes'] })
        const removed = await post(`messages/${encoded}/vote`, { selectedOptions: [] })

        expect(voted.statusCode).toBe(204)
        expect(removed.statusCode).toBe(204)
        expect(
          client()
            .callsOf('vote')
            .slice(before)
            .map(c => c.args)
        ).toEqual([
          [messageId, ['Martes']],
          [messageId, []]
        ])
      })

      it.each([
        ['an unknown key', { selectedOptions: [], extra: 1 }],
        ['no selectedOptions', {}],
        [
          'more than 12 options',
          { selectedOptions: Array.from({ length: 13 }, (_, n) => `o${n}`) }
        ],
        ['an empty name', { selectedOptions: [''] }],
        ['a name over 100 characters', { selectedOptions: ['x'.repeat(101)] }]
      ])('refuses a vote body with %s, without calling the client', async (_label, body) => {
        const before = calls('vote')

        const response = await post(`messages/${encoded}/vote`, body)

        expect(response.statusCode).toBe(400)
        expect(calls('vote')).toBe(before)
      })

      it('refuses a name that matches no option, a message that is not a poll and a missing one', async () => {
        const before = calls('vote')
        client().script('getMessageById', () => poll)
        const unknown = await post(`messages/${encoded}/vote`, { selectedOptions: ['Lunes'] })
        client().script('getMessageById', () => event)
        const notPoll = await post(`messages/${encoded}/vote`, { selectedOptions: [] })
        client().script('getMessageById', () => null)
        const missing = await post(`messages/${encoded}/vote`, { selectedOptions: [] })

        expect(unknown.statusCode).toBe(400)
        expect(unknown.json()).toMatchObject({
          error: { details: { unknownOptions: ['Lunes'] } }
        })
        expect(notPoll.statusCode).toBe(400)
        expect(missing.statusCode).toBe(404)
        expect(calls('vote')).toBe(before)
      })
    })

    describe('scheduled events', () => {
      it.each([0, 1, 2, 3])('sends the response %i of the body', async response => {
        client().script('getMessageById', () => event)
        const before = calls('sendResponseToScheduledEvent')

        const answered = await post(`events/${encoded}/response`, { response })

        expect(answered.statusCode).toBe(204)
        expect(client().callsOf('sendResponseToScheduledEvent').slice(before)[0]?.args).toEqual([
          response,
          messageId
        ])
      })

      it.each([
        ['4', { response: 4 }],
        ['-1', { response: -1 }],
        ['1.5', { response: 1.5 }],
        ['a string', { response: '1' }],
        ['a missing response', {}],
        ['an unknown key', { response: 1, extra: true }]
      ])('refuses %s, without calling the client', async (_label, body) => {
        const before = calls('sendResponseToScheduledEvent')

        const response = await post(`events/${encoded}/response`, body)

        expect(response.statusCode).toBe(400)
        expect(calls('sendResponseToScheduledEvent')).toBe(before)
      })

      it('404s when WhatsApp does not have the event', async () => {
        client().script('getMessageById', () => event)
        client().script('sendResponseToScheduledEvent', () => false)

        expect((await post(`events/${encoded}/response`, { response: 2 })).statusCode).toBe(404)
      })

      it('404s on a missing message and 400s on one that is not an event, without sending', async () => {
        const before = calls('sendResponseToScheduledEvent')
        client().script('getMessageById', () => null)
        const missing = await post(`events/${encoded}/response`, { response: 1 })
        client().script('getMessageById', () => poll)
        const notEvent = await post(`events/${encoded}/response`, { response: 1 })

        expect(missing.statusCode).toBe(404)
        expect(notEvent.statusCode).toBe(400)
        expect(calls('sendResponseToScheduledEvent')).toBe(before)
      })

      it('edits an event and passes every field to the client as dates and options', async () => {
        client().script('getMessageById', () => event)
        client().script('editScheduledEvent', () => event)
        const before = calls('editScheduledEvent')

        const edited = await call('PATCH', path(`events/${encoded}`), eventBody)

        expect(edited.statusCode).toBe(200)
        expect(edited.json()).toMatchObject({ id: messageId })
        expect(client().callsOf('editScheduledEvent').slice(before)[0]?.args).toEqual([
          messageId,
          {
            type: 'event',
            name: 'Entrega',
            startTime: new Date(eventBody.startTime),
            endTime: new Date(eventBody.endTime),
            description: 'Pedidos del mes',
            location: 'Bodega',
            callType: 'video',
            isEventCanceled: false
          }
        ])
      })

      it('fails with WHATSAPP_ERROR when WhatsApp does not edit, or the event is not ours', async () => {
        client().script('getMessageById', () => event)
        client().script('editScheduledEvent', () => null)
        const refused = await call('PATCH', path(`events/${encoded}`), eventBody)
        const before = calls('editScheduledEvent')
        client().script('getMessageById', () => ({ ...event, fromMe: false }))
        const foreign = await call('PATCH', path(`events/${encoded}`), eventBody)

        expect(refused.statusCode).toBe(502)
        expect(refused.json()).toMatchObject({ error: { code: 'WHATSAPP_ERROR' } })
        expect(foreign.statusCode).toBe(502)
        expect(calls('editScheduledEvent')).toBe(before)
      })

      it('404s on a missing message and 400s on one that is not an event', async () => {
        client().script('getMessageById', () => null)
        const missing = await call('PATCH', path(`events/${encoded}`), eventBody)
        client().script('getMessageById', () => poll)
        const notEvent = await call('PATCH', path(`events/${encoded}`), eventBody)

        expect(missing.statusCode).toBe(404)
        expect(notEvent.statusCode).toBe(400)
      })

      it.each([
        ['an unknown key', { ...eventBody, extra: 1 }],
        ['no startTime', { name: 'Entrega' }],
        ['no name', { startTime: eventBody.startTime }],
        ['a start that is not a date', { ...eventBody, startTime: 'mañana' }],
        ['a canceled flag that is not a boolean', { ...eventBody, isEventCanceled: 'yes' }]
      ])('refuses an edit with %s, without calling the client', async (_label, body) => {
        const before = calls('editScheduledEvent')

        const response = await call('PATCH', path(`events/${encoded}`), body)

        expect(response.statusCode).toBe(400)
        expect(calls('editScheduledEvent')).toBe(before)
      })
    })

    describe('group invites', () => {
      it('accepts the invite a message carries', async () => {
        client().script('getMessageById', () =>
          buildMessageDto({ id: messageId, inviteV4: invite })
        )
        const before = calls('acceptGroupV4Invite')

        const accepted = await post(`messages/${encoded}/accept-group-invite`)

        expect(accepted.statusCode).toBe(200)
        expect(accepted.json()).toEqual({ status: 200 })
        expect(client().callsOf('acceptGroupV4Invite').slice(before)).toHaveLength(1)
        expect(client().callsOf('acceptGroupV4Invite').at(-1)?.args).toEqual([invite])
      })

      it('404s without an invite or a message, and 400s on an expired invite, without joining', async () => {
        const before = calls('acceptGroupV4Invite')
        client().script('getMessageById', () => buildMessageDto({ id: messageId }))
        const none = await post(`messages/${encoded}/accept-group-invite`)
        client().script('getMessageById', () => null)
        const missing = await post(`messages/${encoded}/accept-group-invite`)
        client().script('getMessageById', () =>
          buildMessageDto({ id: messageId, inviteV4: { ...invite, inviteCodeExp: 0 } })
        )
        const expired = await post(`messages/${encoded}/accept-group-invite`)

        expect(none.statusCode).toBe(404)
        expect(missing.statusCode).toBe(404)
        expect(expired.statusCode).toBe(400)
        expect(calls('acceptGroupV4Invite')).toBe(before)
      })
    })

    describe('permissions', () => {
      const routes: [string, 'POST' | 'PATCH', string, object | undefined, string][] = [
        ['vote', 'POST', `messages/${encoded}/vote`, { selectedOptions: [] }, 'vote'],
        [
          'events.respond',
          'POST',
          `events/${encoded}/response`,
          { response: 1 },
          'sendResponseToScheduledEvent'
        ],
        ['events.edit', 'PATCH', `events/${encoded}`, eventBody, 'editScheduledEvent'],
        [
          'accept-group-invite',
          'POST',
          `messages/${encoded}/accept-group-invite`,
          undefined,
          'acceptGroupV4Invite'
        ]
      ]

      it.each(routes)(
        'a read key cannot use %s, and the client is not called',
        async (_label, method, suffix, body, clientMethod) => {
          const created = await call('POST', '/v1/api-keys', {
            name: 'poll-reader',
            sessionId: id,
            scopes: ['read']
          })
          const reader = { 'x-api-key': created.json<{ key: string }>().key }
          const before = calls(clientMethod as Parameters<FakeWhatsAppClient['callsOf']>[0])

          const denied = await call(method, path(suffix), body, reader)

          expect(denied.statusCode).toBe(403)
          expect(denied.json()).toMatchObject({ error: { code: 'INSUFFICIENT_SCOPE' } })
          expect(calls(clientMethod as Parameters<FakeWhatsAppClient['callsOf']>[0])).toBe(before)
        }
      )

      it.each([
        ['send', 'vote', 'POST', `messages/${encoded}/vote`, { selectedOptions: [] }, 204],
        ['send', 'events.respond', 'POST', `events/${encoded}/response`, { response: 1 }, 204],
        ['send', 'events.edit', 'PATCH', `events/${encoded}`, eventBody, 200],
        [
          'manage',
          'accept-group-invite',
          'POST',
          `messages/${encoded}/accept-group-invite`,
          undefined,
          200
        ],
        ['read', 'polls.votes', 'GET', `polls/${encoded}/votes`, undefined, 200]
      ] as const)('a %s key can use %s', async (scope, _label, method, suffix, body, status) => {
        const created = await call('POST', '/v1/api-keys', {
          name: `poll-${scope}`,
          sessionId: id,
          scopes: [scope]
        })
        const key = { 'x-api-key': created.json<{ key: string }>().key }
        const stored: Record<string, MessageDto> = {
          vote: poll,
          'polls.votes': poll,
          'accept-group-invite': buildMessageDto({ id: messageId, inviteV4: invite })
        }
        client().script('getMessageById', () => stored[_label] ?? event)
        client().script('editScheduledEvent', () => event)

        const response = await call(method, path(suffix), body, key)

        expect(response.statusCode).toBe(status)
      })

      it('a send key can neither read the votes nor accept an invite, and no key is 401', async () => {
        const sender = await call('POST', '/v1/api-keys', {
          name: 'poll-sender',
          sessionId: id,
          scopes: ['send']
        })
        const sendKey = { 'x-api-key': sender.json<{ key: string }>().key }
        client().script('getMessageById', () => poll)
        const pollReads = calls('getPollVotes')
        const accepts = calls('acceptGroupV4Invite')

        const votes = await call('GET', path(`polls/${encoded}/votes`), undefined, sendKey)
        const accept = await call(
          'POST',
          path(`messages/${encoded}/accept-group-invite`),
          undefined,
          sendKey
        )
        const anonymous = await call('GET', path(`polls/${encoded}/votes`), undefined, {})
        expect(calls('getPollVotes')).toBe(pollReads)
        expect(calls('acceptGroupV4Invite')).toBe(accepts)

        expect(votes.statusCode).toBe(403)
        expect(accept.statusCode).toBe(403)
        expect(anonymous.statusCode).toBe(401)
      })
    })
  })
})
