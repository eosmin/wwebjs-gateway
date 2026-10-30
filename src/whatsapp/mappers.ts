import type {
  BatteryInfoDto,
  BroadcastDto,
  BusinessContactDto,
  CallDto,
  ChannelDto,
  ChatDto,
  ClientInfoDto,
  ContactDto,
  GroupChatDto,
  GroupNotificationDto,
  InviteV4Dto,
  LabelDto,
  LocationDto,
  MembershipRequestDto,
  MessageDto,
  MessageInfoDto,
  OrderDto,
  OriginDto,
  PaymentDto,
  PollVoteDto,
  ProductDto,
  ReactionDto,
  ReactionListDto
} from '../types/dto.js'

// Pure functions from what whatsapp-web.js hands out to our DTOs. They take structural inputs
// (the `*Source` types below), never a wwebjs type, so they run in unit tests without the library
// and `wwebjs-adapter.ts` stays the only file that imports it. Each mapper copies the fields it
// names and nothing else: a wwebjs object is full of functions and back references, and it is never
// spread or serialized whole.

// ---- Helpers -----------------------------------------------------------------------------------

// wwebjs ids are objects with the string we want in `_serialized`; some fields are already strings
export interface WaSerializedId {
  _serialized: string
}

// WhatsApp Web dropped `_serialized` from message keys (the string is only in the key's toString,
// which does not survive the trip out of the page), so a key is rebuilt from its parts. Checked
// against every loaded message of a real account: the parts joined with `_` give the old string,
// with the participant of a group message and the `self` marker of a message to oneself at the end.
export interface WaMessageKey {
  _serialized?: string
  fromMe: boolean
  remote: string | WaSerializedId
  id: string
  participant?: string | WaSerializedId | null
  self?: string | null
}
export type IdLike = string | WaSerializedId | WaMessageKey

const NOT_AN_ID = 'Cannot serialize a WhatsApp id: it has no _serialized and is not a message key'

// A key part must resolve to a non-empty string, or the joined id would silently carry an empty part
const plainId = (id: unknown): string => {
  const value = typeof id === 'object' && id !== null && '_serialized' in id ? id._serialized : id
  if (typeof value !== 'string' || value === '') throw new TypeError(NOT_AN_ID)
  return value
}

const isMessageKey = (id: IdLike): id is WaMessageKey =>
  typeof id === 'object' &&
  'fromMe' in id &&
  typeof id.fromMe === 'boolean' &&
  'remote' in id &&
  'id' in id

export function serializeId(id: IdLike): string {
  if (typeof id === 'string') return id
  if ('_serialized' in id && typeof id._serialized === 'string') return id._serialized
  if (!isMessageKey(id)) throw new TypeError(NOT_AN_ID)
  const parts = [String(id.fromMe), plainId(id.remote), plainId(id.id)]
  if (id.participant) parts.push(plainId(id.participant))
  if (id.self) parts.push(id.self)
  return parts.join('_')
}

const optionalId = (id: IdLike | null | undefined): string | undefined =>
  id === null || id === undefined ? undefined : serializeId(id)

const toIso = (value: Date | number): string => new Date(value).toISOString()
const unixToIso = (seconds: number): string => toIso(seconds * 1000)

// Copies the listed keys, leaving out the ones that are undefined or null so that a field WhatsApp
// did not fill is absent from the DTO instead of failing its schema
function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const out: Partial<Pick<T, K>> = {}
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined && value !== null) out[key] = value
  }
  return out as Pick<T, K> // every key was copied from `source`, so the partial is complete
}

// A DTO whose id fields arrive as wwebjs ids
type WithIds<D, K extends keyof D> = Omit<D, K> & { [P in K]: IdLike }

// ---- raw and origin (TDD §6.6.1) ---------------------------------------------------------------

const RAW_MAX_DEPTH = 8
// Plain, URL-safe or line-broken (MIME) base64, with or without a `data:` URI prefix
const BASE64_BLOB = /^(?:data:[^,]*;base64,)?[A-Za-z0-9+/_\r\n-]+={0,2}$/

const omitted = (bytes: number): string => `[omitted:${bytes}]`

