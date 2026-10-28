import { SetMetadata } from '@nestjs/common'

import type { OperationScope } from '../principal.js'

export const IS_PUBLIC_KEY = 'gateway:isPublic'
export const REQUIRED_SCOPE_KEY = 'gateway:requiredScope'

// Opts a route out of the global ApiKeyGuard
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true)

// The scope the guard enforces; @WaOperation sets it for every operation of the registry
export const RequireScope = (scope: OperationScope): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_SCOPE_KEY, scope)
