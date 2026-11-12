import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query
} from '@nestjs/common'
import { ZodResponse } from 'nestjs-zod'

import { CurrentPrincipal } from '../../common/decorators/auth.decorators.js'
import type { ErrorCode } from '../../common/errors.js'
import { type Principal, assertWebhookAccess } from '../../common/principal.js'
import { WebhookDeliveriesService } from '../../services/webhook-deliveries.service.js'
import {
  WebhookService,
  assertCredentialEventsAllowed,
  toWebhookDto
} from '../../services/webhook.service.js'
import {
  CreateWebhookDto,
  CreatedWebhookDto,
  DeliveryDto,
  DeliveryListDto,
  DeliveryListQueryDto,
  RetriedDeliveriesDto,
  TestWebhookBodyDto,
  UpdateWebhookDto,
  WebhookDeliveryParamsDto,
  WebhookDto,
  WebhookIdParamsDto,
  WebhookListDto
} from '../../types/webhooks.dto.js'
import { WaOperation } from '../wa-operation.decorator.js'

const WEBHOOK_ID = '7f0c3f4e-2b1a-4c55-9a52-0c1c3f6f2d10'
const DELIVERY_ID = '3b9a1c0e-6d2f-4f7e-8a41-5e0d7c9b1a22'

const WEBHOOK_EXAMPLE = {
  id: WEBHOOK_ID,
  sessionId: 'main',
  url: 'https://bot.example.com/hooks/whatsapp',
  events: ['message', 'message_batch'],
  enabled: true,
  mediaMode: 'reference',
  includeRaw: null,
  createdAt: '2026-01-01T00:00:00.000Z'
}

const SECRET_EXAMPLE = 'whsec_EXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE00'

const DELIVERY_EXAMPLE = {
  id: DELIVERY_ID,
  webhookId: WEBHOOK_ID,
  sessionId: 'main',
  event: 'message',
  seq: 42,
  status: 'failed',
  attempts: 10,
  lastStatusCode: 503,
  lastError: 'The receiver answered HTTP 503',
  createdAt: '2026-01-01T00:00:00.000Z',
  deliveredAt: null
}

const ON_WEBHOOK: ErrorCode[] = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'INSUFFICIENT_SCOPE',
  'NOT_FOUND'
]

// The webhooks of the gateway. An admin key reaches all of them; a session key only those of its
// session. Who may touch a webhook is decided here, before the services act on it, and everything
// under a webhook (its deliveries) follows the webhook.
@Controller('v1/webhooks')
export class WebhooksController {
  constructor(
    @Inject(WebhookService) private readonly webhooks: WebhookService,
    @Inject(WebhookDeliveriesService) private readonly deliveries: WebhookDeliveriesService
  ) {}

