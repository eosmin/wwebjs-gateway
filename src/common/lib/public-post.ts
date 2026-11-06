import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

import { pinnedLookup } from './public-download.js'
import { type SsrfPolicy, assertPublicHttpUrl } from './ssrf.js'

export interface PostOptions {
  policy: SsrfPolicy
  headers: Record<string, string>
  // Sent as UTF-8, byte for byte: a signature is computed over exactly this string
  body: string
  timeoutMs: number
}

export interface PostResult {
  statusCode: number
}

// The request did not get an answer. The message is safe to store and to show: it names the kind of
// failure and the error code of the socket, never the URL, which can carry a secret in its path.
export class RequestFailedError extends Error {
  constructor(
    readonly kind: 'timeout' | 'connection',
    message: string
  ) {
    super(message)
    this.name = 'RequestFailedError'
  }
}

const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,39}$/

function failure(error: unknown, signal: AbortSignal, timeoutMs: number): RequestFailedError {
  if (signal.aborted) {
    return new RequestFailedError('timeout', `The receiver did not answer in ${timeoutMs} ms`)
  }
  const code = (error as { code?: unknown } | null)?.code
  const named = typeof code === 'string' && ERROR_CODE.test(code) ? ` (${code})` : ''
  return new RequestFailedError('connection', `The connection failed${named}`)
}

// POSTs to a user-supplied URL (a webhook). The guard runs for this request (never reuse an earlier
// answer), the socket connects only to the addresses it returned (so a name that resolves somewhere
// else afterwards, DNS rebinding, leads nowhere), a redirect is not followed (its status is the
// result, and anything but 2xx is a failure for the caller) and the whole exchange is bounded by
// `timeoutMs`. The answer's body is never read: the status is all a delivery needs, and a receiver
// cannot make the gateway buffer what it sends back.
export async function postToPublicUrl(rawUrl: string, options: PostOptions): Promise<PostResult> {
  const { url, addresses } = await assertPublicHttpUrl(rawUrl, options.policy)
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  const body = Buffer.from(options.body, 'utf8')
  const signal = AbortSignal.timeout(options.timeoutMs)
  return new Promise<PostResult>((resolve, reject) => {
    const request = send(
      url,
      {
        method: 'POST',
        signal,
        lookup: pinnedLookup(addresses),
        headers: { ...options.headers, 'content-length': String(body.length) }
      },
      response => {
        const statusCode = response.statusCode ?? 0
        // Destroying the answer ends the exchange; the late error that follows is not news
        response.on('error', () => undefined)
        response.destroy()
        resolve({ statusCode })
      }
    )
    request.on('error', (error: Error) => {
      reject(failure(error, signal, options.timeoutMs))
    })
    request.end(body)
  })
}
