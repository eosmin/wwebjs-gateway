import { Logger } from '@nestjs/common'
import type { Redis } from 'ioredis'

import { type AppConfig, parseEnv } from '../../config/env.schema.js'

import { RedisService } from './redis.service.js'

// Nothing listens on port 1, so the connections never become ready
const config: AppConfig = parseEnv({
  PUBLIC_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://gateway:gateway@localhost:5432/gateway',
  REDIS_URL: 'redis://127.0.0.1:1',
  ADMIN_API_KEY: 'a'.repeat(32),
  REDIS_CONNECT_TIMEOUT_MS: '300'
})

describe('RedisService', () => {
  const services: RedisService[] = []
  const clients: Redis[] = []
  const track = (service: RedisService): RedisService => {
    services.push(service)
    clients.push(service.client)
    const createConnection = service.createConnection.bind(service)
    jest.spyOn(service, 'createConnection').mockImplementation(() => {
      const connection = createConnection()
      clients.push(connection)
      return connection
    })
    return service
  }
  const create = (): RedisService => track(new RedisService(config))

  // disconnect() ends the socket and arms a 2 s timer (ioredis `disconnectTimeout`) that is only
  // cleared by the socket's `close` event. The socket of a connection that never reached Redis is
  // already dead and never emits it again, so the timer would keep the Jest worker alive after the
  // suite ("worker process has failed to exit gracefully"). Emitting `close` clears it.
  afterEach(() => {
    services.splice(0)
    for (const client of clients.splice(0)) {
      client.disconnect()
      client.stream?.destroy()
      client.stream?.emit('close')
    }
  })

  it('fails the start with a clear message when Redis does not answer in time', async () => {
    const service = track(
      new RedisService({ ...config, REDIS_URL: 'redis://user:s3cret@127.0.0.1:1' })
    )

    const failure = await service.onModuleInit().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toContain('Redis is not reachable at 127.0.0.1:1 after 300 ms')
    expect(message).not.toContain('s3cret')
  })

  it('lets the start go on as soon as Redis is ready', async () => {
    const service = create()
    Object.defineProperty(service.client, 'status', { value: 'ready' })

    await expect(service.onModuleInit()).resolves.toBeUndefined()
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

  describe('the log of a Redis that is down', () => {
    // The connection is closed before it can fail on its own, so only the errors the spec emits count
    const quiet = (): RedisService => {
      const service = create()
      service.client.disconnect()
      return service
    }

    it('logs the first error and holds back the retries that follow', () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
      try {
        const service = quiet()
        for (let retry = 0; retry < 5; retry++) {
          service.client.emit('error', new Error('connect ECONNREFUSED'))
        }

        expect(error).toHaveBeenCalledTimes(1)
        expect(error).toHaveBeenCalledWith('Redis connection error: connect ECONNREFUSED')
      } finally {
        error.mockRestore()
      }
    })

    it('logs a different failure at once, not behind the one that came first', () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
      try {
        const service = quiet()
        service.client.emit('error', new Error('connect ECONNREFUSED'))
        service.client.emit('error', new Error('connect ECONNREFUSED'))
        service.client.emit('error', new Error('WRONGPASS invalid username-password pair'))

        expect(error.mock.calls.map(([line]) => String(line))).toEqual([
          'Redis connection error: connect ECONNREFUSED',
          'Redis connection error: WRONGPASS invalid username-password pair'
        ])
      } finally {
        error.mockRestore()
      }
    })

    it('says when the connection is back, and logs the next outage at once', () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
      try {
        const service = quiet()
        service.client.emit('error', new Error('down'))
        service.client.emit('ready')
        service.client.emit('ready')
        service.client.emit('error', new Error('down again'))

        expect(log).toHaveBeenCalledTimes(1)
        expect(log).toHaveBeenCalledWith('Redis connection restored')
        expect(error).toHaveBeenCalledTimes(2)
      } finally {
        error.mockRestore()
        log.mockRestore()
      }
    })

    it('stays silent when the first connection is healthy', () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
      try {
        quiet().client.emit('ready')

        expect(log).not.toHaveBeenCalled()
      } finally {
        log.mockRestore()
      }
    })
  })
})
