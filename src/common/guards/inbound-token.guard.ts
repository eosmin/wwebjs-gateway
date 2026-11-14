import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  createParamDecorator
} from '@nestjs/common'
import type { FastifyRequest } from 'fastify'

import { type InboundHookGrant, InboundHookService } from '../../services/inbound-hook.service.js'
import { InternalError, UnauthorizedError } from '../errors.js'

export type InboundRequest = FastifyRequest & { inboundGrant?: InboundHookGrant }

// Authenticates a request by the token in its path, for the routes that are public to the API key
// guard. It runs before the body is validated, so a caller with no valid token costs a lookup and
// nothing more, and a hook that is over its allowance is refused before its body is parsed.
@Injectable()
export class InboundTokenGuard implements CanActivate {
  constructor(@Inject(InboundHookService) private readonly hooks: InboundHookService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<InboundRequest>()
    const { token } = (request.params ?? {}) as { token?: unknown }
    if (typeof token !== 'string') throw new UnauthorizedError('UNAUTHORIZED')
    const grant = await this.hooks.resolve(token)
    this.hooks.admitSend(grant.hookId)
    request.inboundGrant = grant
    return true
  }
}

// What the token behind the request stands for. The guard sets it, so a missing one is a wiring
// mistake and never falls back to any session.
export const CurrentInboundGrant = createParamDecorator(
  (_data: unknown, context: ExecutionContext): InboundHookGrant => {
    const grant = context.switchToHttp().getRequest<InboundRequest>().inboundGrant
    if (grant === undefined) {
      throw new InternalError('INTERNAL', 'The request reached the operation without a hook')
    }
    return grant
  }
)
