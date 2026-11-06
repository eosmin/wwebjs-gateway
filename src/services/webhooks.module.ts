import { Module } from '@nestjs/common'

import { WhatsAppModule } from '../whatsapp/whatsapp.module.js'

import { DeliveryQueueService } from './delivery-queue.service.js'
import { DeliveryProcessor } from './delivery.processor.js'
import { WebhookDeliveriesService } from './webhook-deliveries.service.js'
import { WebhookDispatcherService } from './webhook-dispatcher.service.js'
import { WebhookService } from './webhook.service.js'

// Outbound webhooks: the webhooks, their deliveries, the queue the deliveries wait in, the
// dispatcher that fills it from the event bus and the processor that sends what is in it.
@Module({
  imports: [WhatsAppModule],
  providers: [
    WebhookService,
    DeliveryQueueService,
    WebhookDeliveriesService,
    WebhookDispatcherService,
    DeliveryProcessor
  ],
  exports: [WebhookService, DeliveryQueueService, WebhookDeliveriesService]
})
export class WebhooksModule {}
