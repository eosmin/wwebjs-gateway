import { Module } from '@nestjs/common'
import { TerminusModule } from '@nestjs/terminus'

import { AuthModule } from '../services/auth.module.js'
import { ReadinessService } from '../services/readiness.service.js'
import { SystemService } from '../services/system.service.js'

import { HealthController } from './controllers/health.controller.js'
import { SystemController } from './controllers/system.controller.js'

@Module({
  // Terminus' own logger writes to the console; the failures are logged by ReadinessService instead
  imports: [AuthModule, TerminusModule.forRoot({ logger: false })],
  controllers: [HealthController, SystemController],
  providers: [ReadinessService, SystemService]
})
export class SystemModule {}
