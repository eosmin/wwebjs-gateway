import { z } from 'zod'

// One schema per DTO, covering every data field of the matching whatsapp-web.js interface (the
// methods are operations, not data). Serialization rules: ids are their serialized string, dates
// are ISO strings, Unix timestamps keep the name and the unit wwebjs gives them, bytes of media are
// never inlined here. A DTO has the id of its schema in `meta`, so the generated docs name it.
// wwebjs types some fields as always there although it only fills them for some kinds of message
// (polls, events, orders) or for some business profiles: those are optional here, so that a real
// object never fails its own schema.

const dto = <T extends z.ZodRawShape>(id: string, shape: T) => z.object(shape).meta({ id })

const unixSeconds = z.number().int()
const isoDate = z.iso.datetime()
const serializedId = z.string()

// A value whose shape WhatsApp does not fix (it is documented as `object` by wwebjs)
const opaque = z.json()

export const SESSION_STATUSES = [
  'created',
  'starting',
  'qr',
  'pairing_code',
  'authenticating',
  'ready',
  'disconnected',
  'stopped',
  'failed'
] as const

export const SessionStatus = z.enum(SESSION_STATUSES)
export type SessionStatus = z.infer<typeof SessionStatus>

// ---- Message ---------------------------------------------------------------------------------

export const LocationDto = dto('LocationDto', {
  latitude: z.string(),
  longitude: z.string(),
  name: z.string().optional(),
  address: z.string().optional(),
  url: z.string().optional(),
  description: z.string().optional()
})
export type LocationDto = z.infer<typeof LocationDto>

export const InviteV4Dto = dto('InviteV4Dto', {
  inviteCode: z.string(),
  inviteCodeExp: z.number(),
  groupId: z.string(),
  groupName: z.string().optional(),
  fromId: z.string(),
  toId: z.string()
})
export type InviteV4Dto = z.infer<typeof InviteV4Dto>

export const MessageMediaDto = dto('MessageMediaDto', {
  mimetype: z.string(),
  filename: z.string().nullish(),
  size: z.number().int().nullish(),
  downloadUrl: z.string(),
  base64: z
    .string()
    .optional()
    .describe(
      "Only when the webhook's mediaMode is inline and the size is within WEBHOOK_INLINE_MEDIA_MAX_BYTES"
    )
})
export type MessageMediaDto = z.infer<typeof MessageMediaDto>

export const OrderingDto = dto('OrderingDto', {
  held: z.boolean().describe('The message waited in the order buffer before it was published'),
  reordered: z.boolean().describe('Its position changed against the order it arrived in'),
  heldMs: z.number().int().describe('Milliseconds the message was held')
})
export type OrderingDto = z.infer<typeof OrderingDto>

export const OriginDto = dto('OriginDto', {
  kind: z.literal('click_to_whatsapp_ad'),
  conversionSource: z.string().optional(),
  sourceUrl: z.string().optional(),
  sourceId: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  thumbnailUrl: z.string().optional(),
  mediaUrl: z.string().optional(),
  ctwaClid: z.string().optional()
})
export type OriginDto = z.infer<typeof OriginDto>

