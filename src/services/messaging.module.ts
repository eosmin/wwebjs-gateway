import { Module } from '@nestjs/common'

import { WhatsAppModule } from '../whatsapp/whatsapp.module.js'

import { ChatsService } from './chats.service.js'
import { HumanizeDefaultsService } from './humanize-defaults.service.js'
import { IdempotentSendService } from './idempotent-send.service.js'
import { MediaResolverService } from './media-resolver.service.js'
import { MessageSendService } from './message-send.service.js'
import { MessageStoreService } from './message-store.service.js'
import { MessagesService } from './messages.service.js'
import { PollsEventsService } from './polls-events.service.js'
import { RecipientResolverService } from './recipient-resolver.service.js'
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
    RecipientResolverService,
    MediaResolverService,
    HumanizeDefaultsService,
    MessageSendService,
    MessagesService,
    PollsEventsService,
    ChatsService,
    { provide: PolicyStateStore, useClass: RedisPolicyStateStore }
  ],
  exports: [
    SendPolicyService,
    SendQueueService,
    IdempotentSendService,
    MessageStoreService,
    MessageSendService,
    MessagesService,
    PollsEventsService,
    ChatsService
  ]
})
export class MessagingModule {}
