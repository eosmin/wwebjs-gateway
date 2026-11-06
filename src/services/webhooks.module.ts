import { Module } from '@nestjs/common'

import { DeliveryQueueService } from './delivery-queue.service.js'
import { WebhookDeliveriesService } from './webhook-deliveries.service.js'
import { WebhookService } from './webhook.service.js'

// Outbound webhooks: the webhooks, their deliveries and the queue the deliveries wait in. The
// dispatcher (7.3) and the processor (7.4) join them here.
@Module({
  providers: [WebhookService, DeliveryQueueService, WebhookDeliveriesService],
  exports: [WebhookService, DeliveryQueueService, WebhookDeliveriesService]
})
export class WebhooksModule {}