function sanitizeValue(
  value: unknown,
  maxFieldBytes: number,
  depth: number,
  ancestors: WeakSet<object>
): unknown {
  switch (typeof value) {
    case 'function':
    case 'symbol':
    case 'undefined':
      return undefined
    case 'bigint':
      return value.toString()
    case 'string': {
      const bytes = Buffer.byteLength(value)
      return bytes > maxFieldBytes && BASE64_BLOB.test(value) ? omitted(bytes) : value
    }
    case 'object':
      break
    default:
      return value
  }
  if (value === null) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (ArrayBuffer.isView(value)) return omitted(value.byteLength)
  if (value instanceof ArrayBuffer) return omitted(value.byteLength)
  if (ancestors.has(value)) return '[circular]'
  if (depth >= RAW_MAX_DEPTH) return '[omitted:depth]'

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((item: unknown) => {
        const clean = sanitizeValue(item, maxFieldBytes, depth + 1, ancestors)
        return clean === undefined ? null : clean
      })
    }
    // fromEntries defines the keys, so an own key named `__proto__` is kept as data
    const entries: [string, unknown][] = []
    for (const [key, item] of Object.entries(value)) {
      const clean = sanitizeValue(item, maxFieldBytes, depth + 1, ancestors)
      if (clean !== undefined) entries.push([key, clean])
    }
    return Object.fromEntries(entries)
  } finally {
    ancestors.delete(value)
  }
}

// The JSON-safe copy of `Message.rawData` that rides on a message as `raw`: cycle-safe and
// depth-limited, without functions, with binary data and base64 blobs over `maxFieldBytes`
// replaced by `"[omitted:<bytes>]"`
export function sanitizeRaw(
  rawData: unknown,
  maxFieldBytes: number
): Record<string, unknown> | undefined {
  // Dates and binary data are objects too, but they sanitize to a string
  const clean = sanitizeValue(rawData, maxFieldBytes, 0, new WeakSet())
  return isRecord(clean) ? clean : undefined
}

// Fields the DTOs keep as free-form JSON (`dynamicReplyButtons`, a call's `participants`) are typed
// `object` by wwebjs. They go through the same cycle-safe copy as `raw`, so that a back reference or a
// function in one never reaches a serializer.
const OPAQUE_MAX_FIELD_BYTES = 8192

type Json = NonNullable<MessageDto['dynamicReplyButtons']>

function toJson(value: object | null | undefined): Json | undefined {
  if (value === null || value === undefined) return undefined
  // sanitizeValue returns only JSON values: it drops functions and symbols and breaks cycles
  return sanitizeValue(value, OPAQUE_MAX_FIELD_BYTES, 0, new WeakSet()) as Json | undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function textField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

// An id may come as a number; one past 2^53 has already been rounded to another id, so it is dropped
function idField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? String(value)
    : textField(source, key)
}

// Best effort until step 12.3 confirms which key of a real ad message carries the id: a run of at
// least ten digits in a path segment of the ad link, which is where Meta puts the numeric post or
// ad id. The query string and wa.me links (they carry a timestamp or a phone number) are skipped.
const NUMERIC_AD_ID = /(?<!\d)\d{10,}(?!\d)/

function adIdFromUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    const url = new URL(value)
    return url.hostname === 'wa.me' ? undefined : NUMERIC_AD_ID.exec(url.pathname)?.[0]
  } catch {
    return undefined
  }
}

function sourceIdOf(context: Record<string, unknown>): string | undefined {
  return (
    idField(context, 'sourceId') ??
    adIdFromUrl(textField(context, 'sourceUrl')) ??
    adIdFromUrl(textField(context, 'mediaUrl'))
  )
}

const ORIGIN_TEXT_FIELDS = [
  'conversionSource',
  'sourceUrl',
  'title',
  'description',
  'thumbnailUrl',
  'mediaUrl'
] as const

// Present only when the message carries `ctwaContext`, which WhatsApp attaches to the message that
// starts a conversation from a Click-to-WhatsApp ad. Every field is optional because WhatsApp may
// leave any of them out.
export function extractOrigin(rawData: unknown): OriginDto | undefined {
  if (!isRecord(rawData)) return undefined
  const context = rawData['ctwaContext']
  if (!isRecord(context)) return undefined

  const origin: OriginDto = { kind: 'click_to_whatsapp_ad' }
  for (const field of ORIGIN_TEXT_FIELDS) {
    const value = textField(context, field)
    if (value !== undefined) origin[field] = value
  }
  const sourceId = sourceIdOf(context)
  if (sourceId !== undefined) origin.sourceId = sourceId
  const ctwaClid = idField(context, 'ctwaClid') ?? idField(rawData, 'ctwaClid')
  if (ctwaClid !== undefined) origin.ctwaClid = ctwaClid
  return origin
}

