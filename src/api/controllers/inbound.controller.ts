import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UseGuards
} from '@nestjs/common'
import { ApiAcceptedResponse, ApiBody } from '@nestjs/swagger'
import type { FastifyReply } from 'fastify'
import { ZodResponse, ZodValidationPipe } from 'nestjs-zod'

import { Public } from '../../common/decorators/auth.decorators.js'
import type { ErrorCode } from '../../common/errors.js'
import { CurrentInboundGrant, InboundTokenGuard } from '../../common/guards/inbound-token.guard.js'
import { type InboundHookGrant, InboundHookService } from '../../services/inbound-hook.service.js'
import { MessageSendService } from '../../services/message-send.service.js'
import {
  CreateInboundHookDto,
  CreatedInboundHookDto,
  InboundHookDto,
  InboundHookListDto,
  InboundHookParamsDto,
  InboundTokenParamsDto
} from '../../types/inbound-hooks.dto.js'
import {
  InboundSendBody,
  InboundShortBody,
  SendJobDto,
  SendMessageBody,
  SendQueryDto
} from '../../types/messages.dto.js'
import { SessionIdParamsDto } from '../../types/sessions.dto.js'
import { requestSchemaOf } from '../request-schema.js'
import { WaOperation } from '../wa-operation.decorator.js'

import { SEND_ERRORS, idempotencyKeyOf, sendAnswer } from './send-answer.js'

const HOOK_ID = '7f0c3f4e-2b1a-4c55-9a52-0c1c3f6f2d10'
const TOKEN_EXAMPLE = 'EXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE0'

const HOOK_EXAMPLE = {
  id: HOOK_ID,
  sessionId: 'main',
  name: 'crisp',
  createdAt: '2026-01-01T00:00:00.000Z',
  revokedAt: null
}

const ON_HOOK: ErrorCode[] = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'INSUFFICIENT_SCOPE',
  'NOT_FOUND'
]

// What a caller of the token route can get: the send errors, the token and the allowance of the hook.
// The token is the whole credential, so there is no key to be out of scope for.
const ON_INBOUND: ErrorCode[] = [
  ...SEND_ERRORS.filter(code => code !== 'FORBIDDEN' && code !== 'INSUFFICIENT_SCOPE'),
  'RATE_LIMITED'
]

// The idempotency table is per session, and two hooks of a session belong to different callers: the key of a
// caller is kept apart from the keys of the others (and from those of `messages.send`) by the hook it came through
const hookScoped = (grant: InboundHookGrant, key: string | undefined): string | undefined =>
  key === undefined ? undefined : `inbound:${grant.hookId}:${key}`

// The inbound hooks of a session, and the route that uses one. Managing the hooks needs a key with the
// `webhooks` scope that reaches the session (the ApiKeyGuard checks the session of the path, so a key of
// another session never gets here); sending through one needs only the token.
@Controller('v1')
export class InboundController {
  constructor(
    @Inject(InboundHookService) private readonly hooks: InboundHookService,
    @Inject(MessageSendService) private readonly sender: MessageSendService
  ) {}

  @Post('sessions/:sessionId/inbound-hooks')
  @ZodResponse({ status: HttpStatus.CREATED, type: CreatedInboundHookDto })
  @WaOperation({
    id: 'inboundHooks.create',
    scope: 'webhooks',
    summary: 'Create an inbound hook',
    description:
      'An inbound hook is a secret URL that lets another system send a message through the session, with no API key. The URL is in this answer and in no other: only its sha256 is stored, so a lost URL is replaced by revoking the hook and creating another. Treat it as a password and keep it out of logs. A session can have `WEBHOOKS_MAX_PER_SESSION` active hooks; one more is refused with `MAX_INBOUND_HOOKS_REACHED`.',
    errors: [...ON_HOOK, 'MAX_INBOUND_HOOKS_REACHED'],
    examples: {
      request: { name: 'crisp' },
      response: {
        ...HOOK_EXAMPLE,
        url: `https://gateway.example.com/v1/hooks/inbound/${TOKEN_EXAMPLE}`
      }
    },
    wwebjs: [],
    gateway: true
  })
  create(
    @Param() { sessionId }: SessionIdParamsDto,
    @Body() { name }: CreateInboundHookDto
  ): Promise<CreatedInboundHookDto> {
    return this.hooks.create(sessionId, name)
  }

