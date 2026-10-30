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

// The call ran, but our own code could not read what WhatsApp answered (a field the mappers did not
// expect), or the library's Node code failed after the page sent a message. It answers like
// WaOperationError, yet WhatsApp Web did not fail, so it is told apart to be logged loudly and, for a
// send, to read as an unknown outcome.
export class WaMappingError extends WhatsAppError {
  constructor(
    readonly operation: string,
    message?: string
  ) {
    super('WHATSAPP_ERROR', message, { operation, kind: 'mapping' })
  }
}

// What the adapter's own mappers raise when WhatsApp gave data they did not expect. `runWaCall`
// turns it into a WaMappingError that names the operation; the original error stays as `cause`.
export class MapperFailure extends Error {
  constructor(cause: unknown) {
    super('A mapper failed', { cause })
    this.name = 'MapperFailure'
  }
}
