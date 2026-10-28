import { Module } from '@nestjs/common'
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core'
import { ZodSerializerInterceptor, ZodValidationPipe } from 'nestjs-zod'

import { ApiKeysModule } from './api/api-keys.module.js'
import { ApiModule } from './api/api.module.js'
import { SessionsModule } from './api/sessions.module.js'
import { SystemModule } from './api/system.module.js'
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js'
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor.js'
import { TimeoutInterceptor } from './common/interceptors/timeout.interceptor.js'
import { ConfigModule } from './config/config.module.js'
import { DatabaseModule } from './database/database.module.js'
import { LoggerModule } from './infra/logger/logger.module.js'
import { MetricsModule } from './infra/metrics/metrics.module.js'
import { RedisModule } from './infra/redis/redis.module.js'
import { WhatsAppModule } from './whatsapp/whatsapp.module.js'

@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    MetricsModule,
    DatabaseModule,
    RedisModule,
    ApiModule,
    WhatsAppModule,
    SystemModule,
    ApiKeysModule,
    SessionsModule
  ],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TimeoutInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor }
  ]
})
export class AppModule {}
