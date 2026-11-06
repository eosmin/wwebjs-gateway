import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { ValidationError } from '../errors.js'

import { postToPublicUrl, RequestFailedError, type PostOptions } from './public-post.js'

const LOOPBACK = '127.0.0.1'

type Handler = (request: IncomingMessage, response: ServerResponse) => void

describe('postToPublicUrl', () => {
  let server: Server
  let port = 0
  let handler: Handler = (_request, response) => response.end()
  const seen: { host: string | undefined; method: string | undefined; body: string }[] = []

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        seen.push({
          host: request.headers.host,
          method: request.method,
          body: Buffer.concat(chunks).toString('utf8')
        })
        handler(request, response)
      })
    })
    await new Promise<void>(resolve => server.listen(0, LOOPBACK, resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  beforeEach(() => {
    seen.length = 0
  })

  const options = (overrides: Partial<PostOptions> = {}): PostOptions => ({
    // The loopback is reachable only because the test allowlists it
    policy: {
      privateHostAllowlist: [LOOPBACK],
      allowPrivate: false,
      resolve: () => Promise.resolve([LOOPBACK])
    },
    headers: { 'content-type': 'application/json' },
    body: '{"a":1}',
    timeoutMs: 2000,
    ...overrides
  })

  it('posts the body byte for byte with the Host of the URL and returns the status', async () => {
    handler = (_request, response) => {
      response.statusCode = 204
      response.end()
    }
    const body = '{"text":"añá 😀"}'

    const result = await postToPublicUrl(`http://bot.test:${port}/in`, options({ body }))

    expect(result.statusCode).toBe(204)
    expect(seen).toEqual([{ host: `bot.test:${port}`, method: 'POST', body }])
  })

  it('reports an error status without throwing', async () => {
    handler = (_request, response) => {
      response.statusCode = 503
      response.end('down')
    }

    await expect(postToPublicUrl(`http://bot.test:${port}/`, options())).resolves.toEqual({
      statusCode: 503
    })
  })

  // The name does not exist in DNS: the connection can only have gone to the address the guard returned
  it('connects to the address the guard returned, not to what the name resolves to', async () => {
    handler = (_request, response) => response.end()

    await postToPublicUrl(`http://does-not-exist.invalid:${port}/`, options())

    expect(seen).toHaveLength(1)
  })

  // DNS rebinding: `localhost` really resolves to the loopback, but the check was told a public
  // address. The socket must go to the public one and never reach the local server.
  it('does not connect to a private address the name resolves to after the check', async () => {
    handler = (_request, response) => response.end()
    const policy = {
      privateHostAllowlist: [],
      allowPrivate: false,
      resolve: () => Promise.resolve(['8.8.8.8'])
    }

    await expect(
      postToPublicUrl(`http://localhost:${port}/`, options({ policy, timeoutMs: 300 }))
    ).rejects.toBeInstanceOf(RequestFailedError)
    expect(seen).toHaveLength(0)
  })

  it('checks the URL again on every call', async () => {
    handler = (_request, response) => response.end()
    const answers = [[LOOPBACK], ['10.0.0.5']]
    const resolve = jest.fn(() => Promise.resolve(answers.shift() ?? []))
    const policy = { privateHostAllowlist: [LOOPBACK], allowPrivate: false, resolve }

    await postToPublicUrl(`http://bot.test:${port}/`, options({ policy }))
    await expect(
      postToPublicUrl(`http://bot.test:${port}/`, options({ policy }))
    ).rejects.toBeInstanceOf(ValidationError)
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(seen).toHaveLength(1)
  })

  it('does not follow a redirect and reports its status', async () => {
    handler = (_request, response) => {
      response.statusCode = 302
      response.setHeader('location', 'http://169.254.169.254/latest/meta-data')
      response.end()
    }

    const result = await postToPublicUrl(`http://bot.test:${port}/`, options())

    expect(result.statusCode).toBe(302)
    expect(seen).toHaveLength(1)
  })

  it('fails with a timeout when the receiver does not answer in time', async () => {
    handler = () => undefined

    const failure = await postToPublicUrl(
      `http://bot.test:${port}/`,
      options({ timeoutMs: 150 })
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(RequestFailedError)
    expect(failure).toMatchObject({
      kind: 'timeout',
      message: 'The receiver did not answer in 150 ms'
    })
  })

  it('fails with a connection error, naming the code but not the URL', async () => {
    const closed = createServer()
    await new Promise<void>(resolve => closed.listen(0, LOOPBACK, resolve))
    const closedPort = (closed.address() as AddressInfo).port
    await new Promise<void>(resolve => closed.close(() => resolve()))

    const failure = await postToPublicUrl(
      `http://secret-host.test:${closedPort}/token/abc`,
      options()
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(RequestFailedError)
    expect(failure).toMatchObject({
      kind: 'connection',
      message: 'The connection failed (ECONNREFUSED)'
    })
    expect((failure as Error).message).not.toContain('secret-host')
    expect((failure as Error).message).not.toContain('token')
  })

  it('rejects a URL with credentials or another scheme before connecting', async () => {
    await expect(
      postToPublicUrl(`http://user:pass@bot.test:${port}/`, options())
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(postToPublicUrl('file:///etc/passwd', options())).rejects.toBeInstanceOf(
      ValidationError
    )
    expect(seen).toHaveLength(0)
  })
})