// ---- Message -----------------------------------------------------------------------------------

type MessageGatewayFields =
  | 'id'
  | 'chatId'
  | 'sentAt'
  | 'receivedAt'
  | 'ordering'
  | 'origin'
  | 'media'
  | 'raw'
  | 'location'
  | 'inviteV4'
  | 'latestEditMsgKey'
  | 'protocolMessageKey'
  | 'isEventCanceled'
  | 'mentionedIds'
  | 'groupMentions'
  | 'businessOwnerJid'
  | 'pollOptions'
  | 'dynamicReplyButtons'

export interface MessageSource extends Omit<MessageDto, MessageGatewayFields | 'ack'> {
  id: IdLike
  // Some incoming messages come without one
  ack?: number | null
  // The typings of wwebjs say string, but Message.js copies what WhatsApp Web holds, which can be wids
  mentionedIds: IdLike[]
  groupMentions: { groupSubject: string; groupJid: IdLike }[]
  businessOwnerJid?: IdLike | null
  // Typed string[], but Message.js copies the `{ name, localId }` options WhatsApp Web holds
  pollOptions?: (string | { name: string })[] | null
  dynamicReplyButtons?: object | null
  location?: LocationDto | null
  inviteV4?: InviteV4Dto | null
  latestEditMsgKey?: IdLike | null
  protocolMessageKey?: IdLike | null
  // wwebjs spells it this way
  isEventCaneled?: boolean | null
  rawData?: unknown
}

export interface MessageMapOptions {
  receivedAt: Date
  includeRaw: boolean
  rawMaxFieldBytes: number
}

const MESSAGE_FIELDS = [
  'ack',
  'author',
  'deviceType',
  'body',
  'broadcast',
  'isStatus',
  'isGif',
  'isEphemeral',
  'from',
  'fromMe',
  'hasMedia',
  'hasQuotedMsg',
  'hasReaction',
  'duration',
  'isForwarded',
  'forwardingScore',
  'isStarred',
  'vCards',
  'mediaKey',
  'timestamp',
  'to',
  'type',
  'links',
  'orderId',
  'title',
  'description',
  'productId',
  'latestEditSenderTimestampMs',
  'selectedButtonId',
  'selectedRowId',
  'pollName',
  'allowMultipleAnswers',
  'eventStartTime',
  'eventEndTime',
  'eventDescription',
  'eventLocation',
  'eventJoinLink',
  'messageSecret'
] as const satisfies readonly (keyof MessageSource)[]

const LOCATION_FIELDS = [
  'latitude',
  'longitude',
  'name',
  'address',
  'url',
  'description'
] as const satisfies readonly (keyof LocationDto)[]

const INVITE_V4_FIELDS = [
  'inviteCode',
  'inviteCodeExp',
  'groupId',
  'groupName',
  'fromId',
  'toId'
] as const satisfies readonly (keyof InviteV4Dto)[]

export function mapMessage(source: MessageSource, options: MessageMapOptions): MessageDto {
  const message: MessageDto = {
    ...(pick(source, MESSAGE_FIELDS) as MessageDto), // required fields are filled by wwebjs
    id: serializeId(source.id),
    ack: source.ack ?? null,
    // For a group chat `from` is the group, `author` the sender
    chatId: source.fromMe ? source.to : source.from,
    sentAt: unixToIso(source.timestamp),
    receivedAt: toIso(options.receivedAt),
    mentionedIds: source.mentionedIds.map(serializeId),
    groupMentions: source.groupMentions.map(({ groupSubject, groupJid }) => ({
      groupSubject,
      groupJid: serializeId(groupJid)
    }))
  }
  const businessOwnerJid = optionalId(source.businessOwnerJid)
  if (businessOwnerJid !== undefined) message.businessOwnerJid = businessOwnerJid
  const dynamicReplyButtons = toJson(source.dynamicReplyButtons)
  if (dynamicReplyButtons !== undefined) message.dynamicReplyButtons = dynamicReplyButtons
  if (source.pollOptions) {
    message.pollOptions = source.pollOptions.map(option =>
      typeof option === 'string' ? option : option.name
    )
  }
  if (source.location) message.location = pick(source.location, LOCATION_FIELDS)
  if (source.inviteV4) message.inviteV4 = pick(source.inviteV4, INVITE_V4_FIELDS)
  const latestEditMsgKey = optionalId(source.latestEditMsgKey)
  if (latestEditMsgKey !== undefined) message.latestEditMsgKey = latestEditMsgKey
  const protocolMessageKey = optionalId(source.protocolMessageKey)
  if (protocolMessageKey !== undefined) message.protocolMessageKey = protocolMessageKey
  if (typeof source.isEventCaneled === 'boolean') message.isEventCanceled = source.isEventCaneled

  const origin = extractOrigin(source.rawData)
  if (origin) message.origin = origin
  if (options.includeRaw) {
    const raw = sanitizeRaw(source.rawData, options.rawMaxFieldBytes)
    if (raw) message.raw = raw
  }
  return message
}

