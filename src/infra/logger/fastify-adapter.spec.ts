import { createFastifyAdapter } from './fastify-adapter.js'

describe('createFastifyAdapter', () => {
  const adapter = createFastifyAdapter()
  const fastify = adapter.getInstance()
  fastify.get('/id', request => ({ id: request.id }))

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
})
