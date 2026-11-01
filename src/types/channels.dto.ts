import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'

import { isChannelId, isWaId } from '../common/lib/wa-id.js'

import { AnyContact } from './contacts.dto.js'
import { ChannelDto, MessageDto } from './dto.js'
import { MediaSource } from './messages.dto.js'
import { SessionId } from './sessions.dto.js'

// WhatsApp limits: a channel name has 100 characters and a description 2048
export const MAX_CHANNEL_NAME_LENGTH = 100
export const MAX_CHANNEL_DESCRIPTION_LENGTH = 2048
export const MAX_SUBSCRIBERS_LIMIT = 1000
export const MAX_SEARCH_LIMIT = 100
// The values wwebjs documents for `Channel.setReactionSetting`
export const REACTION_SETTINGS = { none: 0, basic: 1, all: 2 } as const

const ChannelId = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(isChannelId, {
    message: 'must be a channel id ending in @newsletter'
  })
  .describe('Serialized id of the channel, such as 120363000000000001@newsletter')

const UserId = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(value => isWaId(value) && /@(c\.us|lid)$/.test(value), {
    message: 'must be a user id ending in @c.us or @lid'
  })
  .describe('Serialized id of a user, such as 5215500000001@c.us or 100000000000001@lid')

const InviteCode = z
  .string()
  .trim()
  .regex(/^[\w-]{10,64}$/, 'must be the code of a channel link, not the whole link')
  .describe('The code at the end of https://whatsapp.com/channel/<code>')

// ---- Params ------------------------------------------------------------------------------------

export const SessionChannelParams = z.strictObject({ sessionId: SessionId, channelId: ChannelId })
export class SessionChannelParamsDto extends createZodDto(SessionChannelParams) {}

export const SessionChannelUserParams = z.strictObject({
  sessionId: SessionId,
  channelId: ChannelId,
  userId: UserId
})
export class SessionChannelUserParamsDto extends createZodDto(SessionChannelUserParams) {}

export const SessionChannelInviteParams = z.strictObject({
  sessionId: SessionId,
  inviteCode: InviteCode
})
export class SessionChannelInviteParamsDto extends createZodDto(SessionChannelInviteParams) {}

// ---- Queries -----------------------------------------------------------------------------------

export const SearchChannelsQuery = z.strictObject({
  searchText: z.string().trim().min(1).max(100).optional().describe('Words in the name'),
  countryCodes: z
    .string()
    .regex(/^[A-Za-z]{2}(,[A-Za-z]{2}){0,19}$/, 'ISO 3166-1 alpha-2 codes separated by commas')
    .transform(value => [...new Set(value.toUpperCase().split(','))])
    .optional()
    .describe('Countries to search in, such as MX,US; wwebjs defaults to the account country'),
  skipSubscribedNewsletters: z
    .stringbool()
    .optional()
    .describe('Leave out the channels the account already follows'),
  view: z.coerce
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe('WhatsApp view of the directory: 0 recommended, 1 popular, 2 trending, 3 new'),
  limit: z.coerce.number().int().min(1).max(MAX_SEARCH_LIMIT).optional()
})
export type SearchChannelsQuery = z.infer<typeof SearchChannelsQuery>
export class SearchChannelsQueryDto extends createZodDto(SearchChannelsQuery) {}

export const SubscribersQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(MAX_SUBSCRIBERS_LIMIT).default(50)
})
export class SubscribersQueryDto extends createZodDto(SubscribersQuery) {}

export const ChannelMessagesQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  fromMe: z.stringbool().optional().describe('Only the posts the account made (true) or the rest')
})
export class ChannelMessagesQueryDto extends createZodDto(ChannelMessagesQuery) {}

// ---- Bodies ------------------------------------------------------------------------------------

const Name = z
  .string()
  .trim()
  .min(1)
  .max(MAX_CHANNEL_NAME_LENGTH)
  .describe(`The name of the channel, up to ${MAX_CHANNEL_NAME_LENGTH} characters`)

const Description = z.string().max(MAX_CHANNEL_DESCRIPTION_LENGTH)

const PictureSource = MediaSource.describe(
  'An image: inline `base64` (the body of a request is limited to 1 MiB), a public `url` (fetched by the gateway), or the `messageId` of a message whose image is used'
)

