import { ValidationError, WhatsAppError } from '../common/errors.js'
import type { SessionsRepository } from '../database/repositories/sessions.repository.js'
import type { SessionManager } from '../whatsapp/session-manager.service.js'
import type { WhatsAppClientPort } from '../whatsapp/whatsapp-client.port.js'

import type { MediaResolverService } from './media-resolver.service.js'
import { PresenceProfileService } from './presence-profile.service.js'

const ok = (value: unknown = undefined) => jest.fn(() => Promise.resolve(value))

const build = (
  client: Partial<Record<keyof WhatsAppClientPort, jest.Mock>>,
  resolve: jest.Mock = jest.fn()
) => {
  const requireReady = jest.fn(() => client)
  const mergeSettings = jest.fn(() => Promise.resolve(true))
  return {
    service: new PresenceProfileService(
      { requireReady } as unknown as SessionManager,
      { resolve } as unknown as MediaResolverService,
      { mergeSettings } as unknown as SessionsRepository
    ),
    requireReady,
    resolve,
    mergeSettings
  }
}

describe('PresenceProfileService', () => {
  it('calls the presence that was asked for', async () => {
    const sendPresenceAvailable = ok()
    const sendPresenceUnavailable = ok()
    const { service } = build({ sendPresenceAvailable, sendPresenceUnavailable })

    await service.setPresence('s', 'available')
    expect(sendPresenceAvailable).toHaveBeenCalledTimes(1)
    expect(sendPresenceUnavailable).not.toHaveBeenCalled()
    await service.setPresence('s', 'unavailable')
    expect(sendPresenceUnavailable).toHaveBeenCalledTimes(1)
  })

  it('sets the about text and the name, and turns a false answer into WHATSAPP_ERROR', async () => {
    const setStatus = ok()
    const setDisplayName = jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const { service } = build({ setStatus, setDisplayName })

    await service.setStatus('s', 'hola')
    await service.setDisplayName('s', 'Soporte')
    await expect(service.setDisplayName('s', 'Otro')).rejects.toBeInstanceOf(WhatsAppError)

    expect(setStatus).toHaveBeenCalledWith('hola')
    expect(setDisplayName).toHaveBeenCalledWith('Soporte')
  })

  describe('picture', () => {
    const source = { url: 'https://example.com/a.png' }

    it('resolves the source and sets the image', async () => {
      const media = { mimetype: 'image/png', data: 'AAAA' }
      const setProfilePicture = ok(true)
      const { service, resolve } = build({ setProfilePicture }, jest.fn().mockResolvedValue(media))

      await service.setPicture('s', source)

      expect(resolve).toHaveBeenCalledWith('s', source)
      expect(setProfilePicture).toHaveBeenCalledWith(media)
    })

    it('refuses what is not an image before it reaches WhatsApp', async () => {
      const setProfilePicture = ok(true)
      const { service } = build(
        { setProfilePicture },
        jest.fn().mockResolvedValue({ mimetype: 'application/pdf', data: 'AAAA' })
      )

      await expect(service.setPicture('s', source)).rejects.toBeInstanceOf(ValidationError)
      expect(setProfilePicture).not.toHaveBeenCalled()
    })

    it('answers WHATSAPP_ERROR when WhatsApp refuses to set or to delete it', async () => {
      const { service } = build(
        { setProfilePicture: ok(false), deleteProfilePicture: ok(false) },
        jest.fn().mockResolvedValue({ mimetype: 'image/jpeg', data: 'AAAA' })
      )

      await expect(service.setPicture('s', source)).rejects.toBeInstanceOf(WhatsAppError)
      await expect(service.deletePicture('s')).rejects.toBeInstanceOf(WhatsAppError)
    })

    it('deletes the picture', async () => {
      const deleteProfilePicture = ok(true)
      const { service } = build({ deleteProfilePicture })

      await expect(service.deletePicture('s')).resolves.toBeUndefined()
      expect(deleteProfilePicture).toHaveBeenCalledTimes(1)
    })
  })

  describe('settings', () => {
    it('applies only the settings sent, in a fixed order', async () => {
      const order: string[] = []
      const record = (name: string) =>
        jest.fn((flag: boolean) => {
          order.push(`${name}:${String(flag)}`)
          return Promise.resolve()
        })
      const { service, mergeSettings } = build({
        setAutoDownloadAudio: record('audio'),
        setAutoDownloadDocuments: record('documents'),
        setAutoDownloadPhotos: record('photos'),
        setAutoDownloadVideos: record('videos'),
        setBackgroundSync: record('sync')
      })

      await service.setSettings('s', { backgroundSync: true, autoDownloadAudio: false })

      expect(order).toEqual(['audio:false', 'sync:true'])
      // Stored, so the session applies them again at its next start
      expect(mergeSettings).toHaveBeenCalledTimes(1)
      expect(mergeSettings).toHaveBeenCalledWith('s', {
        autoDownloadAudio: false,
        backgroundSync: true
      })
    })

    it('stops at the first failure and leaves the later settings untouched', async () => {
      const setAutoDownloadPhotos = jest.fn().mockRejectedValue(new Error('boom'))
      const setBackgroundSync = ok()
      const setAutoDownloadAudio = ok()
      const { service, mergeSettings } = build({
        setAutoDownloadAudio,
        setAutoDownloadPhotos,
        setBackgroundSync
      })

      await expect(
        service.setSettings('s', {
          autoDownloadAudio: true,
          autoDownloadPhotos: true,
          backgroundSync: true
        })
      ).rejects.toThrow('boom')

      expect(setAutoDownloadAudio).toHaveBeenCalledTimes(1)
      expect(setBackgroundSync).not.toHaveBeenCalled()
      // Only what the account has is stored
      expect(mergeSettings).toHaveBeenCalledWith('s', { autoDownloadAudio: true })
    })

    it('stores nothing when the first setting fails', async () => {
      const { service, mergeSettings } = build({
        setBackgroundSync: jest.fn().mockRejectedValue(new Error('boom'))
      })

      await expect(service.setSettings('s', { backgroundSync: true })).rejects.toThrow('boom')

      expect(mergeSettings).not.toHaveBeenCalled()
    })
  })

  it('needs a session that is ready', async () => {
    const requireReady = jest.fn(() => {
      throw new Error('not ready')
    })
    const service = new PresenceProfileService(
      { requireReady } as unknown as SessionManager,
      {} as MediaResolverService,
      {} as SessionsRepository
    )

    await expect(service.setPresence('s', 'available')).rejects.toThrow('not ready')
    await expect(service.setSettings('s', { backgroundSync: true })).rejects.toThrow('not ready')
  })
})