  @Get('sessions/:sessionId/inbound-hooks')
  @ZodResponse({ type: InboundHookListDto })
  @WaOperation({
    id: 'inboundHooks.list',
    scope: 'webhooks',
    summary: 'List the inbound hooks of a session',
    description: 'Newest first, the revoked ones included. The URLs are never returned.',
    errors: ON_HOOK,
    examples: { request: null, response: { hooks: [HOOK_EXAMPLE] } },
    wwebjs: [],
    gateway: true
  })
  async list(@Param() { sessionId }: SessionIdParamsDto): Promise<InboundHookListDto> {
    return { hooks: await this.hooks.list(sessionId) }
  }

  @Delete('sessions/:sessionId/inbound-hooks/:hookId')
  @ZodResponse({ type: InboundHookDto })
  @WaOperation({
    id: 'inboundHooks.revoke',
    scope: 'webhooks',
    summary: 'Revoke an inbound hook',
    description:
      'The URL answers `401` from then on, at once. Revoking is final and can be repeated; the hook stays in the list with its `revokedAt`, and no longer counts against the limit.',
    errors: ON_HOOK,
    examples: {
      request: null,
      response: { ...HOOK_EXAMPLE, revokedAt: '2026-01-02T00:00:00.000Z' }
    },
    wwebjs: [],
    gateway: true
  })
  revoke(@Param() { sessionId, hookId }: InboundHookParamsDto): Promise<InboundHookDto> {
    return this.hooks.revoke(sessionId, hookId)
  }

  // Public for the API key guard: the token in the path is the credential. The guard of the route
  // resolves it (and counts the request against the allowance of the hook) before the body is read.
  @Public()
  @UseGuards(InboundTokenGuard)
  @Post('hooks/inbound/:token')
  @ZodResponse({ status: HttpStatus.CREATED, type: SendJobDto })
  @ApiAcceptedResponse({ type: SendJobDto, description: 'Queued; the outcome comes as an event' })
  @ApiBody({ schema: requestSchemaOf(SendMessageBody.or(InboundShortBody)) })
  @WaOperation({
    id: 'inboundHooks.send',
    scope: 'send',
    summary: 'Send a message through an inbound hook',
    description:
      'No API key: the token in the URL is the credential, and it sends through the session of its hook only. The body is the one of `messages.send`, or the short `{ "to", "text" }`, which sends a text. The message takes the same path as any other send (the send queue, the send policy, the pacing), answers 201 with the message or 202 with the job like `messages.send` does, and honors `Idempotency-Key` and `wait`. A hook accepts `INBOUND_HOOK_MAX_PER_MINUTE` requests a minute (`429 RATE_LIMITED` with `Retry-After`), on top of the allowance of the address. A malformed, unknown or revoked token is the same `401`. The body is limited to 1 MiB, so media goes by `source.url` or `source.messageId`, not as base64.',
    errors: ON_INBOUND,
    examples: {
      request: { to: '+52 55 0000 0001', text: 'Hola, tu pedido va en camino' },
      response: { jobId: 'idem-3f2a', status: 'queued' }
    },
    wwebjs: ['Client.sendMessage', 'Chat.sendMessage']
  })
  async send(
    @Param() _params: InboundTokenParamsDto,
    @CurrentInboundGrant() grant: InboundHookGrant,
    @Query() { wait }: SendQueryDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(InboundSendBody)) body: SendMessageBody,
    @Res({ passthrough: true }) reply: FastifyReply
  ): Promise<SendJobDto> {
    const result = await this.sender.send(
      {
        sessionId: grant.sessionId,
        wait,
        idempotencyKey: hookScoped(grant, idempotencyKeyOf(idempotencyKey))
      },
      body
    )
    return sendAnswer(result, reply)
  }
}
