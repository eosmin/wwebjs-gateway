import { Inject, Injectable, Logger } from '@nestjs/common'
import { z } from 'zod'

import { AppError, NotFoundError } from '../common/errors.js'
import { withTimeout } from '../common/lib/timeout.js'
import type { Suppression } from '../database/models.js'
import { SessionsRepository } from '../database/repositories/sessions.repository.js'
import { SuppressionsRepository } from '../database/repositories/suppressions.repository.js'
import { MetricsService } from '../infra/metrics/metrics.service.js'
import type {
  AddedSuppressionDto,
  EffectiveSendPolicy,
  SendPolicyUsageDto,
  SendPolicyViewDto,
  SuppressionDto,
  UnreachableChatsDto
} from '../types/send-policy-api.dto.js'
import { SendPolicySettings } from '../types/send-policy.dto.js'
import { EventPipelineService } from '../whatsapp/event-pipeline.service.js'

import { RecipientResolverService } from './recipient-resolver.service.js'
import { PolicyUnavailable, SendPolicyService } from './send-policy.service.js'
import { PolicyStateStore } from './send-policy.store.js'

// More flagged chats than this are not listed
const UNREACHABLE_LIST_LIMIT = 1000
const STORE_TIMEOUT_MS = 5_000

// Only the key this service owns; the rest of `Session.settings` belongs to other services
const Envelope = z.looseObject({ sendPolicy: SendPolicySettings.optional() })

const sessionNotFound = (id: string): NotFoundError =>
  new NotFoundError('NOT_FOUND', `Session ${id} does not exist`)

function toSuppressionDto(row: Suppression): SuppressionDto {
  return {
    chatId: row.chatId,
    reason: row.reason,
    note: row.note,
    createdAt: row.createdAt.toISOString()
  }
}

// The operations of the send policy and the suppression lists (TDD §6.8.1). The rules themselves
// are `SendPolicyService`; this reads and changes what they work from.
@Injectable()
export class SendPolicyAdminService {
  private readonly logger = new Logger(SendPolicyAdminService.name)

  constructor(
    @Inject(SendPolicyService) private readonly policy: SendPolicyService,
    @Inject(SessionsRepository) private readonly sessions: SessionsRepository,
    @Inject(SuppressionsRepository) private readonly suppressions: SuppressionsRepository,
    @Inject(RecipientResolverService) private readonly resolver: RecipientResolverService,
    @Inject(EventPipelineService) private readonly pipeline: EventPipelineService,
    @Inject(PolicyStateStore) private readonly store: PolicyStateStore,
    @Inject(MetricsService) private readonly metrics: MetricsService
  ) {}

  async get(sessionId: string): Promise<SendPolicyViewDto> {
    const session = await this.sessions.findById(sessionId)
    if (session === null) throw sessionNotFound(sessionId)
    const parsed = Envelope.safeParse(session.settings)
    const overrides = parsed.success ? (parsed.data.sendPolicy ?? {}) : {}
    return { effective: await this.effective(sessionId), overrides }
  }

  // Replaces the overrides as a whole, so `{}` puts every limit back to its default. The change
  // applies to the next decision.
  async put(sessionId: string, settings: SendPolicySettings): Promise<SendPolicyViewDto> {
    if (!(await this.sessions.mergeSettings(sessionId, { sendPolicy: settings }))) {
      throw sessionNotFound(sessionId)
    }
    this.policy.invalidateSettings(sessionId)
    return this.get(sessionId)
  }

  async usage(sessionId: string): Promise<SendPolicyUsageDto> {
    await this.requireSession(sessionId)
    try {
      const usage = await this.policy.usage(sessionId)
      return {
        at: new Date(usage.at).toISOString(),
        factor: usage.factor,
        warmup: {
          ...usage.warmup,
          linkedAt: usage.warmup.linkedAt?.toISOString() ?? null
        },
        throttle: {
          active: usage.throttle.active,
          until: usage.throttle.until === null ? null : new Date(usage.throttle.until).toISOString()
        },
        health: usage.health,
        coldSends: usage.coldSends,
        lookups: usage.lookups,
        buckets: usage.buckets,
        suppressedChats: await this.suppressions.countOf(sessionId)
      }
    } catch (error) {
      throw this.unavailable(error)
    }
  }

  async listSuppressions(sessionId: string): Promise<SuppressionDto[]> {
    await this.requireSession(sessionId)
    return (await this.suppressions.list(sessionId)).map(toSuppressionDto)
  }

  // A phone number is turned into the id the sends use (the same cached look-up), or the entry
  // would never match. Adding a chat that is already on the list changes nothing.
  async addSuppression(
    sessionId: string,
    to: string,
    note: string | undefined
  ): Promise<AddedSuppressionDto> {
    await this.requireSession(sessionId)
    const chatId = await this.resolver.resolve(sessionId, to)
    const { created, suppression } = await this.suppressions.add({
      sessionId,
      chatId,
      reason: 'manual',
      note: note ?? null
    })
    if (created) {
      await this.announce(sessionId, chatId)
      await this.refreshGauge()
    }
    return { ...toSuppressionDto(suppression), created }
  }

  async removeSuppression(sessionId: string, chatId: string): Promise<void> {
    await this.requireSession(sessionId)
    if (!(await this.suppressions.remove(sessionId, chatId))) {
      throw new NotFoundError('NOT_FOUND', 'The chat is not on the suppression list')
    }
    await this.refreshGauge()
  }

  async unreachableChats(sessionId: string): Promise<UnreachableChatsDto> {
    await this.requireSession(sessionId)
    let chats: string[]
    try {
      chats = await withTimeout(
        this.store.listUnreachable(sessionId, UNREACHABLE_LIST_LIMIT + 1),
        STORE_TIMEOUT_MS,
        'unreachable chats list'
      )
    } catch {
      throw new AppError('INTERNAL', 'The unreachable chats cannot be read right now')
    }
    return {
      items: chats.slice(0, UNREACHABLE_LIST_LIMIT).map(chatId => ({ chatId })),
      truncated: chats.length > UNREACHABLE_LIST_LIMIT
    }
  }

  // The gauge is read again from the table, not counted up and down. It is refreshed at boot and on
  // every change made here; other writers (opt-outs, a session deleted) must call it too (plan: 5.x)
  async refreshGauge(): Promise<void> {
    try {
      this.metrics.metrics.suppressedChats.set(await this.suppressions.countAll())
    } catch {
      this.logger.warn('The suppressed chats gauge could not be refreshed')
    }
  }

  private async effective(sessionId: string): Promise<EffectiveSendPolicy> {
    try {
      const limits = await this.policy.effective(sessionId)
      return { ...limits, quietHours: limits.quietHours ?? null }
    } catch (error) {
      throw this.unavailable(error)
    }
  }

  private async requireSession(sessionId: string): Promise<void> {
    if ((await this.sessions.findById(sessionId)) === null) throw sessionNotFound(sessionId)
  }

  // The consumers hear about it; the entry is stored either way, so a failure here is logged
  private async announce(sessionId: string, chatId: string): Promise<void> {
    try {
      await this.pipeline.publish(sessionId, 'chat_suppressed', { chatId, reason: 'manual' })
    } catch {
      this.logger.warn(`[${sessionId}] chat_suppressed could not be published`)
    }
  }

  private unavailable(error: unknown): Error {
    if (error instanceof PolicyUnavailable) return new AppError('INTERNAL', error.message)
    return error instanceof Error ? error : new Error('The send policy could not be read')
  }
}
