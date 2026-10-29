import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { Queue } from 'bullmq'
import Fastify, { type FastifyInstance } from 'fastify'

import { BULL_BOARD_PATH, setupBullBoard, type QueueSource } from './bull-board.js'

const ADMIN_KEY = 'k'.repeat(32)
const basic = (user: string, password: string): string =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`

// The part of a BullMQ queue the dashboard reads when it is built; the API calls that would need
// Redis are not made by these requests
const fakeQueue = (name: string): Queue =>
  Object.assign(Object.create(Queue.prototype) as Queue, { name, opts: {} })

describe('setupBullBoard', () => {
  let server: FastifyInstance
  let listeners: ((queues: Queue[]) => void)[]
  const source: QueueSource = {
    watchQueues: listener => {
      listeners.push(listener)
      listener([fakeQueue('send-s1')])
      return () => undefined
    }
  }

  const mount = async (enabled: boolean, hops = 0): Promise<void> => {
    server = Fastify()
    const app = {
      register: (plugin: never) => server.register(plugin)
    } as unknown as NestFastifyApplication
    await setupBullBoard(
      app,
      { BULL_BOARD_ENABLED: enabled, ADMIN_API_KEY: ADMIN_KEY, TRUST_PROXY_HOPS: hops },
      source
    )
    await server.ready()
  }

  beforeEach(() => {
    listeners = []
  })
  afterEach(() => server.close())

  it('registers nothing when the flag is off, so the route does not exist', async () => {
    await mount(false)
    const response = await server.inject({ method: 'GET', url: BULL_BOARD_PATH })

    expect(response.statusCode).toBe(404)
    expect(listeners).toHaveLength(0)
  })

  describe('when the flag is on', () => {
    beforeEach(async () => {
      await mount(true)
    })

    it('asks for credentials without any', async () => {
      const response = await server.inject({ method: 'GET', url: BULL_BOARD_PATH })

      expect(response.statusCode).toBe(401)
      expect(response.headers['www-authenticate']).toMatch(/^Basic realm=/)
    })

    it.each([
      ['a wrong password', basic('admin', 'x'.repeat(32))],
      ['a wrong user', basic('root', ADMIN_KEY)],
      ['a header that is not Basic', `Bearer ${ADMIN_KEY}`],
      ['credentials without a colon', `Basic ${Buffer.from('admin').toString('base64')}`]
    ])('refuses %s', async (_name, authorization) => {
      const response = await server.inject({
        method: 'GET',
        url: BULL_BOARD_PATH,
        headers: { authorization }
      })

      expect(response.statusCode).toBe(401)
    })

    it('serves the dashboard to user admin with the admin key and relaxes the CSP for it only', async () => {
      const response = await server.inject({
        method: 'GET',
        url: BULL_BOARD_PATH,
        headers: { authorization: basic('admin', ADMIN_KEY) }
      })

      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toMatch(/html/)
      expect(response.headers['content-security-policy']).toContain(
        `script-src 'self' 'unsafe-inline'`
      )
    })

    it('does not serve the dashboard outside its prefix', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/admin/other',
        headers: { authorization: basic('admin', ADMIN_KEY) }
      })

      expect(response.statusCode).toBe(404)
    })

    it('follows the queues of the source as sessions come and go', () => {
      expect(listeners).toHaveLength(1)

      expect(() => listeners[0]?.([fakeQueue('send-s1'), fakeQueue('send-s2')])).not.toThrow()
      expect(() => listeners[0]?.([])).not.toThrow()
    })

    it('blocks an address after ten failures in a minute, even with the right key', async () => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await server.inject({ method: 'GET', url: BULL_BOARD_PATH })
      }
      const response = await server.inject({
        method: 'GET',
        url: BULL_BOARD_PATH,
        headers: { authorization: basic('admin', ADMIN_KEY) }
      })

      expect(response.statusCode).toBe(429)
      expect(response.headers['retry-after']).toBe('60')
    })

    it('keeps counting after a sign in, so a success cannot erase the failures of someone else', async () => {
      const good = { authorization: basic('admin', ADMIN_KEY) }
      for (let attempt = 0; attempt < 9; attempt += 1) {
        await server.inject({ method: 'GET', url: BULL_BOARD_PATH })
      }
      await server.inject({ method: 'GET', url: BULL_BOARD_PATH, headers: good })
      await server.inject({ method: 'GET', url: BULL_BOARD_PATH })
      const response = await server.inject({ method: 'GET', url: BULL_BOARD_PATH, headers: good })

      expect(response.statusCode).toBe(429)
    })

    it.each([
      ['a static asset', `${BULL_BOARD_PATH}/static/js/main.js`],
      ['the trailing slash', `${BULL_BOARD_PATH}/`],
      ['the api', `${BULL_BOARD_PATH}/api/queues`]
    ])('asks for credentials on %s too', async (_name, url) => {
      const response = await server.inject({ method: 'GET', url })

      expect(response.statusCode).toBe(401)
    })

    it('serves nothing for an encoded traversal, with or without credentials', async () => {
      const url = `${BULL_BOARD_PATH}/..%2f..%2fetc/passwd`
      const anonymous = await server.inject({ method: 'GET', url })
      const signedIn = await server.inject({
        method: 'GET',
        url,
        headers: { authorization: basic('admin', ADMIN_KEY) }
      })

      expect([401, 404]).toContain(anonymous.statusCode)
      expect(signedIn.statusCode).toBe(404)
    })

    it('tells the browser not to cache what the dashboard shows', async () => {
      const response = await server.inject({
        method: 'GET',
        url: BULL_BOARD_PATH,
        headers: { authorization: basic('admin', ADMIN_KEY) }
      })

      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.headers['content-security-policy']).toContain(`object-src 'none'`)
      expect(response.headers['content-security-policy']).toContain(`base-uri 'self'`)
    })
  })

  describe('behind a trusted proxy', () => {
    beforeEach(async () => {
      await mount(true, 1)
    })

    it('counts the failures of each client apart, by the address the proxy saw', async () => {
      const attacker = { 'x-forwarded-for': '203.0.113.9' }
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await server.inject({ method: 'GET', url: BULL_BOARD_PATH, headers: attacker })
      }
      const blocked = await server.inject({
        method: 'GET',
        url: BULL_BOARD_PATH,
        headers: attacker
      })
      const admin = await server.inject({
        method: 'GET',
        url: BULL_BOARD_PATH,
        headers: { 'x-forwarded-for': '198.51.100.7', authorization: basic('admin', ADMIN_KEY) }
      })

      expect(blocked.statusCode).toBe(429)
      expect(admin.statusCode).toBe(200)
    })

    it('forgets the failures once the minute has passed', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval'] })
      try {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          await server.inject({ method: 'GET', url: BULL_BOARD_PATH })
        }
        jest.setSystemTime(Date.now() + 61_000)
        const response = await server.inject({
          method: 'GET',
          url: BULL_BOARD_PATH,
          headers: { authorization: basic('admin', ADMIN_KEY) }
        })

        expect(response.statusCode).toBe(200)
      } finally {
        jest.useRealTimers()
      }
    })
  })
})
