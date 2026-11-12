import { AppError, WhatsAppError } from '../common/errors.js'
import { withTimeout } from '../common/lib/timeout.js'

import {
  MapperFailure,
  WaChatNotFoundError,
  WaDisconnectedError,
  WaMappingError,
  WaOperationError,
  WaTimeoutError
} from './wa-errors.js'

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

// The patch of `Client.sendMessage` marks a failure of the library's own Node code that ran after the
// page had sent the message. An error from before that point, or from the page, is never marked, and
// the marker belongs to that patch alone: nothing else may set it.
export const failedAfterDispatch = (error: unknown): error is Error & { afterDispatch: true } =>
  error instanceof Error && 'afterDispatch' in error && error.afterDispatch === true

const isTimeout = (error: unknown): boolean =>
  error instanceof WhatsAppError && error.code === 'WHATSAPP_TIMEOUT'

// The message of a library error can carry chat ids, phone numbers or page text, and this error
// reaches API clients and webhooks: only a fixed message leaves. The caller gets the original
// through `onFailure` to log what it deems safe.
function translate(operation: string, error: unknown): Error {
  if (
    error instanceof WaChatNotFoundError ||
    error instanceof WaDisconnectedError ||
    error instanceof WaTimeoutError ||
    error instanceof WaOperationError ||
    error instanceof WaMappingError
  ) {
    return error
  }
  if (error instanceof MapperFailure || failedAfterDispatch(error)) {
    return new WaMappingError(operation, `${operation}: the result could not be read`)
  }
  if (isTimeout(error)) return new WaTimeoutError(operation, true, `${operation} timed out`)
  if (isPuppeteerFailure(error)) {
    return new WaDisconnectedError(operation, true, `${operation}: the browser went away`)
  }
  return new WaOperationError(operation, `${operation} failed`)
}

// A stable name for the family of a failure, for the log and for the person reading it
export type CauseCode =
  | 'TIMEOUT'
  | 'BROWSER_GONE'
  | 'MAPPING'
  | 'AFTER_DISPATCH'
  | 'CHAT_NOT_FOUND'
  | 'GATEWAY_ERROR'
  | 'PAGE_ERROR'
  | 'UNKNOWN'

export interface Cause {
  code: CauseCode
  kind: string
  message: string
}

const MAX_CAUSE_MESSAGE_LENGTH = 200

// A message of the library can name a chat, a number or a QR string, and the line goes to the log:
// ids and long digit runs are masked, so are long opaque tokens, and the length is capped
function sanitize(message: string): string {
  return (
    message
      .replace(/[^\s@]+@(?:c\.us|g\.us|s\.whatsapp\.net|lid|newsletter|broadcast)\b/g, '[id]')
      // A token mixes letters and digits; a name of a module or a class (letters only) is what is being diagnosed
      .replace(/[A-Za-z0-9+/=_-]{24,}/g, token =>
        /\d/.test(token) && /[A-Za-z]/.test(token) ? '[redacted]' : token
      )
      // The build of WhatsApp Web ("2.3000.1054303363", always "2.<4 digits>.") is not the number of a person: it is kept
      .replace(/(?<!\d)(?<!\b2\.\d{4}\.)\d{7,}/g, '#')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_CAUSE_MESSAGE_LENGTH)
  )
}

// The error to describe: our wrappers carry the original as `cause` (one level, never followed again,
// so a cause that points back at its wrapper cannot loop)
function original(error: unknown): unknown {
  const wrapped = error instanceof MapperFailure || failedAfterDispatch(error)
  return wrapped && error.cause !== undefined && error.cause !== error ? error.cause : error
}

// What went wrong, for the log: the original message and type (the error given to the caller carries a
// fixed text), under a code that does not change with the wording of the library. Never serializes
// the error: a wwebjs object holds the page.
export function describeCause(error: unknown): Cause {
  const source = original(error)
  const kind = source instanceof Error ? source.name : typeof source
  const message = sanitize(messageOf(source))
  if (error instanceof MapperFailure) return { code: 'MAPPING', kind, message }
  if (failedAfterDispatch(error)) return { code: 'AFTER_DISPATCH', kind, message }
  if (error instanceof WaChatNotFoundError) return { code: 'CHAT_NOT_FOUND', kind, message }
  if (error instanceof AppError) {
    return { code: isTimeout(error) ? 'TIMEOUT' : 'GATEWAY_ERROR', kind, message }
  }
  if (isPuppeteerFailure(error)) return { code: 'BROWSER_GONE', kind, message }
  if (error instanceof Error || typeof error === 'string')
    return { code: 'PAGE_ERROR', kind, message }
  return { code: 'UNKNOWN', kind, message }
}

// Runs a mapper of ours: whatever it throws becomes a MapperFailure, which is not WhatsApp Web failing
export function mapping<T>(map: () => T): T {
  try {
    return map()
  } catch (error: unknown) {
    throw new MapperFailure(error)
  }
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
