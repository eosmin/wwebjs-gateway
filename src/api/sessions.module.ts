import { Module } from '@nestjs/common'

import { AuthModule } from '../services/auth.module.js'
import { SessionsService } from '../services/sessions.service.js'
import { WhatsAppModule } from '../whatsapp/whatsapp.module.js'

import { SessionsController } from './controllers/sessions.controller.js'

@Module({
  imports: [AuthModule, WhatsAppModule],
  controllers: [SessionsController],
  providers: [SessionsService]
})
export class SessionsModule {}
