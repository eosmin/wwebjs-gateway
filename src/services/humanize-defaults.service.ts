import { Inject, Injectable, Logger } from '@nestjs/common'
import { z } from 'zod'

import { SessionsRepository } from '../database/repositories/sessions.repository.js'
import { HumanizeSettings } from '../types/sessions.dto.js'

import type { HumanizeOptions } from './send-queue.job.js'

// The humanize of a request: the options of a job, and `enabled` to switch the typing off
type HumanizeRequest = HumanizeOptions & { enabled?: boolean }

// The request's `enabled` only decides whether to humanize; the job carries the rest
const withoutEnabled = ({
  typing,
  recording,
  markSeenFirst,
  minReplyDelayMs
}: HumanizeRequest): HumanizeOptions => ({
  ...(typing !== undefined && { typing }),
  ...(recording !== undefined && { recording }),
  ...(markSeenFirst !== undefined && { markSeenFirst }),
  ...(minReplyDelayMs !== undefined && { minReplyDelayMs })
})

const SettingsEnvelope = z.looseObject({ humanize: HumanizeSettings.optional() })

// What a message is humanized with: the `humanize` of the request when it has one, otherwise the
// defaults of the session for text (TDD §6.8: on by default for text, off for everything else).
// The result is fixed when the send is accepted, so a queued job does not change if the settings do.
@Injectable()
export class HumanizeDefaultsService {
  private readonly logger = new Logger(HumanizeDefaultsService.name)

  constructor(@Inject(SessionsRepository) private readonly sessions: SessionsRepository) {}

  async resolve(
    sessionId: string,
    requested: HumanizeRequest | undefined,
    contentType: string
  ): Promise<HumanizeOptions | undefined> {
    if (requested !== undefined)
      return requested.enabled === false ? undefined : withoutEnabled(requested)
    if (contentType !== 'text') return undefined
    const settings = await this.settingsOf(sessionId)
    if (settings.enabled === false) return undefined
    return {
      typing: settings.typing ?? 'auto',
      ...(settings.recording !== undefined && { recording: settings.recording }),
      ...(settings.markSeenFirst !== undefined && { markSeenFirst: settings.markSeenFirst }),
      ...(settings.minReplyDelayMs !== undefined && { minReplyDelayMs: settings.minReplyDelayMs })
    }
  }

  private async settingsOf(sessionId: string): Promise<HumanizeSettings> {
    // Typing before a text is a courtesy: a database that cannot be read must not stop the send
    const row = await this.sessions.findById(sessionId).catch((): null => {
      this.logger.warn(`[${sessionId}] The session could not be read for its humanize settings`)
      return null
    })
    const parsed = SettingsEnvelope.safeParse(row?.settings ?? {})
    if (parsed.success) return parsed.data.humanize ?? {}
    // Settings that do not fit the schema (another gateway version) must not stop a send
    this.logger.warn(`[${sessionId}] The humanize settings are not valid; the defaults are used`)
    return {}
  }
}
