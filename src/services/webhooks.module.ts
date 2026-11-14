import { Module } from '@nestjs/common'

import { WhatsAppModule } from '../whatsapp/whatsapp.module.js'

import { DeliveryQueueService } from './delivery-queue.service.js'
import { DeliveryProcessor } from './delivery.processor.js'
import { InboundHookService } from './inbound-hook.service.js'
import { WebhookDeliveriesService } from './webhook-deliveries.service.js'
import { WebhookDispatcherService } from './webhook-dispatcher.service.js'
import { WebhookMediaService } from './webhook-media.service.js'
import { WebhookService } from './webhook.service.js'

// Webhooks, outbound and inbound. Outbound: the webhooks, their deliveries, the queue the deliveries wait in, the
// dispatcher that fills it from the event bus and the processor that sends what is in it.
@Module({
  imports: [WhatsAppModule],
  providers: [
    WebhookService,
    InboundHookService,
    DeliveryQueueService,
    WebhookDeliveriesService,
    WebhookMediaService,
    WebhookDispatcherService,
    DeliveryProcessor
  ],
  exports: [WebhookService, InboundHookService, DeliveryQueueService, WebhookDeliveriesService]
})
export class WebhooksModule {}
