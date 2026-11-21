import { randomUUID } from 'node:crypto'

import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import type { LightMyRequestResponse } from 'fastify'

import { TEST_ENV, setEnv } from './env.js'
import { FakeWhatsAppClientFactory, type FakeWhatsAppClient } from './fake-whatsapp-client.js'

export const ADMIN = { 'x-api-key': TEST_ENV.ADMIN_API_KEY }

export interface ChaosGateway {
  app: NestFastifyApplication
  sessionId: string
  client: () => FakeWhatsAppClient
  call: (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    payload?: object,
    headers?: Record<string, string>
  ) => Promise<LightMyRequestResponse>
  send: (body: string, idempotencyKey?: string) => Promise<LightMyRequestResponse>
  close: () => Promise<void>
}

export interface ChaosEnv {
  DATABASE_URL: string
  REDIS_URL: string
}

// A peer that is not a real number: the fake client answers for every chat
export const PEER = '5215500000000'

// The environment of the gateway under test. The configuration module reads it when it first loads, and
// RedisService and PrismaService reach that module, so a spec that imports either sets it first.
export function gatewayEnv(
  { DATABASE_URL, REDIS_URL }: ChaosEnv,
  extraEnv: Record<string, string> = {}
): Record<string, string> {
  // A fresh account would be paced like a newborn number, and these tests send to a stranger
  return {
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
    ...extraEnv
  }
}

// The whole application against the given Postgres and Redis (the ones of a chaos container), with the
// fake client in place of Chromium and one session already `ready`. A spec file boots one gateway.
export async function bootGateway(
  urls: ChaosEnv,
  extraEnv: Record<string, string> = {}
): Promise<ChaosGateway> {
  setEnv(gatewayEnv(urls, extraEnv))
  const { AppModule } = await import('../../src/app.module.js')
  const { createFastifyAdapter } = await import('../../src/infra/logger/fastify-adapter.js')
  const { WHATSAPP_CLIENT_FACTORY } = await import('../../src/whatsapp/whatsapp-client.port.js')

  const factory = new FakeWhatsAppClientFactory()
  const sessionId = `chaos-${randomUUID().slice(0, 8)}`
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(WHATSAPP_CLIENT_FACTORY)
    .useValue(factory.create)
    .compile()
  const app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter())
  await app.init()
  await app.getHttpAdapter().getInstance().ready()

  const call: ChaosGateway['call'] = (method, path, payload, headers = ADMIN) =>
    app.inject({ method, url: path, headers, ...(payload === undefined ? {} : { payload }) })
  const client = (): FakeWhatsAppClient => {
    const found = factory.clientFor(sessionId)
    if (found === undefined) throw new Error('the session did not build a client')
    return found
  }

  expect((await call('POST', '/v1/sessions', { id: sessionId })).statusCode).toBe(201)
  expect((await call('POST', `/v1/sessions/${sessionId}/start`)).statusCode).toBe(200)
  client().emit({ event: 'ready', data: {} })
  expect(
    (
      await call('PATCH', `/v1/sessions/${sessionId}`, {
        settings: { humanize: { enabled: false } }
      })
    ).statusCode
  ).toBe(200)

  return {
    app,
    sessionId,
    client,
    call,
    send: (body, idempotencyKey) =>
      call(
        'POST',
        `/v1/sessions/${sessionId}/messages`,
        { to: PEER, type: 'text', body },
        idempotencyKey === undefined ? ADMIN : { ...ADMIN, 'idempotency-key': idempotencyKey }
      ),
    close: () => app.close()
  }
}
