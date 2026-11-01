import { Module } from '@nestjs/common'

import { WhatsAppModule } from '../whatsapp/whatsapp.module.js'

import { BroadcastsService } from './broadcasts.service.js'
import { CallsService } from './calls.service.js'
import { ChannelsService } from './channels.service.js'
import { ChatsService } from './chats.service.js'
import { ContactsService } from './contacts.service.js'
import { GroupsService } from './groups.service.js'
import { HumanizeDefaultsService } from './humanize-defaults.service.js'
import { IdempotentSendService } from './idempotent-send.service.js'
import { LabelsService } from './labels.service.js'
import { LookupService } from './lookup.service.js'
import { MediaResolverService } from './media-resolver.service.js'
import { MessageSendService } from './message-send.service.js'
import { MessageStoreService } from './message-store.service.js'
import { MessagesService } from './messages.service.js'
import { PolicyEventsService } from './policy-events.service.js'
import { PollsEventsService } from './polls-events.service.js'
import { PresenceProfileService } from './presence-profile.service.js'
import { RecipientResolverService } from './recipient-resolver.service.js'
import { SendPolicyAdminService } from './send-policy-admin.service.js'
import { SendPolicyService } from './send-policy.service.js'
import { PolicyStateStore, RedisPolicyStateStore } from './send-policy.store.js'
import { SendQueueService } from './send-queue.service.js'

// Sending: the send policy and the persistent send queue, and the message store they share a table with
@Module({
  imports: [WhatsAppModule],
  providers: [
    SendPolicyService,
    SendPolicyAdminService,
    PolicyEventsService,
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
    BroadcastsService,
    CallsService,
    ContactsService,
    ChannelsService,
    GroupsService,
    LabelsService,
    PresenceProfileService,
    LookupService,
    { provide: PolicyStateStore, useClass: RedisPolicyStateStore }
  ],
  exports: [
    SendPolicyService,
    SendPolicyAdminService,
    SendQueueService,
    IdempotentSendService,
    MessageStoreService,
    MessageSendService,
    MessagesService,
    PollsEventsService,
    ChatsService,
    BroadcastsService,
    CallsService,
    ContactsService,
    ChannelsService,
    GroupsService,
    LabelsService,
    PresenceProfileService,
    LookupService
  ]
})
export class MessagingModule {}
