import type { SessionManager } from '../whatsapp/session-manager.service.js'
import type { WhatsAppClientPort } from '../whatsapp/whatsapp-client.port.js'

import type { MessageStoreService } from './message-store.service.js'
import { MessagesService } from './messages.service.js'
import type { SendQueueService } from './send-queue.service.js'

const build = (client: Partial<Record<keyof WhatsAppClientPort, jest.Mock>>) =>
  new MessagesService(
    { requireReady: () => client } as unknown as SessionManager,
    {} as SendQueueService,
    {} as MessageStoreService
  )

describe('a message that has no such part is a 404 that says so, not that it does not exist', () => {
  it.each([
    ['quoted', 'getQuotedMessage', 'does not quote another message'],
    ['info', 'getMessageInfo', 'has no delivery info'],
    ['order', 'getMessageOrder', 'is not an order'],
    ['payment', 'getMessagePayment', 'is not a payment']
  ] as const)('%s', async (method, call, text) => {
    const service = build({ [call]: jest.fn().mockResolvedValue(null) })

    const error: unknown = await service[method]('s', 'true_x_1').catch((e: unknown) => e)

    expect(error).toMatchObject({ code: 'NOT_FOUND' })
    expect((error as Error).message).toContain(text)
    expect((error as Error).message).not.toContain('does not exist')
  })

  it('keeps "does not exist" for a message that is not there', async () => {
    const service = build({ getMessageById: jest.fn().mockResolvedValue(null) })

    await expect(service.get('s', 'true_x_1')).rejects.toThrow('does not exist')
  })
})
