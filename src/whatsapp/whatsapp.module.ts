import { Module } from '@nestjs/common'

import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/env.schema.js'

import { EventBusService } from './event-bus.service.js'
import { EventPipelineService } from './event-pipeline.service.js'
import { ProcessGuardService } from './process-guard.service.js'
import { ReconcilerService } from './reconciler.service.js'
import { SessionManager } from './session-manager.service.js'
import { WatchdogService } from './watchdog.service.js'
import { WHATSAPP_CLIENT_FACTORY } from './whatsapp-client.port.js'
import { createWwebjsClientFactory } from './wwebjs-adapter.js'

// The sessions and everything that keeps them alive. The watchdog, the reconciler and the process guard only run
// because they are providers here: they start and stop with the application.
@Module({
  providers: [
    EventBusService,
    EventPipelineService,
    SessionManager,
    WatchdogService,
    ReconcilerService,
    ProcessGuardService,
    {
      provide: WHATSAPP_CLIENT_FACTORY,
      useFactory: (config: AppConfig) => createWwebjsClientFactory(config),
      inject: [APP_CONFIG]
    }
  ],
  exports: [EventBusService, EventPipelineService, SessionManager, WatchdogService]
})
export class WhatsAppModule {}
