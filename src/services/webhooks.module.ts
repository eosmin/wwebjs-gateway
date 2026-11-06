import { Module } from '@nestjs/common'

import { WhatsAppModule } from '../whatsapp/whatsapp.module.js'

import { DeliveryQueueService } from './delivery-queue.service.js'
import { WebhookDeliveriesService } from './webhook-deliveries.service.js'
import { WebhookDispatcherService } from './webhook-dispatcher.service.js'
import { WebhookService } from './webhook.service.js'

// Outbound webhooks: the webhooks, their deliveries, the queue the deliveries wait in and the
// dispatcher that fills it from the event bus. The processor (7.4) joins them here.
@Module({
  imports: [WhatsAppModule],
  providers: [
    WebhookService,
    DeliveryQueueService,
    WebhookDeliveriesService,
    WebhookDispatcherService
  ],
  exports: [WebhookService, DeliveryQueueService, WebhookDeliveriesService]
})
export class WebhooksModule {}
