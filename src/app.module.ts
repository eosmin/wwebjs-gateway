import { Module } from '@nestjs/common'

import { HealthController } from './api/controllers/health.controller.js'
import { ConfigModule } from './config/config.module.js'

@Module({
  imports: [ConfigModule],
  controllers: [HealthController]
})
export class AppModule {}
