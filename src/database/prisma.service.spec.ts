import { Logger } from '@nestjs/common'
import { PrismaPg } from '@prisma/adapter-pg'

import { type AppConfig, parseEnv } from '../config/env.schema.js'
import { Prisma } from '../generated/prisma/client.js'

import { PrismaService } from './prisma.service.js'

// The real adapter, wrapped so the spec can read the options it was built with
jest.mock('@prisma/adapter-pg', () => {
  const actual = jest.requireActual<{ PrismaPg: typeof PrismaPg }>('@prisma/adapter-pg')
  return {
    PrismaPg: jest.fn(
      (...args: ConstructorParameters<typeof PrismaPg>) => new actual.PrismaPg(...args)
    )
  }
})

const URL_WITH_PASSWORD = 'postgresql://gateway:secret-password@127.0.0.1:1/gateway'

// Nothing listens on port 1; the specs replace the calls that would reach the database anyway
const config: AppConfig = parseEnv({
  PUBLIC_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: URL_WITH_PASSWORD,
  REDIS_URL: 'redis://localhost:6379',
  ADMIN_API_KEY: 'a'.repeat(32)
})

// What Prisma throws for a failure of the pg driver adapter (shape taken from a real server)
function prismaFailure(kind: string, reason: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `\nInvalid \`prisma.$queryRaw()\` invocation:\n\n\nRaw query failed. ${reason}`,
    { code: 'P2010', clientVersion: 'test', meta: { driverAdapterError: { cause: { kind } } } }
  )
}

describe('PrismaService', () => {
  let service: PrismaService
  let connect: jest.SpyInstance
  let query: jest.SpyInstance
  let disconnect: jest.SpyInstance
  let warn: jest.SpyInstance

  const init = async (): Promise<void> => {
    const started = service.onModuleInit()
    // The handler is attached before the timers run, so a rejection is never unhandled
    const settled = started.then(
      () => undefined,
      () => undefined
    )
    await jest.runAllTimersAsync()
    await settled
    await started
  }

  beforeEach(() => {
    jest.useFakeTimers()
    service = new PrismaService(config)
    connect = jest.spyOn(service, '$connect').mockResolvedValue(undefined)
    query = jest.spyOn(service, '$queryRaw').mockResolvedValue([{ '?column?': 1 }])
    disconnect = jest.spyOn(service, '$disconnect').mockResolvedValue(undefined)
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('bounds the time a connection may take, so an address that never answers cannot hang the boot', () => {
    expect(PrismaPg).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: URL_WITH_PASSWORD,
        connectionTimeoutMillis: 5000
      })
    )
  })

  it('connects and checks the link with a query on the first attempt', async () => {
    await init()

    expect(connect).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('retries while Postgres is not ready and then succeeds', async () => {
    query
      .mockRejectedValueOnce(
        prismaFailure('DatabaseNotReachable', "Code: `N/A`. Message: `Can't reach database server`")
      )
      .mockRejectedValueOnce(
        prismaFailure('DatabaseNotReachable', "Code: `N/A`. Message: `Can't reach database server`")
      )

    await init()

    expect(connect).toHaveBeenCalledTimes(3)
    expect(query).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenNthCalledWith(1, expect.stringContaining('attempt 1 failed'))
    expect(warn).toHaveBeenNthCalledWith(2, expect.stringContaining('attempt 2 failed'))
  })

  it('logs the reason of a Prisma failure, not its multi-line wrapper', async () => {
    query.mockRejectedValueOnce(
      prismaFailure('DatabaseNotReachable', "Code: `N/A`. Message: `Can't reach database server`")
    )

    await init()

    expect(warn).toHaveBeenCalledWith(
      "Postgres connection attempt 1 failed: Raw query failed. Code: `N/A`. Message: `Can't reach database server`"
    )
  })

  it('fails the boot when Postgres never answers, and releases the pool', async () => {
    connect.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:1'))

    await expect(init()).rejects.toThrow('ECONNREFUSED')

    expect(connect).toHaveBeenCalledTimes(8)
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'AuthenticationFailed',
      'Code: `28P01`. Message: `password authentication failed for user "gateway"`'
    ],
    ['DatabaseDoesNotExist', 'Code: `3D000`. Message: `database "nope" does not exist`']
  ])('does not retry a permanent failure (%s)', async (kind, reason) => {
    query.mockRejectedValue(prismaFailure(kind, reason))

    await expect(init()).rejects.toThrow(reason)

    expect(query).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('removes the credentials of a connection string from the log', async () => {
    query.mockRejectedValueOnce(new Error(`could not parse ${URL_WITH_PASSWORD}`))

    await init()

    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).not.toContain('secret-password')
    expect(logged).toContain('postgresql://<redacted>@127.0.0.1:1/gateway')
  })

  it('names the error code when Prisma gives no reason, as with a refused connection', async () => {
    // Real shape for `localhost` when nothing listens: an empty wrapper and the code on the error
    query.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('\nInvalid `prisma.$queryRaw()` invocation:\n\n\n', {
        code: 'ECONNREFUSED',
        clientVersion: 'test'
      })
    )

    await init()

    expect(warn).toHaveBeenCalledWith('Postgres connection attempt 1 failed: ECONNREFUSED')
  })

  it.each([
    ['a raw @ in the password', 'failed postgresql://u:p@ss@db.example/gateway', 'p@ss', 'ss@'],
    [
      'a keyword/value connection string',
      'failed password=sekret host=db.example',
      'sekret',
      'sekret'
    ],
    [
      'a password in the query string',
      'failed postgresql://db.example/gateway?password=sekret&ssl=1',
      'sekret',
      'sekret'
    ]
  ])('removes the secret from %s', async (_name, message, _secret, leaked) => {
    query.mockRejectedValueOnce(new Error(message))

    await init()

    expect(JSON.stringify(warn.mock.calls)).not.toContain(leaked)
  })

  it('logs a failure that is not an Error without inventing details', async () => {
    query.mockRejectedValueOnce('boom')

    await init()

    expect(warn).toHaveBeenCalledWith('Postgres connection attempt 1 failed: unknown error')
  })

  it('has no module-destroy hook: queues and workers still write until the application shuts down', () => {
    expect(service).not.toHaveProperty('onModuleDestroy')
  })

  it('disconnects on application shutdown, after the consumers have closed', async () => {
    await service.onApplicationShutdown()

    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('gives up on a pool that does not close and still finishes the shutdown', async () => {
    disconnect.mockReturnValue(new Promise(() => undefined))

    const shutdown = service.onApplicationShutdown()
    await jest.advanceTimersByTimeAsync(5000)

    await expect(shutdown).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith('Postgres did not disconnect cleanly, giving up')
  })

  it('finishes the shutdown when the disconnect fails', async () => {
    disconnect.mockRejectedValue(new Error('pool already ended'))

    await expect(service.onApplicationShutdown()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith('Postgres did not disconnect cleanly, giving up')
  })
})
