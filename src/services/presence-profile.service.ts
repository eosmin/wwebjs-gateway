import { Inject, Injectable } from '@nestjs/common'

import { ValidationError, WhatsAppError } from '../common/errors.js'
import { SessionsRepository } from '../database/repositories/sessions.repository.js'
import type { MediaSource } from '../types/messages.dto.js'
import type { SetAccountSettingsBody } from '../types/presence-profile.dto.js'
import { ACCOUNT_SETTING_CALLS, type AccountSettingKey } from '../whatsapp/account-settings.js'
import { SessionManager } from '../whatsapp/session-manager.service.js'

import { MediaResolverService } from './media-resolver.service.js'

// What the presence, profile and settings routes do: each is a call to the session's client
@Injectable()
export class PresenceProfileService {
  constructor(
    @Inject(SessionManager) private readonly sessions: SessionManager,
    @Inject(MediaResolverService) private readonly media: MediaResolverService,
    @Inject(SessionsRepository) private readonly rows: SessionsRepository
  ) {}

  async setPresence(sessionId: string, state: 'available' | 'unavailable'): Promise<void> {
    const client = this.sessions.requireReady(sessionId)
    if (state === 'available') await client.sendPresenceAvailable()
    else await client.sendPresenceUnavailable()
  }

  async setStatus(sessionId: string, status: string): Promise<void> {
    await this.sessions.requireReady(sessionId).setStatus(status)
  }

  async setDisplayName(sessionId: string, displayName: string): Promise<void> {
    const client = this.sessions.requireReady(sessionId)
    this.assertDone(await client.setDisplayName(displayName), 'change the name of the profile')
  }

  async setPicture(sessionId: string, source: MediaSource): Promise<void> {
    const client = this.sessions.requireReady(sessionId)
    const picture = await this.media.resolve(sessionId, source)
    if (!picture.mimetype.toLowerCase().startsWith('image/')) {
      throw new ValidationError('VALIDATION_ERROR', 'The profile picture must be an image', {
        field: 'source',
        mimetype: picture.mimetype
      })
    }
    this.assertDone(await client.setProfilePicture(picture), 'change the profile picture')
  }

  async deletePicture(sessionId: string): Promise<void> {
    const client = this.sessions.requireReady(sessionId)
    this.assertDone(await client.deleteProfilePicture(), 'delete the profile picture')
  }

  // One call per setting, in a fixed order. WhatsApp has no call that sets several at once, so a
  // failure leaves the settings before it applied and the ones after it untouched. What was applied
  // is stored in `Session.settings`, failure or not, so the session applies it again at every start
  // and the stored flags always say what the account has.
  async setSettings(sessionId: string, settings: SetAccountSettingsBody): Promise<void> {
    const client = this.sessions.requireReady(sessionId)
    const applied: Partial<Record<AccountSettingKey, boolean>> = {}
    try {
      for (const [key, method] of ACCOUNT_SETTING_CALLS) {
        const flag = settings[key]
        if (flag === undefined) continue
        await client[method](flag)
        applied[key] = flag
      }
    } finally {
      if (Object.keys(applied).length > 0) await this.rows.mergeSettings(sessionId, applied)
    }
  }

  // A call that answers false when WhatsApp Web did not do it
  private assertDone(done: boolean, what: string): void {
    if (!done) throw new WhatsAppError('WHATSAPP_ERROR', `WhatsApp did not ${what}`)
  }
}
