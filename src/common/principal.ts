import { ForbiddenError } from './errors.js'

// What a key can be granted. `admin` is not here: no key can hold it, only admin keys pass it.
export const KEY_SCOPES = ['read', 'send', 'manage', 'webhooks', 'events'] as const
export type KeyScope = (typeof KEY_SCOPES)[number]

// What an operation can require
export const OPERATION_SCOPES = [...KEY_SCOPES, 'admin'] as const
export type OperationScope = (typeof OPERATION_SCOPES)[number]

export const DEFAULT_KEY_SCOPES: readonly KeyScope[] = ['read', 'send', 'events']

export interface Principal {
  // Null for the bootstrap key of the environment, which has no row
  keyId: string | null
  isAdmin: boolean
  // Null = every session
  sessionId: string | null
  scopes: ReadonlySet<OperationScope>
}

export function adminPrincipal(keyId: string | null): Principal {
  return { keyId, isAdmin: true, sessionId: null, scopes: new Set(OPERATION_SCOPES) }
}

// Stored scopes outside KEY_SCOPES (a row edited by hand) are dropped, so `admin` is never granted
export function keyPrincipal(
  keyId: string,
  sessionId: string | null,
  scopes: readonly string[]
): Principal {
  const granted = KEY_SCOPES.filter(scope => scopes.includes(scope))
  return { keyId, isAdmin: false, sessionId, scopes: new Set(granted) }
}

export function assertScope(principal: Principal, scope: OperationScope): void {
  if (!principal.scopes.has(scope)) {
    throw new ForbiddenError('INSUFFICIENT_SCOPE', `The API key lacks the "${scope}" scope`, {
      scope
    })
  }
}

// The only place that decides whether a key may reach a session: REST, sockets and inbound hooks
// all call it
export function assertSessionAccess(principal: Principal, sessionId: string): void {
  if (principal.sessionId !== null && principal.sessionId !== sessionId) {
    throw new ForbiddenError('FORBIDDEN', 'The API key is not allowed to use this session')
  }
}
