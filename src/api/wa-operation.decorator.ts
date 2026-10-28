import { SetMetadata, applyDecorators } from '@nestjs/common'

import { RequireScope } from '../common/decorators/auth.decorators.js'

import type { WaOperationMeta } from './wa-operation.schema.js'

export const WA_OPERATION_KEY = 'gateway:waOperation'

// Marks a controller method as one capability of the registry. It also sets the scope the
// ApiKeyGuard enforces, so the metadata and the enforcement cannot disagree.
export const WaOperation = (meta: WaOperationMeta): MethodDecorator =>
  applyDecorators(SetMetadata(WA_OPERATION_KEY, meta), RequireScope(meta.scope))
