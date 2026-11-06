import { Module } from '@nestjs/common'

import { AuthModule } from '../services/auth.module.js'
import { WebhooksModule } from '../services/webhooks.module.js'

import { WebhooksController } from './controllers/webhooks.controller.js'

@Module({
  imports: [AuthModule, WebhooksModule],
  controllers: [WebhooksController]
})
export class WebhooksApiModule {}
