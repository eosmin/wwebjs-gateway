import { type AppConfig, parseEnv } from '../../config/env.schema.js'

import { RedisService } from './redis.service.js'

// Nothing listens on port 1, so the connections never become ready
const config: AppConfig = parseEnv({
  PUBLIC_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://gateway:gateway@localhost:5432/gateway',
  REDIS_URL: 'redis://127.0.0.1:1',
  ADMIN_API_KEY: 'a'.repeat(32)
})

describe('RedisService', () => {
  const services: RedisService[] = []
  const create = (): RedisService => {
    const service = new RedisService(config)
    services.push(service)
    return service
  }

  afterEach(() => {
    for (const service of services.splice(0)) service.client.disconnect()
  })

  it('opens a shared client and separate connections on request', () => {
    const service = create()
    const extra = service.createConnection()

    expect(extra).not.toBe(service.client)
    extra.disconnect()
  })

  it('finishes shutting down while Redis is unreachable', async () => {
    const service = create()
    const extra = service.createConnection()

    await service.onApplicationShutdown()

    // disconnect() stops the reconnection timer, so the process can exit
    expect(service.client.status).not.toBe('ready')
    expect(extra.status).not.toBe('ready')
    // quit() waits out its 2 s bound here, so the default 5 s timeout would leave little margin
  }, 15_000)

  it('disconnects every connection even when quit fails', async () => {
    const service = create()
    const extra = service.createConnection()
    jest.spyOn(service.client, 'quit').mockRejectedValue(new Error('Connection is closed.'))
    jest.spyOn(extra, 'quit').mockResolvedValue('OK')
    const disconnects = [jest.spyOn(service.client, 'disconnect'), jest.spyOn(extra, 'disconnect')]

    await expect(service.onApplicationShutdown()).resolves.toBeUndefined()

    for (const disconnect of disconnects) expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('does not wait for a quit that never answers', async () => {
    jest.useFakeTimers()
    try {
      const service = create()
      jest.spyOn(service.client, 'quit').mockReturnValue(new Promise(() => undefined))
      const done = service.onApplicationShutdown()

      await jest.advanceTimersByTimeAsync(2000)

      await expect(done).resolves.toBeUndefined()
    } finally {
      jest.useRealTimers()
    }
  })
})
