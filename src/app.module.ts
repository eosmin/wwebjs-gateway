import { Module } from '@nestjs/common'

import { HealthController } from './api/controllers/health.controller.js'
import { ConfigModule } from './config/config.module.js'
import { LoggerModule } from './infra/logger/logger.module.js'
import { MetricsModule } from './infra/metrics/metrics.module.js'

@Module({
  imports: [ConfigModule, LoggerModule, MetricsModule],
  controllers: [HealthController]
})
export class AppModule {}
