import { Module } from '@nestjs/common'

import { HealthController } from './api/controllers/health.controller.js'

@Module({
  controllers: [HealthController]
})
export class AppModule {}
