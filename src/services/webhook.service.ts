import { Inject, Injectable } from '@nestjs/common'

import { ConflictError, NotFoundError, ValidationError } from '../common/errors.js'
import { generateWebhookSecret } from '../common/lib/crypto.js'
import { assertPublicHttpUrl } from '../common/lib/ssrf.js'
import { type Principal, assertScope, assertWebhookAccess } from '../common/principal.js'
import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/env.schema.js'
import type { Webhook } from '../database/models.js'
import { SessionsRepository } from '../database/repositories/sessions.repository.js'
import { WebhooksRepository } from '../database/repositories/webhooks.repository.js'
import { CREDENTIAL_EVENTS } from '../types/events.js'
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

// `*` is every event but the credential ones (qr, code): those are delivered only to a webhook that
// names them, and only a key with the `manage` scope may name them
export function receivesEvent(webhook: Pick<Webhook, 'events'>, event: string): boolean {
  if (webhook.events.includes(event)) return true
  return webhook.events.includes('*') && !CREDENTIAL_EVENTS.includes(event)
}

export const listensToCredentials = (events: readonly string[] | undefined): boolean =>
  events?.some(event => CREDENTIAL_EVENTS.includes(event)) === true

// A QR code or a pairing code lets whoever receives it link a device to the account, so a webhook
// that gets them is a `manage` matter, not a `webhooks` one
export function assertCredentialEventsAllowed(
  principal: Principal,
  events: readonly string[] | undefined
): void {
  if (listensToCredentials(events)) assertScope(principal, 'manage')
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

  // What the key behind a request may see: an admin key every webhook, a session key its own
  async listFor(principal: Principal): Promise<WebhookDto[]> {
    return this.list(principal.sessionId ?? undefined)
  }

  // The webhook of an operation by id, once the key is known to be allowed to reach it. The one
  // place the routes decide it, for the webhook and for everything under it (secret, deliveries).
  async requireFor(principal: Principal, id: string): Promise<Webhook> {
    const row = await this.require(id)
    assertWebhookAccess(principal, row.sessionId)
    return row
  }

  async create(input: CreateWebhookDto): Promise<CreatedWebhookDto> {
    this.assertRawAvailable(input.includeRaw)
    if (input.sessionId !== undefined && (await this.sessions.findById(input.sessionId)) === null) {
      throw sessionNotFound(input.sessionId)
    }
    await this.assertAllowedUrl(input.url)
    const secret = generateWebhookSecret()
    const bucket = input.sessionId ?? null
    // The count and the insert are one step per session (this is one instance), so a burst of
    // creations cannot pass the limit; the slow part, the address check, is outside the lock
    const row = await this.exclusive(bucket, async () => {
      await this.assertRoomFor(bucket)
      return this.write(() =>
        this.webhooks.create({
          sessionId: bucket,
          url: input.url,
          secret,
          events: input.events && normalizeEvents(input.events),
          enabled: input.enabled,
          mediaMode: input.mediaMode,
          includeRaw: input.includeRaw
        })
      )
    })
    // The session can be deleted between the check above and the insert; the foreign key says so
    if (row === null) throw sessionNotFound(input.sessionId ?? '')
    return { ...toWebhookDto(row), secret }
  }

  async update(id: string, patch: UpdateWebhookDto): Promise<WebhookDto> {
    this.assertRawAvailable(patch.includeRaw)
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

  // Every webhook a session has is one more job in Redis for each of its events, so the number is
  // bounded. Called inside `exclusive`, so nothing is created between the count and the insert.
  private async assertRoomFor(sessionId: string | null): Promise<void> {
    const limit = this.config.WEBHOOKS_MAX_PER_SESSION
    if ((await this.webhooks.countFor(sessionId)) >= limit) {
      throw new ConflictError(
        'MAX_WEBHOOKS_REACHED',
        `The session already has ${limit} webhooks, the most it can have`
      )
    }
  }

  // With INCLUDE_RAW off the pipeline attaches no `raw` to any message, and a webhook can only keep
  // or drop what the event has. Saying so here beats a webhook that asks for it and never gets it.
  private assertRawAvailable(includeRaw: boolean | null | undefined): void {
    if (includeRaw === true && !this.config.INCLUDE_RAW) {
      throw new ValidationError(
        'VALIDATION_ERROR',
        'includeRaw cannot be true while INCLUDE_RAW is off: the gateway attaches no raw data to messages'
      )
    }
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

  // The tail of the creations of each session (null = every session): the next one waits for it
  private readonly creating = new Map<string | null, Promise<unknown>>()

  private async exclusive<T>(bucket: string | null, task: () => Promise<T>): Promise<T> {
    const previous = this.creating.get(bucket) ?? Promise.resolve()
    const run = previous.then(task, task)
    const tail = run.catch(() => undefined)
    this.creating.set(bucket, tail)
    try {
      return await run
    } finally {
      if (this.creating.get(bucket) === tail) this.creating.delete(bucket)
    }
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

  // Drops the cache of enabled webhooks. A write here does it; whoever deletes webhooks from outside
  // (a session goes with its webhooks, by cascade) must call it too.
  invalidate(): void {
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
// A wildcard replaces the other names, except the credential ones: `*` does not carry them
const normalizeEvents = (values: string[]): string[] =>
  values.includes('*')
    ? ['*', ...new Set(values.filter(value => CREDENTIAL_EVENTS.includes(value)))]
    : [...new Set(values)]

const webhookNotFound = (id: string): NotFoundError =>
  new NotFoundError('NOT_FOUND', `Webhook "${id}" does not exist`)

const sessionNotFound = (id: string): NotFoundError =>
  new NotFoundError('NOT_FOUND', `Session "${id}" does not exist`)
