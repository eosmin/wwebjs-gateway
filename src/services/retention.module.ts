import { Module } from '@nestjs/common'

import { MessagingModule } from './messaging.module.js'
import { RetentionService } from './retention.service.js'
import { WebhooksModule } from './webhooks.module.js'

// What the gateway deletes on a schedule, and the sweep of pending deliveries that lost their job.
// It reads the message store and the delivery queue, so it sits above both modules.
@Module({
  imports: [MessagingModule, WebhooksModule],
  providers: [RetentionService]
})
export class RetentionModule {}
