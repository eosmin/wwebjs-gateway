import { Module } from '@nestjs/common'

import { AuthModule } from '../services/auth.module.js'
import { MessagingModule } from '../services/messaging.module.js'

import { ChannelsController } from './controllers/channels.controller.js'
import { ChatsController } from './controllers/chats.controller.js'
import { ContactsController } from './controllers/contacts.controller.js'
import { GroupsController } from './controllers/groups.controller.js'
import { LabelsController } from './controllers/labels.controller.js'
import { LookupController } from './controllers/lookup.controller.js'
import { MessagesController } from './controllers/messages.controller.js'
import { PollsEventsController } from './controllers/polls-events.controller.js'
import { PresenceProfileController } from './controllers/presence-profile.controller.js'
import { SendPolicyController } from './controllers/send-policy.controller.js'
import { SettingsController } from './controllers/settings.controller.js'
import { SuppressionsController } from './controllers/suppressions.controller.js'

@Module({
  imports: [AuthModule, MessagingModule],
  controllers: [
    ChatsController,
    ContactsController,
    ChannelsController,
    GroupsController,
    LabelsController,
    LookupController,
    MessagesController,
    PollsEventsController,
    PresenceProfileController,
    SendPolicyController,
    SettingsController,
    SuppressionsController
  ]
})
export class MessagesModule {}
