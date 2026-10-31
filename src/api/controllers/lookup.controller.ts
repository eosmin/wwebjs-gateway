import { Controller, Get, Inject, Param, Query } from '@nestjs/common'
import { ZodResponse } from 'nestjs-zod'

import type { ErrorCode } from '../../common/errors.js'
import { LookupService } from '../../services/lookup.service.js'
import {
  LidPhoneListDto,
  LidPhoneQueryDto,
  NumberLookupDto,
  NumberParamsDto,
  lidPhoneIds
} from '../../types/lookup.dto.js'
import { SessionIdParamsDto } from '../../types/sessions.dto.js'
import { WaOperation } from '../wa-operation.decorator.js'

const ON_SESSION: ErrorCode[] = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'INSUFFICIENT_SCOPE',
  'NOT_FOUND',
  'SESSION_NOT_READY',
  'WHATSAPP_ERROR'
]

// Who a phone number or an id is, without sending anything
@Controller('v1/sessions')
export class LookupController {
  constructor(@Inject(LookupService) private readonly lookup: LookupService) {}

  @Get(':sessionId/numbers/:number')
  @ZodResponse({ type: NumberLookupDto })
  @WaOperation({
    id: 'numbers.lookup',
    scope: 'read',
    summary: 'Check whether a phone number is on WhatsApp',
    description:
      'Answers 200 with `registered: false` for a number without an account (WhatsApp Web can wrongly answer "no" while it is busy, so ask again later before treating it as final). A registered number carries its WhatsApp id, its country calling code and its formatted form. The answer is cached (an hour when registered, five minutes when not), and a look-up that is not cached counts against `LOOKUPS_PER_DAY`: past it the answer is `422 POLICY_BLOCKED`.',
    errors: [...ON_SESSION, 'POLICY_BLOCKED'],
    examples: {
      request: null,
      response: {
        number: '5215500000001',
        registered: true,
        id: '5215500000001@c.us',
        countryCode: '52',
        formatted: '+52 1 55 0000 0001'
      }
    },
    wwebjs: [
      'Client.getNumberId',
      'Client.isRegisteredUser',
      'Client.getCountryCode',
      'Client.getFormattedNumber'
    ]
  })
  number(@Param() { sessionId, number }: NumberParamsDto): Promise<NumberLookupDto> {
    return this.lookup.number(sessionId, number)
  }

  @Get(':sessionId/contacts/lid-phone')
  @ZodResponse({ type: LidPhoneListDto })
  @WaOperation({
    id: 'contacts.lidPhone',
    scope: 'read',
    summary: 'Match @lid ids with phone ids',
    description:
      'For each id given in `ids` (comma-separated, `@c.us` or `@lid`, up to 50) WhatsApp answers the pair `{ lid, pn }`. An id it does not know is left out of `items`.',
    errors: ON_SESSION,
    examples: {
      request: null,
      response: { items: [{ lid: '100000000000001@lid', pn: '5215500000001@c.us' }] }
    },
    wwebjs: ['Client.getContactLidAndPhone']
  })
  async lidPhone(
    @Param() { sessionId }: SessionIdParamsDto,
    @Query() query: LidPhoneQueryDto
  ): Promise<LidPhoneListDto> {
    return { items: await this.lookup.lidAndPhone(sessionId, lidPhoneIds(query)) }
  }
}
