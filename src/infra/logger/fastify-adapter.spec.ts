import { DEFAULT_BODY_LIMIT_BYTES, createFastifyAdapter } from './fastify-adapter.js'

describe('createFastifyAdapter', () => {
  const adapter = createFastifyAdapter()
  const fastify = adapter.getInstance()
  fastify.get('/id', request => ({ id: request.id }))
  fastify.post('/echo', () => ({ ok: true }))

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
})
