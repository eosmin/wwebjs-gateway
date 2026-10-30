import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { type LookupFunction, isIP } from 'node:net'

import { UnprocessableError } from '../errors.js'

import { type SsrfPolicy, assertPublicHttpUrl } from './ssrf.js'

export interface DownloadOptions {
  policy: SsrfPolicy
  maxBytes: number
  timeoutMs: number
}

export interface DownloadedFile {
  data: Buffer
  // The Content-Type header without its parameters; undefined when the server sent none
  contentType: string | undefined
}

const fail = (reason: string): UnprocessableError =>
  new UnprocessableError('MEDIA_FETCH_FAILED', `The media could not be downloaded: ${reason}`, {
    reason
  })

// A lookup that ignores the name and answers with the addresses the SSRF guard checked, so the
// connection cannot go anywhere the check did not see. Host header and TLS server name still come
// from the URL.
export function pinnedLookup(addresses: readonly string[]): LookupFunction {
  const entries = addresses.map(address => ({ address, family: isIP(address) }))
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, entries)
      return
    }
    const [first] = entries
    if (first === undefined) callback(new Error('no address to connect to'), '', 0)
    else callback(null, first.address, first.family)
  }
}

// Downloads a user-supplied URL. The guard runs for this request (never reuse an earlier answer), the
// socket connects only to the addresses it returned, a redirect is an error, and the body is cut off
// at `maxBytes`.
export async function downloadPublicFile(
  rawUrl: string,
  options: DownloadOptions
): Promise<DownloadedFile> {
  const { url, addresses } = await assertPublicHttpUrl(rawUrl, options.policy)
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise<DownloadedFile>((resolve, reject) => {
    const request = send(
      url,
      {
        method: 'GET',
        // `addresses` is empty only when the guard is switched off for development
        ...(addresses.length > 0 && { lookup: pinnedLookup(addresses) }),
        headers: { accept: '*/*', 'accept-encoding': 'identity' }
      },
      response => {
        collect(response, options.maxBytes).then(resolve, reject)
      }
    )
    const timer = setTimeout(() => {
      request.destroy(fail(`it took longer than ${options.timeoutMs} ms`))
    }, options.timeoutMs)
    request.on('close', () => clearTimeout(timer))
    request.on('error', (error: Error) => {
      reject(error instanceof UnprocessableError ? error : fail('the connection failed'))
    })
    request.end()
  })
}

async function collect(response: IncomingMessage, maxBytes: number): Promise<DownloadedFile> {
  const status = response.statusCode ?? 0
  if (status >= 300 && status < 400) {
    response.destroy()
    throw fail('the server answered a redirect, which is not followed')
  }
  if (status < 200 || status >= 300) {
    response.destroy()
    throw fail(`the server answered ${status}`)
  }
  const declared = Number(response.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.destroy()
    throw fail(`the file is larger than ${maxBytes} bytes`)
  }
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of response) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += buffer.length
      if (size > maxBytes) {
        response.destroy()
        throw fail(`the file is larger than ${maxBytes} bytes`)
      }
      chunks.push(buffer)
    }
  } catch (error: unknown) {
    throw error instanceof UnprocessableError ? error : fail('the connection broke')
  }
  const header = response.headers['content-type']
  const contentType = header?.split(';')[0]?.trim().toLowerCase()
  return { data: Buffer.concat(chunks), contentType: contentType || undefined }
}
