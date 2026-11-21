import { randomUUID } from 'node:crypto'

import { ADMIN, type ChaosGateway, bootGateway } from '../helpers/chaos-app.js'
import {
  type ChaosContainer,
  eventually,
  removeChaosContainers,
  startPostgres,
  startRedis
} from '../helpers/chaos.js'

// Step 10.3 (TDD §6.14): when Postgres goes down at runtime, /ready answers 503 and /health stays 200
// (the orchestrator must not restart a process that only needs its database back), and the gateway
// works again by itself when the database returns, with what it held before the outage intact.
// The database is the suite's own container, so stopping it cannot touch another suite.
describe('Postgres outage (chaos)', () => {
  let postgres: ChaosContainer
  let redis: ChaosContainer
  let gateway: ChaosGateway | undefined

  const running = (): ChaosGateway => {
    if (gateway === undefined) throw new Error('the gateway did not boot')
    return gateway
  }
  const statusOf = async (path: string): Promise<number> =>
    (await running().call('GET', path, undefined, {})).statusCode

  beforeAll(async () => {
    postgres = await startPostgres()
    redis = await startRedis()
    gateway = await bootGateway({ DATABASE_URL: postgres.url, REDIS_URL: redis.url })
  }, 180_000)

  afterAll(async () => {
    await gateway?.close().catch(() => undefined)
    await removeChaosContainers()
  }, 60_000)

  // A test that failed between a stop and its start must not take the next ones down with it
  afterEach(async () => {
    await postgres.ensureRunning()
  }, 60_000)

  it('answers /ready 503 and /health 200 while Postgres is down, then recovers by itself', async () => {
    expect(await statusOf('/ready')).toBe(200)

    await postgres.stop()
    await eventually(async () => (await statusOf('/ready')) === 503, {
      what: '/ready to turn 503'
    })
    expect(await statusOf('/health')).toBe(200)

    await postgres.start()
    await eventually(async () => (await statusOf('/ready')) === 200, {
      what: '/ready to turn 200 again'
    })
  }, 90_000)

  it('keeps what it held before the outage and writes again after it', async () => {
    const { sessionId, call } = running()
    const key = (
      await call('POST', '/v1/api-keys', { name: 'chaos', sessionId, scopes: ['read'] })
    ).json<{ key: string }>().key

    await postgres.restart()
    await eventually(async () => (await statusOf('/ready')) === 200)

    // The session and the key written before the restart are still there
    await eventually(async () => {
      const found = await call('GET', `/v1/sessions/${sessionId}`, undefined, { 'x-api-key': key })
      return found.statusCode === 200
    })
    const created = await call('POST', '/v1/sessions', { id: `after-${randomUUID().slice(0, 8)}` })
    expect(created.statusCode).toBe(201)
  }, 90_000)

  it('answers 503 DATABASE_UNAVAILABLE to a request that needs the database while it is down', async () => {
    const { sessionId, call } = running()
    await postgres.stop()
    let during: Awaited<ReturnType<ChaosGateway['call']>> | undefined
    try {
      during = await call('GET', `/v1/sessions/${sessionId}`, undefined, ADMIN)
    } finally {
      await postgres.start()
    }

    expect(during.statusCode).toBe(503)
    expect(during.headers['retry-after']).toBe('5')
    expect(during.json()).toMatchObject({ error: { code: 'DATABASE_UNAVAILABLE' } })
    expect(during.body).not.toContain('127.0.0.1')
    await eventually(
      async () =>
        (await call('GET', `/v1/sessions/${sessionId}`, undefined, ADMIN)).statusCode === 200,
      { what: 'the request to work again' }
    )
  }, 90_000)
})
