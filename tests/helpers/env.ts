import { envSchema } from '../../src/config/env.schema.js'

// The smallest environment that passes envSchema. ConfigModule validates while a module that
// imports it loads, so jest runs this file (`setupFiles`) before any spec imports the application.
export const TEST_ENV = {
  NODE_ENV: 'test',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://gateway:gateway@localhost:5432/gateway',
  REDIS_URL: 'redis://localhost:6379',
  ADMIN_API_KEY: 'a'.repeat(32)
}

// The Postgres of the shell or of CI, for the integration suites. Read before the loop below removes
// it; undefined when the variable is not set (unit runs). It relies on the module registry being
// shared between this setup file and the specs, so a config with `resetModules` would break it.
export const REAL_ENV = {
  DATABASE_URL: process.env['DATABASE_URL']
}

// A variable of the schema already in the shell of a developer or of CI must not reach the specs
for (const key of Object.keys(envSchema.shape)) delete process.env[key]
Object.assign(process.env, TEST_ENV)
const baseline = { ...process.env }

export function setEnv(values: Record<string, string>): void {
  Object.assign(process.env, values)
}

// Back to TEST_ENV, undoing whatever a spec set
export function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in baseline)) delete process.env[key]
  }
  Object.assign(process.env, baseline)
}
