import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common'

import { InternalError } from '../errors.js'
import type { AuthenticatedRequest } from '../guards/api-key.guard.js'
import type { OperationScope, Principal } from '../principal.js'

export const IS_PUBLIC_KEY = 'gateway:isPublic'
export const REQUIRED_SCOPE_KEY = 'gateway:requiredScope'

// Opts a route out of the global ApiKeyGuard
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true)

// The scope the guard enforces; @WaOperation sets it for every operation of the registry
export const RequireScope = (scope: OperationScope): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_SCOPE_KEY, scope)

// The key behind the request, for the operations that decide by it what they may touch. The guard
// sets it on every route that is not @Public, so a missing one is a wiring mistake: it never
// falls back to an admin.
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const principal = context.switchToHttp().getRequest<AuthenticatedRequest>().principal
    if (principal === undefined) {
      throw new InternalError('INTERNAL', 'The request reached the operation without a principal')
    }
    return principal
  }
)
