import { ForbiddenError } from '../../common/errors.js'
import { adminPrincipal, keyPrincipal } from '../../common/principal.js'
import { collectOperations } from '../../parity/operation-links.js'
import type { WebhookDeliveriesService } from '../../services/webhook-deliveries.service.js'
import type { WebhookService } from '../../services/webhook.service.js'
import { WebhooksApiModule } from '../webhooks.module.js'

import { WebhooksController } from './webhooks.controller.js'

// Each operation is its own declaration, so a wrong scope on one route would let a key reach what it
// must not: the table pins the scope of every webhooks operation. All of them are the gateway's own.
const EXPECTED: Record<string, { scope: string; wwebjs: string[]; gateway: boolean }> = {
  'webhooks.create': { scope: 'webhooks', wwebjs: [], gateway: true },
  'webhooks.list': { scope: 'webhooks', wwebjs: [], gateway: true },
  'webhooks.get': { scope: 'webhooks', wwebjs: [], gateway: true },
  'webhooks.update': { scope: 'webhooks', wwebjs: [], gateway: true },
  'webhooks.delete': { scope: 'webhooks', wwebjs: [], gateway: true },
  'webhooks.rotateSecret': { scope: 'webhooks', wwebjs: [], gateway: true },
  'webhooks.test': { scope: 'webhooks', wwebjs: [], gateway: true },
  'webhooks.listDeliveries': { scope: 'webhooks', wwebjs: [], gateway: true },
  'webhooks.retryFailed': { scope: 'webhooks', wwebjs: [], gateway: true },
  'webhooks.retryDelivery': { scope: 'webhooks', wwebjs: [], gateway: true }
}

describe('WebhooksController operations', () => {
  it('declares exactly the operations of the table, each with the webhooks scope', async () => {
    const operations = (await collectOperations(WebhooksApiModule)).filter(operation =>
      operation.id.startsWith('webhooks.')
    )

    expect(
      Object.fromEntries(
        operations.map(op => [
          op.id,
          { scope: op.scope, wwebjs: op.wwebjs, gateway: op.gateway === true }
        ])
      )
    ).toEqual(EXPECTED)
  })
})

describe('WebhooksController access', () => {
  const ID = '7f0c3f4e-2b1a-4c55-9a52-0c1c3f6f2d10'
  const DELIVERY_ID = '3b9a1c0e-6d2f-4f7e-8a41-5e0d7c9b1a22'
  const sessionKey = keyPrincipal('k', 'main', ['webhooks'])

  function setup() {
    const webhooks = {
      create: jest.fn(() => Promise.resolve({})),
      listFor: jest.fn(() => Promise.resolve([])),
      // The webhook of the id belongs to the session `requireFor` is told to allow
      requireFor: jest.fn(() => Promise.resolve({ id: ID, sessionId: 'main', events: ['*'] })),
      update: jest.fn(() => Promise.resolve({})),
      delete: jest.fn(() => Promise.resolve()),
      rotateSecret: jest.fn(() => Promise.resolve({}))
    }
    const deliveries = {
      test: jest.fn(() => Promise.resolve({})),
      list: jest.fn(() => Promise.resolve({})),
      retry: jest.fn(() => Promise.resolve({})),
      retryFailed: jest.fn(() => Promise.resolve({}))
    }
    const controller = new WebhooksController(
      webhooks as unknown as WebhookService,
      deliveries as unknown as WebhookDeliveriesService
    )
    return { controller, webhooks, deliveries }
  }

  it('lets a session key create a webhook of its own session only', async () => {
    const { controller, webhooks } = setup()

    await controller.create(sessionKey, { url: 'https://a.example.test', sessionId: 'main' })
    expect(webhooks.create).toHaveBeenCalledTimes(1)

    await expect(
      controller.create(sessionKey, { url: 'https://a.example.test', sessionId: 'other' })
    ).rejects.toBeInstanceOf(ForbiddenError)
    await expect(
      controller.create(sessionKey, { url: 'https://a.example.test' })
    ).rejects.toBeInstanceOf(ForbiddenError)
    expect(webhooks.create).toHaveBeenCalledTimes(1)
  })

  it('lets an admin create a webhook of every session', async () => {
    const { controller, webhooks } = setup()

    await controller.create(adminPrincipal('k'), { url: 'https://a.example.test' })

    expect(webhooks.create).toHaveBeenCalledTimes(1)
  })

  it('asks the service whether the key reaches the webhook before every operation on it', async () => {
    const { controller, webhooks, deliveries } = setup()
    webhooks.requireFor.mockRejectedValue(new ForbiddenError('FORBIDDEN', 'no'))
    const params = { id: ID }
    const calls = [
      controller.get(sessionKey, params),
      controller.update(sessionKey, params, { enabled: false }),
      controller.delete(sessionKey, params),
      controller.rotateSecret(sessionKey, params),
      controller.test(sessionKey, params, {}),
      controller.listDeliveries(sessionKey, params, { limit: 10 }),
      controller.retryFailed(sessionKey, params),
      controller.retryDelivery(sessionKey, { id: ID, deliveryId: DELIVERY_ID })
    ]

    for (const call of calls) await expect(call).rejects.toBeInstanceOf(ForbiddenError)

    expect(webhooks.requireFor).toHaveBeenCalledTimes(calls.length)
    expect(webhooks.update).not.toHaveBeenCalled()
    expect(webhooks.delete).not.toHaveBeenCalled()
    expect(webhooks.rotateSecret).not.toHaveBeenCalled()
    expect(deliveries.test).not.toHaveBeenCalled()
    expect(deliveries.list).not.toHaveBeenCalled()
    expect(deliveries.retry).not.toHaveBeenCalled()
    expect(deliveries.retryFailed).not.toHaveBeenCalled()
  })

  it('refuses the qr and code events to a key without the manage scope, on create and update', async () => {
    const { controller, webhooks } = setup()
    const url = 'https://a.example.test'

    await expect(
      controller.create(sessionKey, { url, sessionId: 'main', events: ['qr'] })
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_SCOPE' })
    await expect(
      controller.update(sessionKey, { id: ID }, { events: ['code'] })
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_SCOPE' })
    expect(webhooks.create).not.toHaveBeenCalled()
    expect(webhooks.update).not.toHaveBeenCalled()

    const manageKey = keyPrincipal('k', 'main', ['webhooks', 'manage'])
    await controller.create(manageKey, { url, sessionId: 'main', events: ['qr'] })
    expect(webhooks.create).toHaveBeenCalledTimes(1)
  })

  it('refuses any change of a webhook that already listens to qr or code to a key without manage', async () => {
    const { controller, webhooks } = setup()
    webhooks.requireFor.mockResolvedValue({ id: ID, sessionId: 'main', events: ['qr'] })

    // The URL is where the QR code goes: moving it would hand the code to someone else
    await expect(
      controller.update(sessionKey, { id: ID }, { url: 'https://evil.example.test' })
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_SCOPE' })
    expect(webhooks.update).not.toHaveBeenCalled()

    await controller.update(
      keyPrincipal('k', 'main', ['webhooks', 'manage']),
      { id: ID },
      {
        url: 'https://ok.example.test'
      }
    )
    expect(webhooks.update).toHaveBeenCalledTimes(1)
  })

  it('lists what the key may see', async () => {
    const { controller, webhooks } = setup()

    await controller.list(sessionKey)

    expect(webhooks.listFor).toHaveBeenCalledWith(sessionKey)
  })
})
