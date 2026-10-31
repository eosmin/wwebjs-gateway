import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { isWaId, phoneDigits } from '../common/lib/wa-id.js'

import { SessionId } from './sessions.dto.js'

// More ids than this in one request are refused: each is a browser call
export const MAX_LID_PHONE_IDS = 50

export const NumberParams = z.strictObject({
  sessionId: SessionId,
  number: z
    .string()
    .max(40)
    .refine(value => phoneDigits(value) !== null, {
      message: 'must be a phone number of 7 to 15 digits'
    })
    .describe('A phone number of 7 to 15 digits, with an optional `+` and spaces, dashes or dots')
})
export class NumberParamsDto extends createZodDto(NumberParams) {}

// The ids of a query string are one comma-separated value: `?ids=a@lid,b@c.us`
const splitIds = (value: string): string[] =>
  value
    .split(',')
    .map(id => id.trim())
    .filter(id => id !== '')

export const LidPhoneQuery = z.strictObject({
  ids: z
    .string()
    .max(MAX_LID_PHONE_IDS * 70)
    .refine(value => splitIds(value).length > 0, { message: 'at least one id' })
    .refine(value => splitIds(value).length <= MAX_LID_PHONE_IDS, {
      message: `at most ${MAX_LID_PHONE_IDS} ids`
    })
    .refine(value => splitIds(value).every(id => isWaId(id) && /@(c\.us|lid)$/.test(id)), {
      message: 'every id must end in @c.us or @lid'
    })
    .describe(
      `Comma-separated ids of users, each ending in @c.us or @lid, up to ${MAX_LID_PHONE_IDS}`
    )
})
export class LidPhoneQueryDto extends createZodDto(LidPhoneQuery) {}

export function lidPhoneIds(query: { ids: string }): string[] {
  return [...new Set(splitIds(query.ids))]
}

// ---- Responses ---------------------------------------------------------------------------------

export const NumberLookup = z.object({
  number: z.string().describe('The digits that were looked up'),
  registered: z.boolean().describe('Whether the number has a WhatsApp account'),
  id: z.string().nullable().describe('The WhatsApp id of the number, null when not registered'),
  countryCode: z
    .string()
    .nullable()
    .describe('The calling code of the country, null when not registered'),
  formatted: z
    .string()
    .nullable()
    .describe('The number written the way WhatsApp shows it, null when not registered')
})
export type NumberLookup = z.infer<typeof NumberLookup>
export class NumberLookupDto extends createZodDto(NumberLookup) {}

export const LidPhoneList = z.object({
  items: z.array(
    z.object({
      lid: z
        .string()
        .nullable()
        .describe('The id of the user in the @lid form, null when WhatsApp has none for the phone'),
      pn: z
        .string()
        .nullable()
        .describe('The id of the user in the phone (@c.us) form, null when the @lid hides it')
    })
  )
})
export class LidPhoneListDto extends createZodDto(LidPhoneList) {}
