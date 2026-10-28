import { Module } from '@nestjs/common'
import { DiscoveryModule } from '@nestjs/core'

import { OperationRegistryService } from './operation-registry.service.js'

@Module({
  imports: [DiscoveryModule],
  providers: [OperationRegistryService],
  exports: [OperationRegistryService]
})
export class ApiModule {}
