import { Module } from '@nestjs/common'

import { WhatsAppModule } from '../whatsapp/whatsapp.module.js'

import { IdempotentSendService } from './idempotent-send.service.js'
import { MessageStoreService } from './message-store.service.js'
import { SendPolicyService } from './send-policy.service.js'
import { PolicyStateStore, RedisPolicyStateStore } from './send-policy.store.js'
import { SendQueueService } from './send-queue.service.js'

// Sending: the send policy and the persistent send queue, and the message store they share a table with
@Module({
  imports: [WhatsAppModule],
  providers: [
    SendPolicyService,
    SendQueueService,
    IdempotentSendService,
    MessageStoreService,
    { provide: PolicyStateStore, useClass: RedisPolicyStateStore }
  ],
  exports: [SendPolicyService, SendQueueService, IdempotentSendService, MessageStoreService]
})
export class MessagingModule {}
