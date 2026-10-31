import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common'
import { ZodResponse } from 'nestjs-zod'

import type { ErrorCode } from '../../common/errors.js'
import { SendPolicyAdminService } from '../../services/send-policy-admin.service.js'
import {
  SendPolicyBodyDto,
  SendPolicyUsageDto,
  SendPolicyViewDto
} from '../../types/send-policy-api.dto.js'
import { SessionIdParamsDto } from '../../types/sessions.dto.js'
import { WaOperation } from '../wa-operation.decorator.js'

const ON_SESSION: ErrorCode[] = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'INSUFFICIENT_SCOPE',
  'NOT_FOUND',
  'INTERNAL'
]

// How the gateway paces a session and what it refuses to send (TDD §6.8.1). Gateway-native: there
// is nothing of whatsapp-web.js behind it, and the session does not have to be running.
@Controller('v1/sessions')
export class SendPolicyController {
  constructor(@Inject(SendPolicyAdminService) private readonly service: SendPolicyAdminService) {}

  @Get(':sessionId/send-policy')
  @ZodResponse({ type: SendPolicyViewDto })
  @WaOperation({
    id: 'sendPolicy.get',
    scope: 'read',
    summary: 'Read the send policy of a session',
    description:
      'The limits in force (`effective`: the environment defaults with the overrides of the session on top) and the overrides the session sets itself. What each limit does is in `docs/safety.md`.',
    errors: ON_SESSION,
    examples: {
      request: null,
      response: {
        effective: {
          allowColdSends: false,
          coldSendsPerDay: 30,
          coldSendMinGapMs: 120000,
          lookupsPerDay: 100,
          perChatMinIntervalMs: 3000,
          perChatMaxPerMinute: 6,
          sessionMaxPerMinute: 20,
          sessionMaxPerHour: 300,
          sessionMaxPerDay: 1500,
          optOutKeywords: ['stop'],
          quietHours: null
        },
        overrides: { optOutKeywords: ['stop'] }
      }
    },
    wwebjs: [],
    gateway: true
  })
  get(@Param() { sessionId }: SessionIdParamsDto): Promise<SendPolicyViewDto> {
    return this.service.get(sessionId)
  }

  @Put(':sessionId/send-policy')
  @ZodResponse({ type: SendPolicyViewDto })
  @WaOperation({
    id: 'sendPolicy.update',
    scope: 'manage',
    summary: 'Set the send policy overrides of a session',
    description:
      'Replaces the overrides of the session as a whole: a limit left out goes back to its environment default, and `{}` clears them all. Every limit has a ceiling (see `docs/safety.md`); a value above it is refused. The change applies to the next decision, to queued jobs too. It does not change the budgets already spent.',
    errors: ON_SESSION,
    examples: {
      request: { allowColdSends: true, coldSendsPerDay: 20, optOutKeywords: ['stop', 'baja'] },
      response: {
        effective: {
          allowColdSends: true,
          coldSendsPerDay: 20,
          coldSendMinGapMs: 120000,
          lookupsPerDay: 100,
          perChatMinIntervalMs: 3000,
          perChatMaxPerMinute: 6,
          sessionMaxPerMinute: 20,
          sessionMaxPerHour: 300,
          sessionMaxPerDay: 1500,
          optOutKeywords: ['stop', 'baja'],
          quietHours: null
        },
        overrides: { allowColdSends: true, coldSendsPerDay: 20, optOutKeywords: ['stop', 'baja'] }
      }
    },
    wwebjs: [],
    gateway: true
  })
  update(
    @Param() { sessionId }: SessionIdParamsDto,
    @Body() body: SendPolicyBodyDto
  ): Promise<SendPolicyViewDto> {
    return this.service.put(sessionId, body)
  }

  @Get(':sessionId/send-policy/usage')
  @ZodResponse({ type: SendPolicyUsageDto })
  @WaOperation({
    id: 'sendPolicy.usage',
    scope: 'read',
    summary: 'See how much of its budgets a session has spent',
    description:
      'The levels of the session budgets right now, the new chats messaged and the number look-ups of the last 24 hours against their limits, the warm-up factor, the health score and whether the throttle is halving the budgets. Reading it spends nothing. Limits are already scaled by `factor`.',
    errors: ON_SESSION,
    examples: {
      request: null,
      response: {
        at: '2026-10-31T12:00:00.000Z',
        factor: 0.5,
        warmup: { factor: 0.5, linkedAt: '2026-10-30T09:00:00.000Z', days: 7 },
        throttle: { active: false, until: null },
        health: { samples: 12, hardFailures: 1, maxBadRatio: 0.3, minSamples: 10 },
        coldSends: { used: 3, limit: 15 },
        lookups: { used: 4, limit: 50 },
        buckets: {
          perMinute: { available: 10, limit: 10 },
          perHour: { available: 140, limit: 150 },
          perDay: { available: 700, limit: 750 }
        },
        suppressedChats: 2
      }
    },
    wwebjs: [],
    gateway: true
  })
  usage(@Param() { sessionId }: SessionIdParamsDto): Promise<SendPolicyUsageDto> {
    return this.service.usage(sessionId)
  }
}
