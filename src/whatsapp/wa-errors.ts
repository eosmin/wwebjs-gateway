import { ConflictError, WhatsAppError } from '../common/errors.js'

// What the adapter throws, so that no Puppeteer or wwebjs error ever leaves it

// The browser or the page is gone, or the session is not connected. `dispatched` is false when the
// readiness check failed before the call (the send worker may retry) and true when the page died
// with the call in flight, which is an unknown outcome and is never retried.
export class WaDisconnectedError extends ConflictError {
  constructor(
    readonly operation: string,
    readonly dispatched: boolean,
    message?: string
  ) {
    super('SESSION_NOT_READY', message, { operation, dispatched })
  }
}

// `dispatched` tells the send worker whether the call may already have reached WhatsApp: a
// timeout after dispatch is an unknown outcome and is never retried.
export class WaTimeoutError extends WhatsAppError {
  constructor(
    readonly operation: string,
    readonly dispatched: boolean,
    message?: string
  ) {
    super('WHATSAPP_TIMEOUT', message, { operation, dispatched })
  }
}

// WhatsApp Web ran the call and it failed
export class WaOperationError extends WhatsAppError {
  constructor(
    readonly operation: string,
    message?: string
  ) {
    super('WHATSAPP_ERROR', message, { operation })
  }
}
