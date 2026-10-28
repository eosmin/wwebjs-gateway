import { Module } from '@nestjs/common'
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core'
import { ZodSerializerInterceptor, ZodValidationPipe } from 'nestjs-zod'

import { ApiModule } from './api/api.module.js'
import { HealthController } from './api/controllers/health.controller.js'
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js'
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor.js'
import { TimeoutInterceptor } from './common/interceptors/timeout.interceptor.js'
import { ConfigModule } from './config/config.module.js'
import { LoggerModule } from './infra/logger/logger.module.js'
import { MetricsModule } from './infra/metrics/metrics.module.js'

@Module({
  imports: [ConfigModule, LoggerModule, MetricsModule, ApiModule],
  controllers: [HealthController],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TimeoutInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor }
  ]
})
export class AppModule {}
