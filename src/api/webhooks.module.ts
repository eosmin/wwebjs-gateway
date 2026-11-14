import { Module } from '@nestjs/common'

import { AuthModule } from '../services/auth.module.js'
import { MessagingModule } from '../services/messaging.module.js'
import { WebhooksModule } from '../services/webhooks.module.js'

import { InboundController } from './controllers/inbound.controller.js'
import { WebhooksController } from './controllers/webhooks.controller.js'

@Module({
  imports: [AuthModule, MessagingModule, WebhooksModule],
  controllers: [WebhooksController, InboundController]
})
export class WebhooksApiModule {}