export const CreateChannelBody = z.strictObject({
  name: Name,
  description: Description.optional(),
  picture: PictureSource.optional()
})
export type CreateChannelBody = z.infer<typeof CreateChannelBody>
export class CreateChannelBodyDto extends createZodDto(CreateChannelBody) {}

export const UpdateChannelBody = z
  .strictObject({
    name: Name.optional(),
    description: Description.optional().describe('An empty text removes the description')
  })
  .refine(body => Object.keys(body).length > 0, {
    message: 'send at least a name or a description'
  })
export class UpdateChannelBodyDto extends createZodDto(UpdateChannelBody) {}

export const SetChannelPictureBody = z.strictObject({ source: PictureSource })
export class SetChannelPictureBodyDto extends createZodDto(SetChannelPictureBody) {}

export const ReactionSettingBody = z.strictObject({
  setting: z
    .enum(Object.keys(REACTION_SETTINGS) as [keyof typeof REACTION_SETTINGS])
    .describe('`none`: no reactions; `basic`: 👍 ❤️ 😂 😮 😢 🙏; `all`: any emoji')
})
export type ReactionSettingBody = z.infer<typeof ReactionSettingBody>
export class ReactionSettingBodyDto extends createZodDto(ReactionSettingBody) {}

export const UnsubscribeBody = z
  .strictObject({
    deleteLocalModels: z
      .boolean()
      .optional()
      .describe('Also delete the channel from the account; it then becomes a guest membership')
  })
  .default({})
export type UnsubscribeBody = z.infer<typeof UnsubscribeBody>
export class UnsubscribeBodyDto extends createZodDto(UnsubscribeBody) {}

export const AdminInviteBody = z.strictObject({
  userId: UserId.describe('Who is invited to be an admin'),
  comment: z.string().max(1000).optional().describe('Text sent with the invitation')
})
export type AdminInviteBody = z.infer<typeof AdminInviteBody>
export class AdminInviteBodyDto extends createZodDto(AdminInviteBody) {}

export const TransferOwnershipBody = z.strictObject({
  newOwnerId: UserId.describe('The new owner, who must already be an admin of the channel'),
  shouldDismissSelfAsAdmin: z
    .boolean()
    .optional()
    .describe('The account stops being an admin once the ownership moved')
})
export type TransferOwnershipBody = z.infer<typeof TransferOwnershipBody>
export class TransferOwnershipBodyDto extends createZodDto(TransferOwnershipBody) {}

// What a channel carries: text, or one media file with a caption. Polls, locations and the rest are
// not posts of a channel.
const Mentions = z.array(UserId).max(50).optional().describe('Users mentioned in the post')
export const ChannelPostBody = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('text'),
    body: z.string().min(1).max(65_536),
    mentions: Mentions
  }),
  z.strictObject({
    type: z.literal('media'),
    source: MediaSource.describe(
      'Inline `base64`, a public `url` (fetched by the gateway), or the `messageId` of a message whose media is posted again'
    ),
    caption: z.string().max(4096).optional(),
    mentions: Mentions
  })
])
export type ChannelPostBody = z.infer<typeof ChannelPostBody>

// ---- Responses ---------------------------------------------------------------------------------

// The message inside the channel is the copy without its `meta.id` (see chats.dto.ts)
const Channel = z.object({
  ...ChannelDto.shape,
  lastMessage: z.object(MessageDto.shape).optional()
})

export const ChannelResponseDto = createZodDto(Channel)
export class ChannelListDto extends createZodDto(z.object({ items: z.array(Channel) })) {}

export class CreatedChannelDto extends createZodDto(
  z.object({
    name: z.string(),
    channelId: z.string().describe('Id of the new channel'),
    inviteLink: z.string(),
    createdAt: z.number().int().describe('Unix seconds')
  })
) {}

export class ChannelMessageListDto extends createZodDto(
  z.object({ items: z.array(z.object(MessageDto.shape)) })
) {}

export class SubscriberListDto extends createZodDto(
  z.object({
    items: z.array(
      z.object({
        contact: AnyContact,
        role: z.string().describe('The role WhatsApp gives the subscriber, such as `subscriber`')
      })
    )
  })
) {}
