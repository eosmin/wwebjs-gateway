import { Module } from '@nestjs/common'

import { SendPolicyService } from './send-policy.service.js'
import { PolicyStateStore, RedisPolicyStateStore } from './send-policy.store.js'

// Sending: the send policy now; the queue and the message store join it in the next steps
@Module({
  providers: [SendPolicyService, { provide: PolicyStateStore, useClass: RedisPolicyStateStore }],
  exports: [SendPolicyService]
})
export class MessagingModule {}
