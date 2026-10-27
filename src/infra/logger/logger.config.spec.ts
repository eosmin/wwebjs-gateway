import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Writable } from 'node:stream'

import { pino } from 'pino'
import { pinoHttp } from 'pino-http'

import { buildLoggerParams, buildPinoHttpOptions, resolveRequestId } from './logger.config.js'
import { REDACTED } from './redaction.js'

describe('resolveRequestId', () => {
  it('keeps a plain id from the caller', () => {
    expect(resolveRequestId('req-123.abc_DEF')).toBe('req-123.abc_DEF')
    expect(resolveRequestId(['first', 'second'])).toBe('first')
  })

  it.each([undefined, '', 'has space', 'line\nbreak', 'x'.repeat(129), '{"a":1}'])(
    'generates a UUID instead of %j',
    header => {
      expect(resolveRequestId(header)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/)
    }
  )
})

describe('buildLoggerParams', () => {
  it('sets the level and uses pino-pretty only in development', () => {
    const production = buildLoggerParams({ LOG_LEVEL: 'warn', NODE_ENV: 'production' })
    const development = buildLoggerParams({ LOG_LEVEL: 'debug', NODE_ENV: 'development' })

    expect(production.pinoHttp).toMatchObject({ level: 'warn' })
    expect(production.pinoHttp).not.toHaveProperty('transport')
    expect(development.pinoHttp).toHaveProperty('transport.target', 'pino-pretty')
  })
})

describe('a request logged with the configured options', () => {
  let server: Server
  const lines: Record<string, unknown>[] = []

  beforeAll(async () => {
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          lines.push(JSON.parse(line) as Record<string, unknown>)
        }
        done()
      }
    })
    const logger = pinoHttp(buildPinoHttpOptions({ LOG_LEVEL: 'info', NODE_ENV: 'test' }), sink)
    server = createServer((req, res) => {
      logger(req, res)
      class Delivery {
        constructor(readonly secret = 'classsecret') {}
      }
      req.log.info(
        {
          webhook: { url: 'https://example.com', secret: 'whsec_123' },
          qr: '2@qrdata',
          pairingCode: 'PAIRCODE1',
          body: 'hello private message',
          delivery: new Delivery(),
          media: Buffer.from('credentialbytes')
        },
        'delivering'
      )
      req.log.warn('retry with token=abc999 and Bearer msgbearer')
      req.log.error(
        {
          err: new Error('failed token=abc123 for Bearer sometoken', {
            cause: new Error('apikey: wgk_causekey')
          })
        },
        'send failed'
      )
      res.setHeader('set-cookie', 'sid=abc')
      res.end('ok')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  })

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve))
  })

  it('never writes credentials, secrets or QR strings', async () => {
    const { port } = server.address() as AddressInfo
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/hooks/inbound/INBOUNDTOKEN123?token=qtok&page=2`,
      {
        headers: {
          'x-api-key': 'wgk_supersecret',
          authorization: 'Bearer abc',
          'proxy-authorization': 'PROXYAUTH',
          'x-auth-token': 'XAUTHTOKEN',
          'x-webhook-signature': 'SIGVALUE',
          cookie: 'sid=xyz',
          'x-request-id': 'trace-1'
        }
      }
    )
    await response.text()
    await new Promise(resolve => setTimeout(resolve, 20))

    const output = JSON.stringify(lines)
    for (const leaked of [
      'wgk_supersecret',
      'Bearer abc',
      'sid=xyz',
      'sid=abc',
      'whsec_123',
      '2@qrdata',
      'INBOUNDTOKEN123',
      'qtok',
      'PROXYAUTH',
      'XAUTHTOKEN',
      'SIGVALUE',
      'PAIRCODE1',
      'hello private message',
      'classsecret',
      'credentialbytes',
      'abc123',
      'sometoken',
      'wgk_causekey',
      'abc999',
      'msgbearer'
    ]) {
      expect(output).not.toContain(leaked)
    }
    expect(response.headers.get('x-request-id')).toBe('trace-1')
    const delivering = lines.find(line => line['msg'] === 'delivering')
    expect(delivering).toMatchObject({
      req: { id: 'trace-1' },
      webhook: { url: 'https://example.com', secret: REDACTED },
      qr: REDACTED
    })
    const completed = lines.find(line => line['msg'] === 'request completed')
    expect(completed).toMatchObject({
      req: {
        url: `/v1/hooks/inbound/${REDACTED}?token=${REDACTED}&page=2`,
        headers: { 'x-api-key': REDACTED, authorization: REDACTED, cookie: REDACTED }
      }
    })
    expect(completed).toMatchObject({ res: { statusCode: 200 } })
    const failed = lines.find(line => line['msg'] === 'send failed')
    expect(failed).toMatchObject({ err: { type: 'Error' } })
  })
})

describe('logging outside a request', () => {
  function capture() {
    const lines: Record<string, unknown>[] = []
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>)
        done()
      }
    })
    return {
      lines,
      logger: pino(buildPinoHttpOptions({ LOG_LEVEL: 'info', NODE_ENV: 'test' }), sink)
    }
  }

  it('scrubs the objects a printf-style call interpolates', () => {
    const { lines, logger } = capture()

    logger.info('a %s b %j', 'x', { password: 'hunter2', t: 'Bearer zzz' })
    logger.info('%o', { apiKey: 'K2' })

    const output = JSON.stringify(lines)
    for (const leaked of ['hunter2', 'zzz', 'K2']) expect(output).not.toContain(leaked)
  })

  it('scrubs the message an Error argument becomes', () => {
    const { lines, logger } = capture()

    logger.error(new Error('boom token=abc123'))

    expect(JSON.stringify(lines)).not.toContain('abc123')
    expect(lines[0]).toMatchObject({ err: { type: 'Error' } })
  })
})
