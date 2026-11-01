import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { isWaId } from '../common/lib/wa-id.js'

import {
  BroadcastDto,
  BusinessContactDto,
  BusinessProfileDto,
  ContactDto,
  MessageDto
} from './dto.js'
import { SessionId } from './sessions.dto.js'

// A user (`@c.us` or `@lid`); a group or a channel is a chat, not a contact
const ContactId = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(value => isWaId(value) && /@(c\.us|lid)$/.test(value), {
    message: 'must be a user id ending in @c.us or @lid'
  })
  .describe('Serialized id of the contact, such as 5215500000001@c.us or 100000000000001@lid')

export const SessionContactParams = z.strictObject({ sessionId: SessionId, contactId: ContactId })
export class SessionContactParamsDto extends createZodDto(SessionContactParams) {}

// The address book is keyed by phone number: the user part of a `@c.us` id, never a `@lid`
export const AddressbookParams = z.strictObject({
  sessionId: SessionId,
  contactId: ContactId.refine(value => value.endsWith('@c.us'), {
    message: 'the address book is keyed by phone: use the @c.us id'
  }).refine(value => /^\d{7,15}@c\.us$/.test(value), {
    message: 'the id must hold only the 7 to 15 digits of a phone number'
  })
})
export class AddressbookParamsDto extends createZodDto(AddressbookParams) {}

const Name = z.string().trim().max(100)

export const SaveAddressbookBody = z.strictObject({
  firstName: Name.min(1).describe('First name shown on the phone'),
  lastName: Name.describe('Last name; may be empty'),
  syncToAddressbook: z
    .boolean()
    .optional()
    .describe('Also save it in the address book of the linked phone (wwebjs default: false)')
})
export class SaveAddressbookBodyDto extends createZodDto(SaveAddressbookBody) {}

// The digits of the phone number of a `@c.us` id that the params already validated
export const addressbookNumber = (contactId: string): string => contactId.replace(/@c\.us$/, '')

// ---- Responses ---------------------------------------------------------------------------------

// The DTO schemas carry an id in their meta: a copy without it keeps nestjs-zod from seeing two
// definitions of the same id once the schema sits inside several responses (see messages.dto.ts)
const plain = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) => z.object(schema.shape)

// A business contact has everything a contact has plus its profile, so it is tried first (an object
// schema strips what it does not know)
const AnyContact = z.union([
  z.object({ ...BusinessContactDto.shape, businessProfile: plain(BusinessProfileDto) }),
  plain(ContactDto)
])

// A union cannot be the base of a class, so this one is the DTO value without a class
export const ContactResponseDto = createZodDto(AnyContact)
export class ContactListDto extends createZodDto(z.object({ items: z.array(AnyContact) })) {}

export class ContactAboutDto extends createZodDto(
  z.object({
    about: z
      .string()
      .nullable()
      .describe('The status text; null when WhatsApp gives none (no permission to read it)')
  })
) {}

export class ContactPictureDto extends createZodDto(
  z.object({
    url: z
      .string()
      .nullable()
      .describe(
        'Link to the profile picture; null when WhatsApp gives none (privacy settings of the contact)'
      )
  })
) {}

export class CommonGroupsDto extends createZodDto(
  z.object({ items: z.array(z.string()).describe('Ids of the groups shared with the contact') })
) {}

export class DeviceCountDto extends createZodDto(
  z.object({
    count: z
      .number()
      .int()
      .min(0)
      .describe(
        'Devices registered for the contact, the phone included; 0 when WhatsApp lists none'
      )
  })
) {}

export class ContactBroadcastDto extends createZodDto(
  z.object({
    ...BroadcastDto.shape,
    msgs: z.array(z.object(MessageDto.shape))
  })
) {}
