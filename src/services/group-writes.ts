import { ForbiddenError } from '../common/errors.js'
import type { AppConfig } from '../config/env.schema.js'

// The writes to groups that ENABLE_GROUP_WRITES switches off. Called first in each of them, before
// the session is looked up, so a refusal never reaches the client (and so never reaches WhatsApp).
export function assertGroupWritesEnabled(config: Pick<AppConfig, 'ENABLE_GROUP_WRITES'>): void {
  if (config.ENABLE_GROUP_WRITES) return
  throw new ForbiddenError(
    'OPERATION_DISABLED',
    "disabled by configuration: set ENABLE_GROUP_WRITES=true; automating group creation or changes goes against WhatsApp's terms and can get the account blocked",
    { setting: 'ENABLE_GROUP_WRITES' }
  )
}
