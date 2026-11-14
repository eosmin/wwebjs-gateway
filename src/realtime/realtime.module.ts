import { Module } from '@nestjs/common'

import { ApiModule } from '../api/api.module.js'
import { AuthModule } from '../services/auth.module.js'
import { WhatsAppModule } from '../whatsapp/whatsapp.module.js'

import { EventReplayService } from './event-replay.service.js'
import { OperationDispatcherService } from './operation-dispatcher.service.js'
import { SocketGateway } from './socket.gateway.js'

// The realtime stream and the socket commands (TDD §6.10). Imported by the AppModule after the modules
// with controllers: the dispatcher reads the registry at bootstrap, once every operation is known.
@Module({
  imports: [ApiModule, AuthModule, WhatsAppModule],
  providers: [EventReplayService, OperationDispatcherService, SocketGateway]
})
export class RealtimeModule {}
