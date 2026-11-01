import { NotFoundError } from '../common/errors.js'
import type { SessionManager } from '../whatsapp/session-manager.service.js'
import type { WhatsAppClientPort } from '../whatsapp/whatsapp-client.port.js'

import { CallsService } from './calls.service.js'

const ok = (value: unknown = undefined) => jest.fn(() => Promise.resolve(value))

const build = (client: Partial<Record<keyof WhatsAppClientPort, jest.Mock>>) => {
  const requireReady = jest.fn(() => client)
  return {
    service: new CallsService({ requireReady } as unknown as SessionManager),
    requireReady
  }
}

describe('CallsService', () => {
  it('creates the link with the start time as a date', async () => {
    const createCallLink = ok('https://call.whatsapp.com/video/x')
    const { service, requireReady } = build({ createCallLink })

    await expect(service.createLink('s', '2026-12-01T10:00:00Z', 'video')).resolves.toBe(
      'https://call.whatsapp.com/video/x'
    )
    expect(requireReady).toHaveBeenCalledWith('s')
    expect(createCallLink).toHaveBeenCalledWith(new Date('2026-12-01T10:00:00Z'), 'video')
  })

  it('rejects a call the adapter holds', async () => {
    const rejectCall = ok(true)
    const { service } = build({ rejectCall })

    await expect(service.reject('s', 'c1')).resolves.toBeUndefined()
    expect(rejectCall).toHaveBeenCalledWith('c1')
  })

  it('answers NOT_FOUND for a call the adapter does not hold', async () => {
    const { service } = build({ rejectCall: ok(false) })

    await expect(service.reject('s', 'c1')).rejects.toBeInstanceOf(NotFoundError)
  })
})
