import { Inject, Injectable, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { resetEnv, setEnv, TEST_ENV } from '../../tests/helpers/env.js'

import type { AppConfig } from './env.schema.js'

// ConfigModule validates while its file loads, so each case sets the environment first and then
// imports a fresh copy of the module
async function bootWith(env: Record<string, string>): Promise<AppConfig> {
  setEnv(env)
  const { ConfigModule, APP_CONFIG } = await import('./config.module.js')
  const moduleRef = await Test.createTestingModule({ imports: [ConfigModule] }).compile()
  return moduleRef.get<AppConfig>(APP_CONFIG)
}

describe('ConfigModule', () => {
  beforeEach(() => {
    jest.resetModules()
  })

  afterEach(() => {
    resetEnv()
  })

  it('provides the parsed configuration, with numbers and booleans typed', async () => {
    const config = await bootWith({ PORT: '8080', ALLOW_COLD_SENDS: 'true' })

    expect(config.PORT).toBe(8080)
    expect(config.ALLOW_COLD_SENDS).toBe(true)
    expect(config.SEND_MIN_INTERVAL_MS).toBe(1000)
  })

  it('gives a blank optional variable as unset, not as an empty string', async () => {
    const config = await bootWith({ METRICS_TOKEN: '', PROXY_URL: '', QR_MAX_RETRIES: '' })

    expect(config.METRICS_TOKEN).toBeUndefined()
    expect(config.PROXY_URL).toBeUndefined()
    expect(config.QR_MAX_RETRIES).toBe(6)
    expect(config.LOG_LEVEL).toBe('info')
    expect(config.CORS_ORIGINS).toEqual([])
  })

  it('turns docs on in the test mode', async () => {
    expect((await bootWith({})).ENABLE_DOCS).toBe(true)
  })

  it('lets ENABLE_DOCS win over the mode', async () => {
    expect((await bootWith({ ENABLE_DOCS: 'false' })).ENABLE_DOCS).toBe(false)
  })

  it('is injectable in a module that does not import ConfigModule', async () => {
    setEnv({})
    const { ConfigModule, APP_CONFIG } = await import('./config.module.js')

    @Injectable()
    class Consumer {
      constructor(@Inject(APP_CONFIG) readonly config: AppConfig) {}
    }

    @Module({ providers: [Consumer], exports: [Consumer] })
    class FeatureModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, FeatureModule]
    }).compile()

    expect(moduleRef.select(FeatureModule).get(Consumer).config.PORT).toBe(3000)
  })

  it('fails the boot, listing every invalid variable', async () => {
    const boot = bootWith({ ...TEST_ENV, ADMIN_API_KEY: 'short', REDIS_URL: 'nope' })

    await expect(boot).rejects.toThrow(/^Invalid environment variables/)
    await expect(boot).rejects.toThrow(/ADMIN_API_KEY/)
    await expect(boot).rejects.toThrow(/REDIS_URL/)
  })
})
