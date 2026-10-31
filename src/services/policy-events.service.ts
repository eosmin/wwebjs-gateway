import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'

import { MetricsService } from '../infra/metrics/metrics.service.js'
import { EventPipelineService } from '../whatsapp/event-pipeline.service.js'
import { SessionManager } from '../whatsapp/session-manager.service.js'

import { SendPolicyAdminService } from './send-policy-admin.service.js'
import { SendPolicyService, type DecisionEvent } from './send-policy.service.js'

// What the send policy reports about itself: its decisions go to the metrics, and a chat becoming
// unreachable (or reachable again) is published as `chat_unreachable`, and the gauge of suppressed
// chats follows the sessions that are deleted
@Injectable()
export class PolicyEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PolicyEventsService.name)
  private readonly stops: (() => void)[] = []

  constructor(
    @Inject(SendPolicyService) private readonly policy: SendPolicyService,
    @Inject(SendPolicyAdminService) private readonly admin: SendPolicyAdminService,
    @Inject(EventPipelineService) private readonly pipeline: EventPipelineService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @Inject(SessionManager) private readonly sessions: SessionManager
  ) {}

  onModuleInit(): void {
    this.stops.push(
      this.policy.onDecision(event => this.count(event)),
      this.policy.onReachabilityChange(change => {
        this.pipeline
          .publish(change.sessionId, 'chat_unreachable', {
            chatId: change.chatId,
            unreachable: change.unreachable
          })
          .catch(() => {
            this.logger.warn(`[${change.sessionId}] chat_unreachable could not be published`)
          })
      })
    )
    this.stops.push(
      this.pipeline.setIncomingPolicy(async (sessionId, chatId, text) => {
        const suppressed = await this.policy.handleIncoming(sessionId, chatId, text)
        if (suppressed) void this.admin.refreshGauge()
        return suppressed
      })
    )
    // The lists of a deleted session go with its row, so the gauge drops by their size
    this.stops.push(this.sessions.onRemoved(() => this.admin.refreshGauge()))
    void this.admin.refreshGauge()
  }

  onModuleDestroy(): void {
    for (const stop of this.stops.splice(0)) stop()
  }

  private count({ decision }: DecisionEvent): void {
    const { policyDecisions, policyDelaySeconds } = this.metrics.metrics
    if (decision.decision === 'allow') {
      policyDecisions.inc({ rule: 'none', decision: 'allow' })
      return
    }
    policyDecisions.inc({ rule: decision.rule, decision: decision.decision })
    if (decision.decision === 'delay') policyDelaySeconds.observe(decision.delayMs / 1000)
  }
}
