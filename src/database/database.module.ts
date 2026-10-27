import { Global, Module } from '@nestjs/common'

import { PrismaService } from './prisma.service.js'
import { ApiKeysRepository } from './repositories/api-keys.repository.js'
import { DeliveriesRepository } from './repositories/deliveries.repository.js'
import { IdempotencyRepository } from './repositories/idempotency.repository.js'
import { InboundHooksRepository } from './repositories/inbound-hooks.repository.js'
import { MessagesRepository } from './repositories/messages.repository.js'
import { SessionsRepository } from './repositories/sessions.repository.js'
import { SuppressionsRepository } from './repositories/suppressions.repository.js'
import { WebhooksRepository } from './repositories/webhooks.repository.js'

const REPOSITORIES = [
  ApiKeysRepository,
  DeliveriesRepository,
  IdempotencyRepository,
  InboundHooksRepository,
  MessagesRepository,
  SessionsRepository,
  SuppressionsRepository,
  WebhooksRepository
]

@Global()
@Module({
  providers: [PrismaService, ...REPOSITORIES],
  exports: [PrismaService, ...REPOSITORIES]
})
export class DatabaseModule {}
