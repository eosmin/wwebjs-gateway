import { Inject, Injectable } from '@nestjs/common'

import { ValidationError } from '../common/errors.js'
import { phoneDigits } from '../common/lib/wa-id.js'
import type { NumberLookup } from '../types/lookup.dto.js'
import { SessionManager } from '../whatsapp/session-manager.service.js'

import { RecipientResolverService } from './recipient-resolver.service.js'

export interface KnownLidAndPhone {
  lid: string | null
  pn: string | null
}

// Finding out who a number or an id is, without sending anything
@Injectable()
export class LookupService {
  constructor(
    @Inject(SessionManager) private readonly sessions: SessionManager,
    @Inject(RecipientResolverService) private readonly resolver: RecipientResolverService
  ) {}

  // Goes through the resolver, so the answer is shared with the sends (an hour for a number that
  // is registered, five minutes for one that is not) and a look-up that is not cached counts
  // against LOOKUPS_PER_DAY. The country code and the format are only asked for a registered number.
  async number(sessionId: string, number: string): Promise<NumberLookup> {
    const digits = phoneDigits(number)
    if (digits === null) {
      throw new ValidationError('VALIDATION_ERROR', 'The number must have 7 to 15 digits', {
        field: 'number'
      })
    }
    // Asked first, so a cached answer does not depend on the state of the session
    const client = this.sessions.requireReady(sessionId)
    const id = await this.resolver.lookup(sessionId, digits)
    if (id === null) {
      return { number: digits, registered: false, id: null, countryCode: null, formatted: null }
    }
    const [countryCode, formatted] = await Promise.all([
      client.getCountryCode(digits),
      client.getFormattedNumber(digits)
    ])
    return { number: digits, registered: true, id, countryCode, formatted }
  }

  async lidAndPhone(sessionId: string, ids: string[]): Promise<KnownLidAndPhone[]> {
    const pairs = await this.sessions.requireReady(sessionId).getContactLidAndPhone(ids)
    const known: KnownLidAndPhone[] = []
    for (const { lid, pn } of pairs) {
      // A pair with neither side says nothing about the id asked, so it is left out.
      if (lid != null || pn != null) known.push({ lid: lid ?? null, pn: pn ?? null })
    }
    return known
  }
}
