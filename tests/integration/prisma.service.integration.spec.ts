import { Global, Module } from '@nestjs/common'
import { Test, type TestingModule } from '@nestjs/testing'

import { APP_CONFIG } from '../../src/config/config.module.js'
import { parseEnv } from '../../src/config/env.schema.js'
import { DatabaseModule } from '../../src/database/database.module.js'
import { PrismaService } from '../../src/database/prisma.service.js'
import { REAL_ENV, TEST_ENV } from '../helpers/env.js'

// Needs the Postgres of `pnpm infra:up` (or of CI) in DATABASE_URL, with the migrations applied
function databaseUrl(): URL {
  const url = REAL_ENV.DATABASE_URL
  if (url === undefined) throw new Error('DATABASE_URL is required by the integration suites')
  return new URL(url)
}

// Stands in for the global ConfigModule, so DatabaseModule resolves APP_CONFIG as it does in the app
const configFor = (url: URL): { provide: symbol; useFactory: () => unknown } => ({
  provide: APP_CONFIG,
  useFactory: () => parseEnv({ ...TEST_ENV, DATABASE_URL: url.toString() })
})

describe('PrismaService (integration)', () => {
  let module: TestingModule | undefined

  const build = async (url: URL): Promise<TestingModule> => {
    @Global()
    @Module({ providers: [configFor(url)], exports: [APP_CONFIG] })
    class TestConfigModule {}

    module = await Test.createTestingModule({
      imports: [TestConfigModule, DatabaseModule]
    }).compile()
    return module
  }

  // Closes the pool even when an assertion failed, so a failure does not leave a handle open
  afterEach(async () => {
    await module?.close()
    module = undefined
  })

  it('connects on init, answers queries and disconnects on destroy', async () => {
    const built = await build(databaseUrl())
    await built.init()
    const prisma = built.get(PrismaService)

    expect(await prisma.$queryRaw`SELECT 1 AS ok`).toEqual([{ ok: 1 }])
    // The migration of step 2.2 created the tables
    expect(await prisma.session.count()).toBeGreaterThanOrEqual(0)

    const disconnect = jest.spyOn(prisma, '$disconnect')
    await built.close()
    module = undefined

    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('fails the boot at once, without retrying, when the password is wrong', async () => {
    const url = databaseUrl()
    url.password = 'not-the-password'
    const built = await build(url)
    const started = Date.now()

    await expect(built.init()).rejects.toThrow(/28P01|password authentication failed/)

    // Eight retries would take seconds of backoff; a permanent failure stops on the first attempt
    expect(Date.now() - started).toBeLessThan(2000)
  })
})
