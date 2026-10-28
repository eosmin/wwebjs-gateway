import { WhatsAppError } from '../common/errors.js'
import { withTimeout } from '../common/lib/timeout.js'

import { WaDisconnectedError, WaOperationError, WaTimeoutError } from './wa-errors.js'

// What the adapter wraps around every call to whatsapp-web.js. It knows nothing of the library, so it
// runs in unit tests without a browser.

// The messages Puppeteer and WhatsApp Web give when the browser, the page or the frame a call ran in
// is gone. `pupPage` is undefined or null until `initialize()` has created it.
const PUPPETEER_FAILURE_PATTERNS: readonly RegExp[] = [
  /Execution context was destroyed/i,
  /Target closed/i,
  /Session closed/i,
  /Browser has disconnected/i,
  /Browser is not connected/i,
  /Connection closed/i,
  /Navigating frame was detached/i,
  /Attempted to use detached Frame/i,
  /Page crashed/i,
  /Cannot read properties of (?:undefined|null) \(reading '(?:evaluate|isConnected|close|goto)'\)/
]
// `ProtocolError` is not here: it also covers harmless answers such as "No node with given id"
const PUPPETEER_ERROR_NAMES: ReadonlySet<string> = new Set(['TargetCloseError'])

// wwebjs throws strings ('auth timeout') as well as errors
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : ''
}

// True for the failures that mean the browser side of a session died, whatever call hit them. The
// process-level guard uses it to tell such a rejection from a bug of ours.
export function isPuppeteerFailure(error: unknown): boolean {
  if (error instanceof Error && PUPPETEER_ERROR_NAMES.has(error.name)) return true
  const message = messageOf(error)
  return PUPPETEER_FAILURE_PATTERNS.some(pattern => pattern.test(message))
}

const isTimeout = (error: unknown): boolean =>
  error instanceof WhatsAppError && error.code === 'WHATSAPP_TIMEOUT'

// The message of a library error can carry chat ids, phone numbers or page text, and this error
// reaches API clients and webhooks: only a fixed message leaves. The caller gets the original
// through `onFailure` to log what it deems safe.
function translate(operation: string, error: unknown): Error {
  if (
    error instanceof WaDisconnectedError ||
    error instanceof WaTimeoutError ||
    error instanceof WaOperationError
  ) {
    return error
  }
  if (isTimeout(error)) return new WaTimeoutError(operation, true, `${operation} timed out`)
  if (isPuppeteerFailure(error)) {
    return new WaDisconnectedError(operation, true, `${operation}: the browser went away`)
  }
  return new WaOperationError(operation, `${operation} failed`)
}

// Runs `call` with a deadline and turns whatever it throws into one of the three errors of the port.
// The call is in flight by the time it fails, so every error it raises says `dispatched: true`; the
// readiness check that comes before, which never reaches WhatsApp, is `notReady`.
export async function runWaCall<T>(
  operation: string,
  timeoutMs: number,
  call: () => Promise<T>,
  onFailure?: (error: unknown) => void
): Promise<T> {
  try {
    // `call()` runs inside the try so that a synchronous throw is translated too
    return await withTimeout(call(), timeoutMs, operation)
  } catch (error: unknown) {
    onFailure?.(error)
    throw translate(operation, error)
  }
}

// The error of a call made while the session is not connected: nothing was sent
export const notReady = (operation: string): WaDisconnectedError =>
  new WaDisconnectedError(operation, false, `${operation}: the session is not connected`)