export interface MessageInfoSource {
  delivery: { id: IdLike; t: number }[]
  deliveryRemaining: number
  played: { id: IdLike; t: number }[]
  playedRemaining: number
  read: { id: IdLike; t: number }[]
  readRemaining: number
}

const receipts = (list: { id: IdLike; t: number }[]): MessageInfoDto['delivery'] =>
  list.map(entry => ({ id: serializeId(entry.id), t: entry.t }))

export function mapMessageInfo(source: MessageInfoSource): MessageInfoDto {
  return {
    delivery: receipts(source.delivery),
    deliveryRemaining: source.deliveryRemaining,
    played: receipts(source.played),
    playedRemaining: source.playedRemaining,
    read: receipts(source.read),
    readRemaining: source.readRemaining
  }
}

export type ReactionSource = WithIds<ReactionDto, 'id' | 'msgId'>

const REACTION_FIELDS = [
  'orphan',
  'orphanReason',
  'timestamp',
  'reaction',
  'read',
  'senderId',
  'ack'
] as const satisfies readonly (keyof ReactionSource)[]

export function mapReaction(source: ReactionSource): ReactionDto {
  return {
    ...(pick(source, REACTION_FIELDS) as ReactionDto),
    id: serializeId(source.id),
    msgId: serializeId(source.msgId)
  }
}

export interface ReactionListSource extends Omit<ReactionListDto, 'senders'> {
  senders: ReactionSource[]
}

export function mapReactionList(source: ReactionListSource): ReactionListDto {
  return {
    id: source.id,
    aggregateEmoji: source.aggregateEmoji,
    hasReactionByMe: source.hasReactionByMe,
    senders: source.senders.map(mapReaction)
  }
}

// wwebjs hands the poll message itself as `parentMessage`; we keep its id. The typings of 1.34.7 say
// `voter` is a string and an option is `{ id, name }`, but PollVote.js assigns the sender's wid and
// `{ name, localId }`, with `name` undefined when the poll message could not be found.
export interface PollVoteSource extends Omit<
  PollVoteDto,
  'voter' | 'selectedOptions' | 'parentMessageId' | 'interactedAtTs'
> {
  voter: IdLike
  selectedOptions: { id?: number; localId?: number; name?: string }[]
  // `id` is undefined when WhatsApp Web no longer had the poll message
  parentMessage: { id?: IdLike }
  parentMsgKey?: IdLike | null
  // wwebjs spells it this way
  interractedAtTs: number
}

export function mapPollVote(source: PollVoteSource): PollVoteDto {
  const parentId = source.parentMessage.id ?? source.parentMsgKey
  if (parentId === undefined || parentId === null) {
    throw new Error('A poll vote names no poll message')
  }
  return {
    voter: serializeId(source.voter),
    selectedOptions: source.selectedOptions.map(option => ({
      id: option.localId ?? option.id ?? 0,
      name: option.name ?? ''
    })),
    interactedAtTs: source.interractedAtTs,
    parentMessageId: serializeId(parentId)
  }
}

// ---- Contact -----------------------------------------------------------------------------------

export type ContactSource = WithIds<ContactDto, 'id'>

