import { CreateWebhookBody, UpdateWebhookBody } from './webhooks.dto.js'

describe('CreateWebhookBody', () => {
  it('needs a url only', () => {
    expect(CreateWebhookBody.safeParse({ url: 'https://example.test/hook' }).success).toBe(true)
    expect(CreateWebhookBody.safeParse({}).success).toBe(false)
  })

  it.each([
    [{ url: 'not a url' }],
    [{ url: 'https://example.test', events: [] }],
    [{ url: 'https://example.test', events: ['no_such_event'] }],
    [{ url: 'https://example.test', secret: 'chosen' }],
    [{ url: 'https://example.test', mediaMode: 'base64' }]
  ])('rejects %j', body => {
    expect(CreateWebhookBody.safeParse(body).success).toBe(false)
  })

  it('accepts the wildcard, real event names and a null includeRaw', () => {
    const body = { url: 'https://example.test', events: ['*', 'message_batch'], includeRaw: null }

    expect(CreateWebhookBody.safeParse(body).success).toBe(true)
  })
})

describe('UpdateWebhookBody', () => {
  it('needs at least one field and never the session', () => {
    expect(UpdateWebhookBody.safeParse({}).success).toBe(false)
    expect(UpdateWebhookBody.safeParse({ sessionId: 'other' }).success).toBe(false)
    expect(UpdateWebhookBody.safeParse({ enabled: false }).success).toBe(true)
    expect(UpdateWebhookBody.safeParse({ includeRaw: null }).success).toBe(true)
  })
})
