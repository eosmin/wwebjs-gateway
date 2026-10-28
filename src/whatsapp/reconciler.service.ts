import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap
} from '@nestjs/common'

import { withTimeout } from '../common/lib/timeout.js'
import { APP_CONFIG } from '../config/config.module.js'
import type { AppConfig } from '../config/env.schema.js'
import { MessagesRepository } from '../database/repositories/messages.repository.js'
import { SessionsRepository } from '../database/repositories/sessions.repository.js'
import { MetricsService } from '../infra/metrics/metrics.service.js'
import type { MessageDto } from '../types/dto.js'

import { EventBusService, type Unsubscribe } from './event-bus.service.js'
import { EventPipelineService } from './event-pipeline.service.js'
import { SessionManager, type RunningSession } from './session-manager.service.js'
import type { AnyChatDto } from './whatsapp-client.port.js'

const HOUR_MS = 3_600_000
const DB_TIMEOUT_MS = 5000
const CHATS_TIMEOUT_MS = 60_000
const FETCH_TIMEOUT_MS = 15_000

const errorKind = (error: unknown): string => (error instanceof Error ? error.name : typeof error)

// A channel (newsletter) is not a conversation: nobody writes to the account there
const isConversation = (chat: AnyChatDto): boolean => !('isChannel' in chat)

// Closes the gaps a downtime or a missed event leaves (TDD §6.4): every time a session becomes
// ready it looks at its busiest chats and feeds the incoming messages the gateway never stored
// through the event pipeline, which orders them like any burst. A pass runs in the background; it
// stops as soon as the run it started on is over, and a failure on one chat never stops the rest.
@Injectable()
export class ReconcilerService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(ReconcilerService.name)
  // The run each session is being reconciled on: a second `ready` of the same run adds nothing
  private readonly active = new Map<string, number>()
  private unsubscribe: Unsubscribe | undefined
  private stopped = false

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(EventBusService) private readonly bus: EventBusService,
    @Inject(SessionManager) private readonly manager: SessionManager,
    @Inject(SessionsRepository) private readonly sessions: SessionsRepository,
    @Inject(MessagesRepository) private readonly messages: MessagesRepository,
    @Inject(EventPipelineService) private readonly pipeline: EventPipelineService,
    @Inject(MetricsService) private readonly metrics: MetricsService
  ) {}

  onApplicationBootstrap(): void {
    this.unsubscribe = this.bus.subscribe('session_status', envelope => {
      if (envelope.data.status === 'ready') void this.reconcile(envelope.sessionId)
    })
  }

  beforeApplicationShutdown(): void {
    this.stopped = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  // One pass for a session that just became ready; never rejects. Resolves with the number of
  // messages recovered.
  async reconcile(sessionId: string): Promise<number> {
    if (this.stopped || !this.config.RECONCILE_ON_READY) return 0
    if (this.config.RECONCILE_MAX_CHATS === 0 || this.config.RECONCILE_LOOKBACK_HOURS === 0) {
      return 0
    }
    const run = this.manager.running().find(candidate => candidate.id === sessionId)
    if (run?.status !== 'ready') return 0
    if (this.active.get(sessionId) === run.generation) return 0
    this.active.set(sessionId, run.generation)
    try {
      const recovered = await this.pass(run)
      if (recovered > 0) this.logger.log(`[${sessionId}] Recovered ${recovered} missed messages`)
      return recovered
    } catch (error: unknown) {
      this.logger.error(`[${sessionId}] Reconciliation failed (${errorKind(error)})`)
      return 0
    } finally {
      if (this.active.get(sessionId) === run.generation) this.active.delete(sessionId)
    }
  }

  private async pass(run: RunningSession): Promise<number> {
    const since = Date.now() - this.config.RECONCILE_LOOKBACK_HOURS * HOUR_MS
    const lastEventAt = (
      await withTimeout(this.sessions.findById(run.id), DB_TIMEOUT_MS, 'session read')
    )?.lastEventAt
    const chats = await withTimeout(run.client.getChats(), CHATS_TIMEOUT_MS, 'getChats')
    const visit = chats
      .filter(chat => isConversation(chat) && this.isCandidate(chat, since, lastEventAt))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, this.config.RECONCILE_MAX_CHATS)

    let recovered = 0
    for (const chat of visit) {
      if (!this.isCurrent(run)) break
      try {
        recovered += await this.recoverChat(run, chat.id, since)
      } catch (error: unknown) {
        this.logger.warn(`[${run.id}] Reconciling a chat failed (${errorKind(error)})`)
      }
    }
    return recovered
  }

  // Active inside the lookback, and either unread or newer than the last event the gateway saw
  // (no event on record: every active chat is a candidate)
  private isCandidate(
    chat: AnyChatDto,
    since: number,
    lastEventAt: Date | null | undefined
  ): boolean {
    const activeAt = chat.timestamp * 1000
    if (activeAt < since) return false
    return chat.unreadCount > 0 || lastEventAt == null || activeAt > lastEventAt.getTime()
  }

  private async recoverChat(run: RunningSession, chatId: string, since: number): Promise<number> {
    const fetched = await withTimeout(
      run.client.fetchMessages(chatId, { limit: this.config.RECONCILE_FETCH_LIMIT }),
      FETCH_TIMEOUT_MS,
      'fetchMessages'
    )
    const incoming = fetched.filter(
      message => !message.fromMe && new Date(message.sentAt).getTime() >= since
    )
    const missing = await this.missing(run.id, incoming)
    // The run may have ended while the chat was read: its pipeline is closed, or a new one is open
    if (missing.length === 0 || !this.isCurrent(run)) return 0
    const recovered = await this.pipeline.reconcile(run.id, missing)
    this.metrics.metrics.reconcileRecovered.inc(recovered)
    return recovered
  }

  private async missing(sessionId: string, incoming: MessageDto[]): Promise<MessageDto[]> {
    if (incoming.length === 0) return []
    const known = await withTimeout(
      this.messages.findExistingIds(
        sessionId,
        incoming.map(message => message.id)
      ),
      DB_TIMEOUT_MS,
      'messages read'
    )
    return incoming.filter(message => !known.has(message.id))
  }

  private isCurrent(run: RunningSession): boolean {
    if (this.stopped) return false
    return this.manager
      .running()
      .some(
        candidate =>
          candidate.id === run.id &&
          candidate.generation === run.generation &&
          candidate.status === 'ready'
      )
  }
}
