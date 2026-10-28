import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'

import { ApiKeyGuard } from '../common/guards/api-key.guard.js'

import { AuthService } from './auth.service.js'

// Every route is authenticated unless it says @Public()
@Module({
  providers: [AuthService, { provide: APP_GUARD, useClass: ApiKeyGuard }],
  exports: [AuthService]
})
export class AuthModule {}
