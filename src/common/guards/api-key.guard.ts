import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { FastifyRequest } from 'fastify'

import { APP_CONFIG } from '../../config/config.module.js'
import type { AppConfig } from '../../config/env.schema.js'
import { AuthService } from '../../services/auth.service.js'
import { IS_PUBLIC_KEY, REQUIRED_SCOPE_KEY } from '../decorators/auth.decorators.js'
import { requestClientIp } from '../lib/client-ip.js'
import { type OperationScope, type Principal, assertScope } from '../principal.js'

// The request carries the principal from here on
export type AuthenticatedRequest = FastifyRequest & { principal?: Principal }

const BEARER = /^Bearer\s+(\S+)$/i

// X-API-Key wins over Authorization: Bearer; any other scheme is not a key
export function extractApiKey(request: FastifyRequest): string | undefined {
  const header = request.headers['x-api-key']
  if (typeof header === 'string' && header !== '') return header
  const authorization = request.headers.authorization
  return authorization === undefined ? undefined : BEARER.exec(authorization)?.[1]
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()]
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, targets) === true) {
      return true
    }
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const clientIp = requestClientIp(request, this.config.TRUST_PROXY_HOPS)
    const principal = await this.auth.authenticate(extractApiKey(request), clientIp)
    // A route that declares no scope is a mistake; it fails closed to admin keys only
    const scope =
      this.reflector.getAllAndOverride<OperationScope | undefined>(REQUIRED_SCOPE_KEY, targets) ??
      'admin'
    assertScope(principal, scope)
    request.principal = principal
    return true
  }
}