export const MessageDto = dto('MessageDto', {
  // Gateway fields
  id: serializedId
    .describe('Serialized id of the message')
    .meta({ examples: ['false_5215500000001@c.us_3EB0C767D0F2A2B91F42'] }),
  chatId: z
    .string()
    .describe('The chat the message belongs to')
    .meta({ examples: ['5215500000001@c.us'] }),
  sentAt: isoDate.describe('When the sender wrote it (the wwebjs timestamp)'),
  receivedAt: isoDate.describe('When the gateway received it'),
  ordering: OrderingDto.optional(),
  origin: OriginDto.optional(),
  media: MessageMediaDto.optional(),
  raw: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Sanitized copy of rawData; its shape mirrors WhatsApp Web and may change'),
  // Fields of wwebjs Message
  ack: z
    .number()
    .int()
    .nullable()
    .describe(
      '-1 error, 0 pending, 1 server, 2 device, 3 read, 4 played; null when WhatsApp gave none'
    ),
  author: z.string().optional(),
  deviceType: z.string(),
  body: z.string().meta({ examples: ['Hola, ¿cuál es el precio?'] }),
  broadcast: z.boolean(),
  isStatus: z.boolean(),
  isGif: z.boolean(),
  isEphemeral: z.boolean(),
  from: z.string().meta({ examples: ['5215500000001@c.us'] }),
  fromMe: z.boolean(),
  hasMedia: z.boolean(),
  hasQuotedMsg: z.boolean(),
  hasReaction: z.boolean(),
  duration: z.string().optional(),
  isForwarded: z.boolean(),
  forwardingScore: z.number().int(),
  isStarred: z.boolean(),
  location: LocationDto.optional(),
  vCards: z.array(z.string()),
  inviteV4: InviteV4Dto.optional(),
  mediaKey: z.string().optional(),
  mentionedIds: z.array(z.string()),
  groupMentions: z.array(z.object({ groupSubject: z.string(), groupJid: z.string() })),
  timestamp: unixSeconds,
  to: z.string().meta({ examples: ['5215500000002@c.us'] }),
  type: z
    .string()
    .describe('The wwebjs message type, such as chat, image, ptt or poll_creation')
    .meta({ examples: ['chat'] }),
  links: z.array(z.object({ link: z.string(), isSuspicious: z.boolean() })),
  orderId: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  businessOwnerJid: z.string().optional(),
  productId: z.string().optional(),
  latestEditSenderTimestampMs: z.number().optional(),
  latestEditMsgKey: serializedId.optional(),
  protocolMessageKey: serializedId.optional(),
  dynamicReplyButtons: opaque.optional(),
  selectedButtonId: z.string().optional(),
  selectedRowId: z.string().optional(),
  pollName: z.string().optional(),
  pollOptions: z.array(z.string()).optional(),
  allowMultipleAnswers: z.boolean().optional(),
  eventStartTime: unixSeconds.optional(),
  eventEndTime: unixSeconds.optional(),
  eventDescription: z.string().optional(),
  eventLocation: z
    .object({
      degreesLatitude: z.number(),
      degreesLongitude: z.number(),
      name: z.string()
    })
    .optional(),
  eventJoinLink: z.string().optional(),
  isEventCanceled: z.boolean().optional().describe('wwebjs spells this isEventCaneled'),
  messageSecret: z.array(z.number()).optional()
})
export type MessageDto = z.infer<typeof MessageDto>

export const MessageInfoDto = dto('MessageInfoDto', {
  delivery: z.array(z.object({ id: serializedId, t: unixSeconds })),
  deliveryRemaining: z.number().int(),
  played: z.array(z.object({ id: serializedId, t: unixSeconds })),
  playedRemaining: z.number().int(),
  read: z.array(z.object({ id: serializedId, t: unixSeconds })),
  readRemaining: z.number().int()
})
export type MessageInfoDto = z.infer<typeof MessageInfoDto>

export const ReactionDto = dto('ReactionDto', {
  id: serializedId,
  orphan: z.number().int(),
  orphanReason: z.string().optional(),
  timestamp: unixSeconds,
  reaction: z.string(),
  read: z.boolean(),
  msgId: serializedId,
  senderId: z.string(),
  ack: z.number().int().optional()
})
export type ReactionDto = z.infer<typeof ReactionDto>

export const ReactionListDto = dto('ReactionListDto', {
  id: z.string(),
  aggregateEmoji: z.string(),
  hasReactionByMe: z.boolean(),
  senders: z.array(ReactionDto)
})
export type ReactionListDto = z.infer<typeof ReactionListDto>

