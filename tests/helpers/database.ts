import { Global, Module } from '@nestjs/common'
import { Test, type TestingModule } from '@nestjs/testing'

import { APP_CONFIG } from '../../src/config/config.module.js'
import { parseEnv } from '../../src/config/env.schema.js'
import { DatabaseModule } from '../../src/database/database.module.js'

import { REAL_ENV, TEST_ENV } from './env.js'

// Needs the Postgres of `pnpm infra:up` (or of CI) in DATABASE_URL, with the migrations applied
export function databaseUrl(): URL {
  const url = REAL_ENV.DATABASE_URL
  if (url === undefined) throw new Error('DATABASE_URL is required by the integration suites')
  return new URL(url)
}

// Stands in for the global ConfigModule, so DatabaseModule resolves APP_CONFIG as it does in the app
export async function buildDatabaseModule(url: URL = databaseUrl()): Promise<TestingModule> {
  @Global()
  @Module({
    providers: [
      {
        provide: APP_CONFIG,
        useFactory: () => parseEnv({ ...TEST_ENV, DATABASE_URL: url.toString() })
      }
    ],
    exports: [APP_CONFIG]
  })
  class TestConfigModule {}

  return Test.createTestingModule({ imports: [TestConfigModule, DatabaseModule] }).compile()
}
