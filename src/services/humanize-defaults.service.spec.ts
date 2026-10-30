import type { Session } from '../database/models.js'
import type { SessionsRepository } from '../database/repositories/sessions.repository.js'

import { HumanizeDefaultsService } from './humanize-defaults.service.js'

const build = (settings: unknown, exists = true) => {
  const findById = jest.fn(() =>
    Promise.resolve(exists ? ({ id: 's', settings } as unknown as Session) : null)
  )
  return {
    service: new HumanizeDefaultsService({ findById } as unknown as SessionsRepository),
    findById
  }
}

describe('HumanizeDefaultsService', () => {
  it('keeps the humanize of the request as it is and reads nothing', async () => {
    const { service, findById } = build({})

    await expect(service.resolve('s', { typing: 0 }, 'text')).resolves.toEqual({ typing: 0 })
    await expect(service.resolve('s', { typing: 0 }, 'media')).resolves.toEqual({ typing: 0 })
    expect(findById).not.toHaveBeenCalled()
  })

  it('lets a request switch the typing off, and does not keep the switch in the job', async () => {
    const { service, findById } = build({ humanize: { typing: 2000 } })

    await expect(service.resolve('s', { enabled: false }, 'text')).resolves.toBeUndefined()
    await expect(
      service.resolve('s', { enabled: true, typing: 10, minReplyDelayMs: 0 }, 'text')
    ).resolves.toEqual({ typing: 10, minReplyDelayMs: 0 })
    expect(findById).not.toHaveBeenCalled()
  })

  it('takes typing 0 and recording true from the defaults of the session', async () => {
    const { service } = build({ humanize: { typing: 0, recording: true } })

    await expect(service.resolve('s', undefined, 'text')).resolves.toEqual({
      typing: 0,
      recording: true
    })
  })

  it('falls back to the plain defaults when the session cannot be read', async () => {
    const findById = jest.fn(() => Promise.reject(new Error('db down')))
    const service = new HumanizeDefaultsService({ findById } as unknown as SessionsRepository)

    await expect(service.resolve('s', undefined, 'text')).resolves.toEqual({ typing: 'auto' })
  })

  it('types by default before a text when the session has no settings', async () => {
    const { service } = build({})

    await expect(service.resolve('s', undefined, 'text')).resolves.toEqual({ typing: 'auto' })
  })

  it('does not humanize anything but text by default', async () => {
    const { service } = build({ humanize: { typing: 5000 } })

    for (const type of ['media', 'location', 'contacts', 'poll', 'event', 'forward']) {
      await expect(service.resolve('s', undefined, type)).resolves.toBeUndefined()
    }
  })

  it('uses the defaults of the session for a text', async () => {
    const { service } = build({
      humanize: { typing: 2000, markSeenFirst: true, recording: false, minReplyDelayMs: 800 }
    })

    await expect(service.resolve('s', undefined, 'text')).resolves.toEqual({
      typing: 2000,
      markSeenFirst: true,
      recording: false,
      minReplyDelayMs: 800
    })
  })

  it('can be switched off for the session', async () => {
    const { service } = build({ humanize: { enabled: false, typing: 2000 } })

    await expect(service.resolve('s', undefined, 'text')).resolves.toBeUndefined()
  })

  it('ignores other keys of the settings', async () => {
    const { service } = build({ ordering: { enabled: true }, sendPolicy: { allowColdSends: true } })

    await expect(service.resolve('s', undefined, 'text')).resolves.toEqual({ typing: 'auto' })
  })

  it.each([
    ['settings that do not fit', { humanize: { typing: -5 } }],
    ['settings that are not an object', 'nope']
  ])(
    'falls back to the plain defaults for %s instead of stopping the send',
    async (_label, settings) => {
      const { service } = build(settings)

      await expect(service.resolve('s', undefined, 'text')).resolves.toEqual({ typing: 'auto' })
    }
  )

  it('uses the plain defaults when the session row is gone', async () => {
    const { service } = build({}, false)

    await expect(service.resolve('s', undefined, 'text')).resolves.toEqual({ typing: 'auto' })
  })
})
