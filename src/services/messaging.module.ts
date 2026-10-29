import { Module } from '@nestjs/common'

import { WhatsAppModule } from '../whatsapp/whatsapp.module.js'

import { SendPolicyService } from './send-policy.service.js'
import { PolicyStateStore, RedisPolicyStateStore } from './send-policy.store.js'
import { SendQueueService } from './send-queue.service.js'

// Sending: the send policy and the persistent send queue; the message store joins them in the next step
@Module({
  imports: [WhatsAppModule],
  providers: [
    SendPolicyService,
    SendQueueService,
    { provide: PolicyStateStore, useClass: RedisPolicyStateStore }
  ],
  exports: [SendPolicyService, SendQueueService]
})
export class MessagingModule {}
