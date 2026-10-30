import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { UnprocessableError, ValidationError } from '../errors.js'

import { downloadPublicFile, pinnedLookup, type DownloadOptions } from './public-download.js'

const LOOPBACK = '127.0.0.1'

type Handler = (request: IncomingMessage, response: ServerResponse) => void

describe('downloadPublicFile', () => {
  let server: Server
  let port = 0
  let handler: Handler = (_request, response) => response.end()
  const hosts: (string | undefined)[] = []

  beforeAll(async () => {
    server = createServer((request, response) => {
      hosts.push(request.headers.host)
      handler(request, response)
    })
    await new Promise<void>(resolve => server.listen(0, LOOPBACK, resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  beforeEach(() => {
    hosts.length = 0
  })

  const options = (overrides: Partial<DownloadOptions> = {}): DownloadOptions => ({
    // The loopback is reachable only because the test allowlists it
    policy: {
      privateHostAllowlist: [LOOPBACK],
      allowPrivate: false,
      resolve: () => Promise.resolve([LOOPBACK])
    },
    maxBytes: 1024,
    timeoutMs: 2000,
    ...overrides
  })

  it('returns the bytes and the content type without parameters', async () => {
    handler = (_request, response) => {
      response.setHeader('content-type', 'Image/PNG; charset=binary')
      response.end('abc')
    }

    const file = await downloadPublicFile(`http://media.test:${port}/a.png`, options())

    expect(file.data.toString()).toBe('abc')
    expect(file.contentType).toBe('image/png')
  })

  // The name does not exist in DNS: the connection can only have gone to the address the guard returned
  it('connects to the checked address and keeps the Host of the URL', async () => {
    handler = (_request, response) => response.end('ok')

    await downloadPublicFile(`http://media.test:${port}/`, options())

    expect(hosts).toEqual([`media.test:${port}`])
  })

  it('refuses a name that resolves to a private address, before connecting', async () => {
    await expect(
      downloadPublicFile(
        `http://media.test:${port}/`,
        options({
          policy: {
            privateHostAllowlist: [],
            allowPrivate: false,
            resolve: () => Promise.resolve([LOOPBACK])
          }
        })
      )
    ).rejects.toBeInstanceOf(ValidationError)
    expect(hosts).toEqual([])
  })

  it('refuses a name that resolves to a public and a private address at once', async () => {
    await expect(
      downloadPublicFile(
        `http://media.test:${port}/`,
        options({
          policy: {
            privateHostAllowlist: [],
            allowPrivate: false,
            resolve: () => Promise.resolve(['93.184.216.34', LOOPBACK])
          }
        })
      )
    ).rejects.toBeInstanceOf(ValidationError)
    expect(hosts).toEqual([])
  })

  it('does not pin an address when the guard is switched off, and resolves the name itself', async () => {
    handler = (_request, response) => response.end('ok')

    const file = await downloadPublicFile(
      `http://localhost:${port}/`,
      options({ policy: { privateHostAllowlist: [], allowPrivate: true } })
    )

    expect(file.data.toString()).toBe('ok')
  })

  it('checks the URL again on every call', async () => {
    handler = (_request, response) => response.end('ok')
    const answers = [[LOOPBACK], ['10.0.0.5']]
    const resolve = jest.fn(() => Promise.resolve(answers.shift() ?? []))
    const policy = { privateHostAllowlist: [LOOPBACK], allowPrivate: false, resolve }

    await downloadPublicFile(`http://media.test:${port}/`, options({ policy }))
    await expect(
      downloadPublicFile(`http://media.test:${port}/`, options({ policy }))
    ).rejects.toBeInstanceOf(ValidationError)
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('does not follow a redirect', async () => {
    handler = (_request, response) => {
      response.statusCode = 302
      response.setHeader('location', 'http://169.254.169.254/latest/meta-data')
      response.end()
    }

    await expect(downloadPublicFile(`http://media.test:${port}/`, options())).rejects.toMatchObject(
      {
        code: 'MEDIA_FETCH_FAILED'
      }
    )
    expect(hosts).toHaveLength(1)
  })

  it('fails on an error status', async () => {
    handler = (_request, response) => {
      response.statusCode = 500
      response.end('boom')
    }

    await expect(downloadPublicFile(`http://media.test:${port}/`, options())).rejects.toMatchObject(
      {
        code: 'MEDIA_FETCH_FAILED'
      }
    )
  })

  it('refuses a file larger than the cap, declared or streamed', async () => {
    handler = (_request, response) => response.end(Buffer.alloc(2048))
    await expect(downloadPublicFile(`http://media.test:${port}/`, options())).rejects.toMatchObject(
      {
        code: 'MEDIA_FETCH_FAILED'
      }
    )

    handler = (_request, response) => {
      response.write(Buffer.alloc(900))
      response.write(Buffer.alloc(900))
      response.end()
    }
    await expect(
      downloadPublicFile(`http://media.test:${port}/`, options({ maxBytes: 1000 }))
    ).rejects.toBeInstanceOf(UnprocessableError)
  })

  it('gives up on a server that stalls in the middle of the body', async () => {
    handler = (_request, response) => {
      response.write('start')
    }

    await expect(
      downloadPublicFile(`http://media.test:${port}/`, options({ timeoutMs: 100 }))
    ).rejects.toMatchObject({ code: 'MEDIA_FETCH_FAILED' })
  })

  it('gives up on a server that is too slow', async () => {
    handler = () => undefined

    await expect(
      downloadPublicFile(`http://media.test:${port}/`, options({ timeoutMs: 50 }))
    ).rejects.toMatchObject({ code: 'MEDIA_FETCH_FAILED' })
  })
})

describe('pinnedLookup with nothing to connect to', () => {
  it('fails instead of letting the connection resolve the name', () => {
    const callback = jest.fn()

    pinnedLookup([])('internal.corp', {}, callback)

    expect(callback).toHaveBeenCalledWith(expect.any(Error), '', 0)
  })
})

describe('pinnedLookup', () => {
  const lookup = pinnedLookup(['93.184.216.34', '2606:2800:220:1::1'])

  it('answers the checked addresses whatever the name is', () => {
    const callback = jest.fn()

    lookup('internal.corp', { all: true }, callback)
    lookup('internal.corp', {}, callback)

    expect(callback).toHaveBeenNthCalledWith(1, null, [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1::1', family: 6 }
    ])
    expect(callback).toHaveBeenNthCalledWith(2, null, '93.184.216.34', 4)
  })
})