const CONTACT_FIELDS = [
  'number',
  'isBusiness',
  'isEnterprise',
  'isGroup',
  'isMe',
  'isMyContact',
  'isUser',
  'isWAContact',
  'isBlocked',
  'labels',
  'name',
  'pushname',
  'sectionHeader',
  'shortName',
  'statusMute',
  'type',
  'verifiedLevel',
  'verifiedName'
] as const satisfies readonly (keyof ContactSource)[]

export function mapContact(source: ContactSource): ContactDto {
  return { ...(pick(source, CONTACT_FIELDS) as ContactDto), id: serializeId(source.id) }
}

export interface BusinessContactSource extends ContactSource {
  businessProfile: WithIds<BusinessContactDto['businessProfile'], 'id'>
}

const BUSINESS_PROFILE_FIELDS = [
  'tag',
  'description',
  'categories',
  'profileOptions',
  'email',
  'website',
  'latitude',
  'longitude',
  'businessHours',
  'address',
  'fbPage',
  'ifProfileLinked',
  'coverPhoto'
] as const satisfies readonly (keyof BusinessContactSource['businessProfile'])[]

export function mapBusinessContact(source: BusinessContactSource): BusinessContactDto {
  return {
    ...mapContact(source),
    businessProfile: {
      ...(pick(
        source.businessProfile,
        BUSINESS_PROFILE_FIELDS
      ) as BusinessContactDto['businessProfile']),
      id: serializeId(source.businessProfile.id)
    }
  }
}

// ---- Chats, groups, channels -------------------------------------------------------------------

export interface ChatSource extends Omit<ChatDto, 'id' | 'lastMessage'> {
  id: IdLike
  lastMessage?: MessageSource | null
}

const CHAT_FIELDS = [
  'archived',
  'isGroup',
  'isReadOnly',
  'isMuted',
  'muteExpiration',
  'name',
  'timestamp',
  'unreadCount',
  'pinned',
  'isLocked'
] as const satisfies readonly (keyof ChatSource)[]

export function mapChat(source: ChatSource, options: MessageMapOptions): ChatDto {
  const chat: ChatDto = { ...(pick(source, CHAT_FIELDS) as ChatDto), id: serializeId(source.id) }
  if (source.lastMessage) chat.lastMessage = mapMessage(source.lastMessage, options)
  return chat
}

export interface GroupChatSource extends Omit<ChatSource, never> {
  owner: IdLike
  createdAt: Date | number
  description: string
  participants: WithIds<GroupChatDto['participants'][number], 'id'>[]
}

export function mapGroupChat(source: GroupChatSource, options: MessageMapOptions): GroupChatDto {
  return {
    ...mapChat(source, options),
    owner: serializeId(source.owner),
    createdAt: toIso(source.createdAt),
    description: source.description,
    participants: source.participants.map(participant => ({
      id: serializeId(participant.id),
      isAdmin: participant.isAdmin,
      isSuperAdmin: participant.isSuperAdmin
    }))
  }
}

export interface ChannelSource extends Omit<ChannelDto, 'id' | 'lastMessage'> {
  id: IdLike
  lastMessage?: MessageSource | null
}

const CHANNEL_FIELDS = [
  'name',
  'description',
  'isChannel',
  'isGroup',
  'isReadOnly',
  'unreadCount',
  'timestamp',
  'isMuted',
  'muteExpiration'
] as const satisfies readonly (keyof ChannelSource)[]

export function mapChannel(source: ChannelSource, options: MessageMapOptions): ChannelDto {
  const channel: ChannelDto = {
    ...(pick(source, CHANNEL_FIELDS) as ChannelDto),
    id: serializeId(source.id)
  }
  if (source.lastMessage) channel.lastMessage = mapMessage(source.lastMessage, options)
  return channel
}

export type MembershipRequestSource = Omit<
  MembershipRequestDto,
  'id' | 'addedBy' | 'parentGroupId'
> & {
  id: IdLike
  addedBy: IdLike
  parentGroupId?: IdLike | null
}

export function mapMembershipRequest(source: MembershipRequestSource): MembershipRequestDto {
  const request: MembershipRequestDto = {
    id: serializeId(source.id),
    addedBy: serializeId(source.addedBy),
    requestMethod: source.requestMethod,
    t: source.t
  }
  const parentGroupId = optionalId(source.parentGroupId)
  if (parentGroupId !== undefined) request.parentGroupId = parentGroupId
  return request
}