  @Post()
  @ZodResponse({ status: HttpStatus.CREATED, type: CreatedWebhookDto })
  @WaOperation({
    id: 'webhooks.create',
    scope: 'webhooks',
    summary: 'Create a webhook',
    description:
      'Events are POSTed to `url`, signed with the secret that this answer carries and no other ever will (rotate it to get a new one). Without `sessionId` the webhook receives the events of every session, which only an admin key can ask for. The URL must be public unless the gateway allows private targets. A session can have `WEBHOOKS_MAX_PER_SESSION` webhooks (so can the group of those of every session); one more is refused with `MAX_WEBHOOKS_REACHED`. `events` with `*` is every event but `qr` and `code`: a QR code or a pairing code links a device to the account, so a webhook may name them only with the `manage` scope as well.',
    errors: [...ON_WEBHOOK, 'MAX_WEBHOOKS_REACHED'],
    examples: {
      request: {
        url: 'https://bot.example.com/hooks/whatsapp',
        sessionId: 'main',
        events: ['message', 'message_batch']
      },
      response: { ...WEBHOOK_EXAMPLE, secret: SECRET_EXAMPLE }
    },
    wwebjs: [],
    gateway: true
  })
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateWebhookDto
  ): Promise<CreatedWebhookDto> {
    assertWebhookAccess(principal, body.sessionId ?? null)
    assertCredentialEventsAllowed(principal, body.events)
    return this.webhooks.create(body)
  }

  @Get()
  @ZodResponse({ type: WebhookListDto })
  @WaOperation({
    id: 'webhooks.list',
    scope: 'webhooks',
    summary: 'List the webhooks',
    description:
      'An admin key sees every webhook; a session key those of its session. The secrets are never returned.',
    errors: ['UNAUTHORIZED', 'INSUFFICIENT_SCOPE'],
    examples: { request: null, response: { webhooks: [WEBHOOK_EXAMPLE] } },
    wwebjs: [],
    gateway: true
  })
  async list(@CurrentPrincipal() principal: Principal): Promise<WebhookListDto> {
    return { webhooks: await this.webhooks.listFor(principal) }
  }

  @Get(':id')
  @ZodResponse({ type: WebhookDto })
  @WaOperation({
    id: 'webhooks.get',
    scope: 'webhooks',
    summary: 'Get a webhook',
    description: 'The secret is never returned.',
    errors: ON_WEBHOOK,
    examples: { request: null, response: WEBHOOK_EXAMPLE },
    wwebjs: [],
    gateway: true
  })
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param() { id }: WebhookIdParamsDto
  ): Promise<WebhookDto> {
    return toWebhookDto(await this.webhooks.requireFor(principal, id))
  }

  @Patch(':id')
  @ZodResponse({ type: WebhookDto })
  @WaOperation({
    id: 'webhooks.update',
    scope: 'webhooks',
    summary: 'Change a webhook',
    description:
      'Send only what changes. The session of a webhook never changes: delete it and create another. The deliveries already queued go to the new URL on their next attempt. Changing a webhook that names `qr` or `code` (or making it name them) needs the `manage` scope too.',
    errors: [...ON_WEBHOOK, 'WEBHOOK_CHANGED'],
    examples: { request: { enabled: false }, response: { ...WEBHOOK_EXAMPLE, enabled: false } },
    wwebjs: [],
    gateway: true
  })
  async update(
    @CurrentPrincipal() principal: Principal,
    @Param() { id }: WebhookIdParamsDto,
    @Body() body: UpdateWebhookDto
  ): Promise<WebhookDto> {
    await this.webhooks.requireFor(principal, id)
    // The `manage` check for the QR and pairing code events is made by the service, against the row
    // it writes: what the webhook listens to now counts too (its URL, or enabling it, decides who
    // gets the QR code)
    return this.webhooks.update(principal, id, body)
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @WaOperation({
    id: 'webhooks.delete',
    scope: 'webhooks',
    summary: 'Delete a webhook',
    description: 'Its deliveries go with it, the failed ones included.',
    errors: ON_WEBHOOK,
    examples: { request: null, response: null },
    wwebjs: [],
    gateway: true
  })
  async delete(
    @CurrentPrincipal() principal: Principal,
    @Param() { id }: WebhookIdParamsDto
  ): Promise<void> {
    await this.webhooks.requireFor(principal, id)
    await this.webhooks.delete(id)
  }

  @Post(':id/rotate-secret')
  @HttpCode(HttpStatus.OK)
  @ZodResponse({ type: CreatedWebhookDto })
  @WaOperation({
    id: 'webhooks.rotateSecret',
    scope: 'webhooks',
    summary: 'Rotate the secret of a webhook',
    description:
      'Issues a new secret, in this answer only (a webhook that names `qr` or `code` needs the `manage` scope too). The old one stops signing at once, and so does it for the deliveries that are waiting for a retry: the signature is made with the secret the webhook has at each attempt. Update the receiver first if it cannot accept both, or expect failed attempts until it does.',
    errors: [...ON_WEBHOOK, 'WEBHOOK_CHANGED'],
    examples: {
      request: null,
      response: { ...WEBHOOK_EXAMPLE, secret: SECRET_EXAMPLE }
    },
    wwebjs: [],
    gateway: true
  })
  async rotateSecret(
    @CurrentPrincipal() principal: Principal,
    @Param() { id }: WebhookIdParamsDto
  ): Promise<CreatedWebhookDto> {
    await this.webhooks.requireFor(principal, id)
    return this.webhooks.rotateSecret(principal, id)
  }

  @Post(':id/test')
  @HttpCode(HttpStatus.ACCEPTED)
  @ZodResponse({ status: HttpStatus.ACCEPTED, type: DeliveryDto })
  @WaOperation({
    id: 'webhooks.test',
    scope: 'webhooks',
    summary: 'Send a test event',
    description:
      'Queues a `ping` event to the webhook, through the same path as the real ones: the signature, the address check and the retries. The answer is the pending delivery; follow it in the list of deliveries. A webhook of every session needs `sessionId` to say which session the ping comes from. A ping has `seq: 0` and is not part of any session sequence. A webhook accepts `WEBHOOK_TEST_MAX_PER_MINUTE` pings a minute; one more is `429 RATE_LIMITED` with `Retry-After`.',
    errors: [...ON_WEBHOOK, 'RATE_LIMITED'],
    examples: {
      request: null,
      response: {
        ...DELIVERY_EXAMPLE,
        event: 'ping',
        seq: 0,
        status: 'pending',
        attempts: 0,
        lastStatusCode: null,
        lastError: null
      }
    },
    wwebjs: [],
    gateway: true
  })
  async test(
    @CurrentPrincipal() principal: Principal,
    @Param() { id }: WebhookIdParamsDto,
    @Body() body: TestWebhookBodyDto
  ): Promise<DeliveryDto> {
    return this.deliveries.test(await this.webhooks.requireFor(principal, id), body)
  }

  @Get(':id/deliveries')
  @ZodResponse({ type: DeliveryListDto })
  @WaOperation({
    id: 'webhooks.listDeliveries',
    scope: 'webhooks',
    summary: 'List the deliveries of a webhook',
    description:
      'Newest first, a page at a time. `status=failed` lists the dead letters: the deliveries that ran out of attempts. The events themselves are not returned.',
    errors: ON_WEBHOOK,
    examples: {
      request: null,
      response: { items: [DELIVERY_EXAMPLE], nextCursor: null }
    },
    wwebjs: [],
    gateway: true
  })
  async listDeliveries(
    @CurrentPrincipal() principal: Principal,
    @Param() { id }: WebhookIdParamsDto,
    @Query() query: DeliveryListQueryDto
  ): Promise<DeliveryListDto> {
    await this.webhooks.requireFor(principal, id)
    return this.deliveries.list(id, query)
  }

  @Post(':id/deliveries/retry-failed')
  @HttpCode(HttpStatus.OK)
  @ZodResponse({ type: RetriedDeliveriesDto })
  @WaOperation({
    id: 'webhooks.retryFailed',
    scope: 'webhooks',
    summary: 'Retry the dead letters of a webhook',
    description:
      'Puts the failed deliveries of the webhook back in the queue, up to 500 per call; `more` tells there are others, and calling again takes them. They are sent with the current URL and secret, in no particular order: the receiver orders by `seq`.',
    errors: ON_WEBHOOK,
    examples: { request: null, response: { retried: 12, more: false } },
    wwebjs: [],
    gateway: true
  })
  async retryFailed(
    @CurrentPrincipal() principal: Principal,
    @Param() { id }: WebhookIdParamsDto
  ): Promise<RetriedDeliveriesDto> {
    await this.webhooks.requireFor(principal, id)
    return this.deliveries.retryFailed(id)
  }

  @Post(':id/deliveries/:deliveryId/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @ZodResponse({ status: HttpStatus.ACCEPTED, type: DeliveryDto })
  @WaOperation({
    id: 'webhooks.retryDelivery',
    scope: 'webhooks',
    summary: 'Retry a delivery',
    description:
      'Puts a failed delivery back in the queue. Only a dead letter can be retried: a delivery that succeeded is never sent twice, and one that is still pending is already on its way (`404 NOT_FOUND` for both).',
    errors: ON_WEBHOOK,
    examples: { request: null, response: { ...DELIVERY_EXAMPLE, status: 'pending' } },
    wwebjs: [],
    gateway: true
  })
  async retryDelivery(
    @CurrentPrincipal() principal: Principal,
    @Param() { id, deliveryId }: WebhookDeliveryParamsDto
  ): Promise<DeliveryDto> {
    await this.webhooks.requireFor(principal, id)
    return this.deliveries.retry(id, deliveryId)
  }
}
