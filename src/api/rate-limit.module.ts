import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { ThrottlerModule } from '@nestjs/throttler'

import { RateLimitGuard, buildRateLimitOptions } from '../common/guards/rate-limit.js'
import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/env.schema.js'

// Imported before every module that has a guard of its own: guards run in the order they are
// registered, and the limit has to apply before the API key is looked up
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => buildRateLimitOptions(config)
    })
  ],
  providers: [{ provide: APP_GUARD, useClass: RateLimitGuard }]
})
export class RateLimitModule {}