export const PollVoteDto = dto('PollVoteDto', {
  voter: z.string(),
  selectedOptions: z.array(z.object({ id: z.number().int(), name: z.string() })),
  interactedAtTs: z.number().describe('wwebjs spells this interractedAtTs'),
  parentMessageId: serializedId.describe('Id of the poll creation message (wwebjs parentMessage)')
})
export type PollVoteDto = z.infer<typeof PollVoteDto>

// ---- Contact ---------------------------------------------------------------------------------

export const ContactDto = dto('ContactDto', {
  id: serializedId,
  number: z.string(),
  isBusiness: z.boolean(),
  isEnterprise: z.boolean(),
  isGroup: z.boolean(),
  isMe: z.boolean(),
  isMyContact: z.boolean(),
  isUser: z.boolean(),
  isWAContact: z.boolean(),
  isBlocked: z.boolean(),
  labels: z.array(z.string()).optional(),
  name: z.string().optional(),
  pushname: z.string(),
  sectionHeader: z.string(),
  shortName: z.string().optional(),
  statusMute: z.boolean(),
  type: z.string(),
  verifiedLevel: z.string().optional(),
  verifiedName: z.string().optional()
})
export type ContactDto = z.infer<typeof ContactDto>

const businessHoursOfDay = z.object({ mode: z.string(), hours: z.array(z.number()) })

export const BusinessProfileDto = dto('BusinessProfileDto', {
  id: serializedId,
  tag: z.string(),
  description: z.string().nullish(),
  categories: z.array(z.object({ id: z.string(), localized_display_name: z.string() })),
  profileOptions: z.object({ commerceExperience: z.string(), cartEnabled: z.boolean() }),
  email: z.string().nullish(),
  website: z.array(z.string()).optional(),
  latitude: z.number().nullish(),
  longitude: z.number().nullish(),
  businessHours: z.object({
    config: z.record(z.string(), businessHoursOfDay).describe('Keyed by day: sun, mon, tue…'),
    timezone: z.string()
  }),
  address: z.string().nullish(),
  fbPage: opaque.nullish(),
  ifProfileLinked: z.boolean(),
  coverPhoto: opaque.nullish()
})
export type BusinessProfileDto = z.infer<typeof BusinessProfileDto>

export const BusinessContactDto = dto('BusinessContactDto', {
  ...ContactDto.shape,
  businessProfile: BusinessProfileDto
})
export type BusinessContactDto = z.infer<typeof BusinessContactDto>

// ---- Chats, groups, channels -------------------------------------------------------------------

export const ChatDto = dto('ChatDto', {
  id: serializedId,
  archived: z.boolean(),
  isGroup: z.boolean(),
  isReadOnly: z.boolean(),
  isMuted: z.boolean(),
  muteExpiration: unixSeconds,
  name: z.string(),
  timestamp: unixSeconds,
  unreadCount: z.number().int(),
  lastMessage: MessageDto.optional(),
  pinned: z.boolean(),
  isLocked: z.boolean()
})
export type ChatDto = z.infer<typeof ChatDto>

export const GroupParticipantDto = dto('GroupParticipantDto', {
  id: serializedId,
  isAdmin: z.boolean(),
  isSuperAdmin: z.boolean()
})
export type GroupParticipantDto = z.infer<typeof GroupParticipantDto>

export const GroupChatDto = dto('GroupChatDto', {
  ...ChatDto.shape,
  owner: serializedId,
  createdAt: isoDate,
  description: z.string(),
  participants: z.array(GroupParticipantDto)
})
export type GroupChatDto = z.infer<typeof GroupChatDto>

export const ChannelDto = dto('ChannelDto', {
  id: serializedId,
  name: z.string(),
  description: z.string(),
  isChannel: z.boolean(),
  isGroup: z.boolean(),
  isReadOnly: z.boolean(),
  unreadCount: z.number().int(),
  timestamp: unixSeconds,
  isMuted: z.boolean(),
  muteExpiration: unixSeconds,
  lastMessage: MessageDto.optional()
})
export type ChannelDto = z.infer<typeof ChannelDto>

