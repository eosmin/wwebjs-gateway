import { Module } from '@nestjs/common'

import { AuthModule } from '../services/auth.module.js'
import { SessionsService } from '../services/sessions.service.js'
import { WebhooksModule } from '../services/webhooks.module.js'
import { WhatsAppModule } from '../whatsapp/whatsapp.module.js'

import { SessionsController } from './controllers/sessions.controller.js'

@Module({
  imports: [AuthModule, WebhooksModule, WhatsAppModule],
  controllers: [SessionsController],
  providers: [SessionsService]
})
export class SessionsModule {}
