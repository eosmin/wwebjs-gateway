import { NotFoundError } from '../common/errors.js'
import type { SessionManager } from '../whatsapp/session-manager.service.js'
import type { WhatsAppClientPort } from '../whatsapp/whatsapp-client.port.js'

import { BroadcastsService } from './broadcasts.service.js'

const ok = (value: unknown = undefined) => jest.fn(() => Promise.resolve(value))

const BROADCAST = { id: 'a@c.us', timestamp: 1, totalCount: 0, unreadCount: 0, msgs: [] }

const build = (client: Partial<Record<keyof WhatsAppClientPort, jest.Mock>>) => {
  const requireReady = jest.fn(() => client)
  return {
    service: new BroadcastsService({ requireReady } as unknown as SessionManager),
    requireReady
  }
}

describe('BroadcastsService', () => {
  it('lists the broadcasts through the client of a ready session', async () => {
    const { service, requireReady } = build({ getBroadcasts: ok([BROADCAST]) })

    await expect(service.list('s')).resolves.toEqual([BROADCAST])
    expect(requireReady).toHaveBeenCalledWith('s')
  })

  it('reads the broadcast of a user', async () => {
    const getBroadcastById = ok(BROADCAST)
    const { service } = build({ getBroadcastById })

    await expect(service.get('s', 'a@c.us')).resolves.toEqual(BROADCAST)
    expect(getBroadcastById).toHaveBeenCalledWith('a@c.us')
  })

  it('answers NOT_FOUND for a user the page holds no statuses of', async () => {
    const { service } = build({ getBroadcastById: ok(null) })

    await expect(service.get('s', 'a@c.us')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('does not call the client when the session is not ready', () => {
    const requireReady = jest.fn(() => {
      throw new Error('not ready')
    })
    const service = new BroadcastsService({ requireReady } as unknown as SessionManager)

    expect(() => service.list('s')).toThrow('not ready')
  })
})
