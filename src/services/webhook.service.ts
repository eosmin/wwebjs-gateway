import { Inject, Injectable } from '@nestjs/common'

import { NotFoundError } from '../common/errors.js'
import { generateWebhookSecret } from '../common/lib/crypto.js'
import { assertPublicHttpUrl } from '../common/lib/ssrf.js'
import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/env.schema.js'
import type { Webhook } from '../database/models.js'
import { SessionsRepository } from '../database/repositories/sessions.repository.js'
import { WebhooksRepository } from '../database/repositories/webhooks.repository.js'
import type {
  CreatedWebhookDto,
  CreateWebhookDto,
  UpdateWebhookDto,
  WebhookDto
} from '../types/webhooks.dto.js'

// The secret is not part of the DTO: it leaves the gateway on creation and rotation only
export function toWebhookDto(row: Webhook): WebhookDto {
  return {
    id: row.id,
    sessionId: row.sessionId,
    url: row.url,
    events: row.events,
    enabled: row.enabled,
    mediaMode: row.mediaMode,
    includeRaw: row.includeRaw,
    createdAt: row.createdAt.toISOString()
  }
}

export function receivesEvent(webhook: Pick<Webhook, 'events'>, event: string): boolean {
  return webhook.events.includes('*') || webhook.events.includes(event)
}

// What the webhooks routes do, and the list of enabled webhooks the dispatcher reads for every
// event. That list is cached; every write here drops the cache.
@Injectable()
export class WebhookService {
  private readonly enabledBySession = new Map<string, readonly Webhook[]>()
  // Counts the writes: a read that started before one must not put its (stale) answer in the cache
  private generation = 0

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(WebhooksRepository) private readonly webhooks: WebhooksRepository,
    @Inject(SessionsRepository) private readonly sessions: SessionsRepository
  ) {}

  async list(sessionId?: string): Promise<WebhookDto[]> {
    return (await this.webhooks.list(sessionId)).map(toWebhookDto)
  }

  async get(id: string): Promise<WebhookDto> {
    return toWebhookDto(await this.require(id))
  }

  // The row the delivery code needs, with the secret
  async require(id: string): Promise<Webhook> {
    const row = await this.webhooks.findById(id)
    if (row === null) throw webhookNotFound(id)
    return row
  }

  async create(input: CreateWebhookDto): Promise<CreatedWebhookDto> {
    if (input.sessionId !== undefined && (await this.sessions.findById(input.sessionId)) === null) {
      throw sessionNotFound(input.sessionId)
    }
    await this.assertAllowedUrl(input.url)
    const secret = generateWebhookSecret()
    const row = await this.write(() =>
      this.webhooks.create({
        sessionId: input.sessionId ?? null,
        url: input.url,
        secret,
        events: input.events && normalizeEvents(input.events),
        enabled: input.enabled,
        mediaMode: input.mediaMode,
        includeRaw: input.includeRaw
      })
    )
    // The session can be deleted between the check above and the insert; the foreign key says so
    if (row === null) throw sessionNotFound(input.sessionId ?? '')
    return { ...toWebhookDto(row), secret }
  }

  async update(id: string, patch: UpdateWebhookDto): Promise<WebhookDto> {
    if (patch.url !== undefined) {
      // A missing webhook answers 404 before the URL is resolved
      await this.require(id)
      await this.assertAllowedUrl(patch.url)
    }
    const row = await this.write(() =>
      this.webhooks.update(id, {
        ...patch,
        events: patch.events && normalizeEvents(patch.events)
      })
    )
    if (row === null) throw webhookNotFound(id)
    return toWebhookDto(row)
  }

  // The old secret stops signing at once: deliveries still waiting to be retried are signed with
  // the new one, because the processor reads the secret at each attempt
  async rotateSecret(id: string): Promise<CreatedWebhookDto> {
    const secret = generateWebhookSecret()
    const row = await this.write(() => this.webhooks.update(id, { secret }))
    if (row === null) throw webhookNotFound(id)
    return { ...toWebhookDto(row), secret }
  }

  async delete(id: string): Promise<void> {
    const deleted = await this.write(() => this.webhooks.delete(id))
    if (!deleted) throw webhookNotFound(id)
  }

  // The enabled webhooks that want `event` from `sessionId`: its own and those of every session
  async forEvent(sessionId: string, event: string): Promise<Webhook[]> {
    const enabled = await this.enabledFor(sessionId)
    return enabled.filter(webhook => receivesEvent(webhook, event))
  }

  private async enabledFor(sessionId: string): Promise<readonly Webhook[]> {
    const cached = this.enabledBySession.get(sessionId)
    if (cached !== undefined) return cached
    const generation = this.generation
    const rows = await this.webhooks.listEnabledFor(sessionId)
    if (generation === this.generation) this.enabledBySession.set(sessionId, rows)
    return rows
  }

  // The cache is dropped whatever the write came to: one that threw (a timeout) may have committed
  private async write<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } finally {
      this.invalidate()
    }
  }

  private invalidate(): void {
    this.generation += 1
    this.enabledBySession.clear()
  }

  // The same guard runs again before every delivery; this one refuses a URL that can never work
  private async assertAllowedUrl(url: string): Promise<void> {
    await assertPublicHttpUrl(url, {
      privateHostAllowlist: this.config.WEBHOOK_PRIVATE_HOST_ALLOWLIST,
      allowPrivate: this.config.ALLOW_PRIVATE_WEBHOOK_TARGETS
    })
  }
}

// "*" already means every event, so it replaces any other entry
const normalizeEvents = (values: string[]): string[] =>
  values.includes('*') ? ['*'] : [...new Set(values)]

const webhookNotFound = (id: string): NotFoundError =>
  new NotFoundError('NOT_FOUND', `Webhook "${id}" does not exist`)

const sessionNotFound = (id: string): NotFoundError =>
  new NotFoundError('NOT_FOUND', `Session "${id}" does not exist`)
