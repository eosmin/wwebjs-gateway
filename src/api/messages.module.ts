import { Module } from '@nestjs/common'

import { AuthModule } from '../services/auth.module.js'
import { MessagingModule } from '../services/messaging.module.js'

import { ChatsController } from './controllers/chats.controller.js'
import { MessagesController } from './controllers/messages.controller.js'
import { PollsEventsController } from './controllers/polls-events.controller.js'

@Module({
  imports: [AuthModule, MessagingModule],
  controllers: [ChatsController, MessagesController, PollsEventsController]
})
export class MessagesModule {}
