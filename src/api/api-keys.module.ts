import { Module } from '@nestjs/common'

import { ApiKeysService } from '../services/api-keys.service.js'
import { AuthModule } from '../services/auth.module.js'

import { ApiKeysController } from './controllers/api-keys.controller.js'

@Module({
  imports: [AuthModule],
  controllers: [ApiKeysController],
  providers: [ApiKeysService]
})
export class ApiKeysModule {}
