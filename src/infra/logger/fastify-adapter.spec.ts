import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'

import {
  DEFAULT_BODY_LIMIT_BYTES,
  answerFrameworkError,
  createFastifyAdapter
} from './fastify-adapter.js'

describe('createFastifyAdapter', () => {
  const adapter = createFastifyAdapter()
  const fastify = adapter.getInstance()
  fastify.get('/id', request => ({ id: request.id }))
  fastify.post('/echo', () => ({ ok: true }))
  fastify.get('/:segment/x', () => ({ ok: true }))

  beforeAll(async () => {
    await fastify.ready()
  })

  afterAll(async () => {
    await fastify.close()
  })

  it('gives the request the plain id the caller sent', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/id',
      headers: { 'x-request-id': 'trace-42' }
    })

    expect(response.json()).toEqual({ id: 'trace-42' })
  })

  it.each([undefined, 'has space', 'x'.repeat(200)])(
    'generates an id instead of %j',
    async header => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/id',
        headers: header === undefined ? {} : { 'x-request-id': header }
      })

      expect(response.json<{ id: string }>().id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/)
    }
  )

  it('refuses a body over the default limit with 413', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ blob: 'x'.repeat(DEFAULT_BODY_LIMIT_BYTES) })
    })

    expect(response.statusCode).toBe(413)
  })

  it('takes a body under the limit', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ blob: 'x'.repeat(1000) })
    })

    expect(response.statusCode).toBe(200)
  })

  it.each([
    ['too long for the router', `/${'SECRET'.repeat(40)}/x`, 414],
    ['not a valid URL component', '/SECRET%zz/x', 400]
  ])(
    'answers a URL %s with the error contract and no echo of the URL',
    async (_name, url, status) => {
      const response = await fastify.inject({
        method: 'GET',
        url,
        headers: { 'x-request-id': 'trace-7' }
      })

      expect(response.statusCode).toBe(status)
      expect(response.headers['x-request-id']).toBe('trace-7')
      const { error } = response.json<{ error: Record<string, string> }>()
      expect(error).toEqual({
        code: 'VALIDATION_ERROR',
        message: error['message'],
        requestId: 'trace-7'
      })
      expect(error['message']).toMatch(/URL/)
      expect(response.body).not.toContain('SECRET')
    }
  )

  it.each([
    [{ statusCode: 500 }, 500, 'INTERNAL'],
    [{}, 400, 'VALIDATION_ERROR']
  ])('answers a router error %j with %i and the contract', (error, status, code) => {
    const sent: unknown[] = []
    const reply = {
      header: () => reply,
      status: (value: number) => {
        sent.push(value)
        return reply
      },
      send: (body: unknown) => sent.push(body)
    }

    answerFrameworkError(
      error as FastifyError,
      { id: 'r1' } as FastifyRequest,
      reply as unknown as FastifyReply
    )

    expect(sent[0]).toBe(status)
    expect(sent[1]).toMatchObject({ error: { code, requestId: 'r1' } })
  })
})