export const MembershipRequestDto = dto('MembershipRequestDto', {
  id: serializedId.describe('Who asks to enter the group'),
  addedBy: serializedId.describe('Who created the request'),
  parentGroupId: serializedId.nullish(),
  requestMethod: z.string().describe('NonAdminAdd, InviteLink or LinkedGroupJoin'),
  t: unixSeconds
})
export type MembershipRequestDto = z.infer<typeof MembershipRequestDto>

export const GroupNotificationDto = dto('GroupNotificationDto', {
  id: serializedId,
  author: z.string(),
  body: z.string(),
  chatId: z.string(),
  recipientIds: z.array(z.string()),
  timestamp: unixSeconds,
  type: z
    .string()
    .describe(
      'add, invite, remove, leave, promote, demote, subject, description, picture, announce or restrict'
    )
})
export type GroupNotificationDto = z.infer<typeof GroupNotificationDto>

// ---- Labels, broadcasts, calls -----------------------------------------------------------------

export const LabelDto = dto('LabelDto', {
  id: z.string(),
  name: z.string(),
  hexColor: z.string()
})
export type LabelDto = z.infer<typeof LabelDto>

export const BroadcastDto = dto('BroadcastDto', {
  id: serializedId,
  timestamp: unixSeconds,
  totalCount: z.number().int(),
  unreadCount: z.number().int(),
  msgs: z.array(MessageDto)
})
export type BroadcastDto = z.infer<typeof BroadcastDto>

export const CallDto = dto('CallDto', {
  id: z.string(),
  from: z.string().optional(),
  timestamp: unixSeconds,
  isVideo: z.boolean(),
  isGroup: z.boolean(),
  fromMe: z.boolean(),
  canHandleLocally: z.boolean(),
  webClientShouldHandle: z.boolean(),
  participants: opaque.optional()
})
export type CallDto = z.infer<typeof CallDto>

// ---- Commerce ----------------------------------------------------------------------------------

export const ProductDto = dto('ProductDto', {
  id: z.string(),
  price: z.string().optional(),
  thumbnailUrl: z.string(),
  currency: z.string(),
  name: z.string(),
  quantity: z.number().int()
})
export type ProductDto = z.infer<typeof ProductDto>

export const OrderDto = dto('OrderDto', {
  products: z.array(ProductDto),
  subtotal: z.string(),
  total: z.string(),
  currency: z.string(),
  createdAt: unixSeconds
})
export type OrderDto = z.infer<typeof OrderDto>

export const PaymentDto = dto('PaymentDto', {
  id: serializedId,
  paymentCurrency: z.string(),
  paymentAmount1000: z.number(),
  paymentMessageReceiverJid: serializedId,
  paymentTransactionTimestamp: unixSeconds,
  paymentStatus: z.number().int(),
  paymentTxnStatus: z.number().int(),
  paymentNote: z.string()
})
export type PaymentDto = z.infer<typeof PaymentDto>

// ---- Client ------------------------------------------------------------------------------------

export const BatteryInfoDto = dto('BatteryInfoDto', {
  battery: z.number(),
  plugged: z.boolean()
})
export type BatteryInfoDto = z.infer<typeof BatteryInfoDto>

export const ClientInfoDto = dto('ClientInfoDto', {
  wid: serializedId,
  me: serializedId.describe('Deprecated in wwebjs, use wid'),
  platform: z.string(),
  pushname: z.string(),
  phone: z
    .object({
      wa_version: z.string(),
      os_version: z.string(),
      device_manufacturer: z.string(),
      device_model: z.string(),
      os_build_number: z.string()
    })
    .optional()
    .describe('Deprecated in wwebjs; not available on multi-device accounts')
})
export type ClientInfoDto = z.infer<typeof ClientInfoDto>
