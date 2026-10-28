import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Params } from 'nestjs-pino'
import type { Options } from 'pino-http'

import type { AppConfig } from '../../config/env.schema.js'

import { redactSensitive, scrubText } from './redaction.js'

// An id from the caller is kept only when it is short and plain, so it cannot forge log lines
const REQUEST_ID_PATTERN = /^[\w.-]{1,128}$/
export const REQUEST_ID_HEADER = 'x-request-id'

export function resolveRequestId(header: string | string[] | undefined): string {
  const candidate = Array.isArray(header) ? header[0] : header
  return candidate !== undefined && REQUEST_ID_PATTERN.test(candidate) ? candidate : randomUUID()
}

// Used when pino-http runs outside Fastify. Fastify numbers requests itself, so there the id comes from
// createFastifyAdapter and the x-request-id response header is the request-id interceptor's job.
export function generateRequestId(req: IncomingMessage, res: ServerResponse): string {
  const id = resolveRequestId(req.headers[REQUEST_ID_HEADER])
  res.setHeader(REQUEST_ID_HEADER, id)
  return id
}

const scrubArgument = (arg: unknown): unknown =>
  typeof arg === 'string' ? scrubText(arg) : redactSensitive(arg)

// The merge object of a log call. `req`, `res` and `err` are still the live request, response and error
// here (the serializers run after this), so they are left to the serializers. The bindings of a
// `child()` logger bypass this, so a secret must never be passed as a binding.
function redactFields({
  req,
  res,
  err,
  ...rest
}: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactSensitive(rest)
  return { ...(typeof redacted === 'object' ? redacted : {}), req, res, err }
}

export function buildPinoHttpOptions(config: Pick<AppConfig, 'LOG_LEVEL' | 'NODE_ENV'>): Options {
  return {
    level: config.LOG_LEVEL,
    genReqId: generateRequestId,
    // pino-http hands these the request, response and error already serialized; the headers, the URL
    // (the inbound hook token travels in its path) and the error message are scrubbed here
    serializers: {
      req: (serialized: unknown) => redactSensitive(serialized),
      res: (serialized: unknown) => redactSensitive(serialized),
      err: (serialized: unknown) => redactSensitive(serialized)
    },
    formatters: { log: redactFields },
    hooks: {
      // The message and its printf arguments, which the formatters never see. An Error as first
      // argument becomes `{ err }` plus its scrubbed message, since pino would copy the raw message
      // into `msg` after this hook.
      logMethod(inputArgs, method) {
        const [first, ...rest] = inputArgs
        const scrubbed =
          first instanceof Error
            ? [{ err: first }, scrubText(first.message), ...rest.map(scrubArgument)]
            : [first, ...rest.map(scrubArgument)].map((arg, index) =>
                index === 0 && typeof arg === 'string' ? scrubText(arg) : arg
              )
        return method.apply(this, scrubbed as typeof inputArgs)
      }
    },
    ...(config.NODE_ENV === 'development' && { transport: { target: 'pino-pretty' } })
  }
}

export function buildLoggerParams(config: Pick<AppConfig, 'LOG_LEVEL' | 'NODE_ENV'>): Params {
  return { pinoHttp: buildPinoHttpOptions(config) }
}
