import { Logger } from '@nestjs/common'
import { HealthCheckService, TerminusModule } from '@nestjs/terminus'
import { Test, type TestingModule } from '@nestjs/testing'

import { PrismaService } from '../database/prisma.service.js'
import { RedisService } from '../infra/redis/redis.service.js'

import { ReadinessService } from './readiness.service.js'

describe('ReadinessService', () => {
  const queryRaw = jest.fn()
  const ping = jest.fn()
  let moduleRef: TestingModule
  let service: ReadinessService

  beforeEach(async () => {
    queryRaw.mockReset().mockResolvedValue([{ secret: 'must not reach the result' }])
    ping.mockReset().mockResolvedValue('PONG')
    moduleRef = await Test.createTestingModule({
      imports: [TerminusModule.forRoot({ logger: false })],
      providers: [
        ReadinessService,
        { provide: PrismaService, useValue: { $queryRaw: queryRaw } },
        { provide: RedisService, useValue: { client: { ping } } }
      ]
    }).compile()
    await moduleRef.init()
    service = moduleRef.get(ReadinessService)
  })

  afterEach(async () => {
    jest.useRealTimers()
    await moduleRef.close()
  })

  it('is ok when both dependencies answer, and shows nothing the pings returned', async () => {
    const result = await service.readiness()

    expect(result).toMatchObject({
      status: 'ok',
      details: { postgres: { status: 'up' }, redis: { status: 'up' } }
    })
    expect(JSON.stringify(result)).not.toContain('must not reach the result')
  })

  it.each([
    ['postgres', () => queryRaw.mockRejectedValue(new Error('connection refused')), 'redis'],
    ['redis', () => ping.mockRejectedValue(new Error('connection refused')), 'postgres']
  ])('names %s as the indicator that is down', async (down, breakIt, up) => {
    breakIt()

    const result = await service.readiness()

    expect(result.status).toBe('error')
    expect(result.error).toHaveProperty(down)
    expect(result.info).toHaveProperty(up)
  })

  it('never shows the failure message: it can carry hosts, ports and users', async () => {
    queryRaw.mockRejectedValue(new Error('connect ECONNREFUSED 10.1.2.3:5432 user=gateway'))
    ping.mockRejectedValue(new Error('NOAUTH redis.internal:6379'))

    const body = JSON.stringify(await service.readiness())

    expect(body).not.toMatch(/10\.1\.2\.3|ECONNREFUSED|gateway|redis\.internal|NOAUTH|message/)
  })

  it('counts a dependency that does not answer in time as down', async () => {
    jest.useFakeTimers()
    ping.mockReturnValue(new Promise(() => undefined))

    const pending = service.readiness()
    await jest.runOnlyPendingTimersAsync()

    expect(await pending).toMatchObject({ status: 'error', error: { redis: { status: 'down' } } })
  })

  describe('logging', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)

    beforeEach(() => warn.mockClear())
    afterAll(() => warn.mockRestore())

    it('logs the name and the reason of what is down, and only there', async () => {
      queryRaw.mockRejectedValue(new Error('connect ECONNREFUSED 10.1.2.3:5432'))

      const result = await service.readiness()

      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toBe(
        'Health check failed: postgres (connect ECONNREFUSED 10.1.2.3:5432)'
      )
      expect(JSON.stringify(result)).not.toContain('10.1.2.3')
    })

    it('does not log a healthy check or a shutdown', async () => {
      await service.readiness()
      await moduleRef.close()
      await service.readiness()

      expect(warn).not.toHaveBeenCalled()
    })
  })

  it('lets an error that is not a failed check through', async () => {
    const health = moduleRef.get(HealthCheckService)
    jest.spyOn(health, 'check').mockRejectedValue(new Error('boom'))

    await expect(service.readiness()).rejects.toThrow('boom')
  })

  it('answers liveness without touching Postgres or Redis', async () => {
    queryRaw.mockRejectedValue(new Error('down'))
    ping.mockRejectedValue(new Error('down'))

    expect(await service.liveness()).toMatchObject({ status: 'ok' })
    expect(queryRaw).not.toHaveBeenCalled()
    expect(ping).not.toHaveBeenCalled()
  })

  it('reports shutting_down once the shutdown has begun, for both probes', async () => {
    await moduleRef.close()

    expect(await service.readiness()).toMatchObject({ status: 'shutting_down' })
    expect(await service.liveness()).toMatchObject({ status: 'shutting_down' })
  })
})