export type GroupNotificationSource = Omit<WithIds<GroupNotificationDto, 'id'>, 'recipientIds'> & {
  recipientIds: IdLike[]
}

export function mapGroupNotification(source: GroupNotificationSource): GroupNotificationDto {
  return {
    id: serializeId(source.id),
    author: source.author,
    body: source.body,
    chatId: source.chatId,
    recipientIds: source.recipientIds.map(serializeId),
    timestamp: source.timestamp,
    type: source.type
  }
}

// ---- Labels, broadcasts, calls -----------------------------------------------------------------

export function mapLabel(source: LabelDto): LabelDto {
  return { id: source.id, name: source.name, hexColor: source.hexColor }
}

export interface BroadcastSource extends Omit<BroadcastDto, 'id' | 'msgs'> {
  id: IdLike
  msgs: MessageSource[]
}

export function mapBroadcast(source: BroadcastSource, options: MessageMapOptions): BroadcastDto {
  return {
    id: serializeId(source.id),
    timestamp: source.timestamp,
    totalCount: source.totalCount,
    unreadCount: source.unreadCount,
    msgs: source.msgs.map(message => mapMessage(message, options))
  }
}

// `from` is `data.peerJid` in Call.js, the wid WhatsApp Web holds, though the typings say string
export type CallSource = Omit<CallDto, 'from' | 'participants'> & {
  from?: IdLike | null
  participants?: object | null
}

const CALL_FIELDS = [
  'id',
  'timestamp',
  'isVideo',
  'isGroup',
  'fromMe',
  'canHandleLocally',
  'webClientShouldHandle'
] as const satisfies readonly (keyof CallSource)[]

export function mapCall(source: CallSource): CallDto {
  const call: CallDto = pick(source, CALL_FIELDS)
  const from = optionalId(source.from)
  if (from !== undefined) call.from = from
  const participants = toJson(source.participants)
  if (participants !== undefined) call.participants = participants
  return call
}

// ---- Commerce ----------------------------------------------------------------------------------

const PRODUCT_FIELDS = [
  'id',
  'price',
  'thumbnailUrl',
  'currency',
  'name',
  'quantity'
] as const satisfies readonly (keyof ProductDto)[]

export function mapProduct(source: ProductDto): ProductDto {
  return pick(source, PRODUCT_FIELDS)
}

export interface OrderSource extends Omit<OrderDto, 'products'> {
  products: ProductDto[]
}

export function mapOrder(source: OrderSource): OrderDto {
  return {
    products: source.products.map(mapProduct),
    subtotal: source.subtotal,
    total: source.total,
    currency: source.currency,
    createdAt: source.createdAt
  }
}

export type PaymentSource = WithIds<PaymentDto, 'id' | 'paymentMessageReceiverJid'>

const PAYMENT_FIELDS = [
  'paymentCurrency',
  'paymentAmount1000',
  'paymentTransactionTimestamp',
  'paymentStatus',
  'paymentTxnStatus',
  'paymentNote'
] as const satisfies readonly (keyof PaymentSource)[]

export function mapPayment(source: PaymentSource): PaymentDto {
  return {
    ...(pick(source, PAYMENT_FIELDS) as PaymentDto),
    id: serializeId(source.id),
    paymentMessageReceiverJid: serializeId(source.paymentMessageReceiverJid)
  }
}

// ---- Client ------------------------------------------------------------------------------------

export function mapBatteryInfo(source: BatteryInfoDto): BatteryInfoDto {
  return { battery: source.battery, plugged: source.plugged }
}

export type ClientInfoSource = Omit<WithIds<ClientInfoDto, 'wid' | 'me'>, 'phone'> & {
  phone?: ClientInfoDto['phone'] | null
}

const PHONE_FIELDS = [
  'wa_version',
  'os_version',
  'device_manufacturer',
  'device_model',
  'os_build_number'
] as const satisfies readonly (keyof NonNullable<ClientInfoDto['phone']>)[]

export function mapClientInfo(source: ClientInfoSource): ClientInfoDto {
  const info: ClientInfoDto = {
    wid: serializeId(source.wid),
    me: serializeId(source.me),
    platform: source.platform,
    pushname: source.pushname
  }
  if (source.phone) info.phone = pick(source.phone, PHONE_FIELDS)
  return info
}
