import { Global, Module } from '@nestjs/common'

import { HttpMetricsHook } from './http-metrics.hook.js'
import { MetricsService } from './metrics.service.js'

@Global()
@Module({ providers: [MetricsService, HttpMetricsHook], exports: [MetricsService] })
export class MetricsModule {}
