import type { z } from 'zod'

import { stripNul } from '../common/lib/nul.js'
import { MessageDto as MessageSchema } from '../types/dto.js'
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
  MessageMediaDto,
  OrderDto,
  OriginDto,
  PaymentDto,
  PollVoteDto,
  ProductDto,
  ReactionDto,
  ReactionListDto
} from '../types/dto.js'

import type { CustomerNote } from './whatsapp-client.port.js'

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

// A whole number of seconds (the DTOs are `.int()`: a fraction would fail the response of a message that is otherwise fine).
// The ISO string must stay a 4-digit year (RFC 3339, the DTO schema and Postgres): 0 to 9999-12-31
const MAX_UNIX_SECONDS = 253_402_300_799
const isUsableUnixTime = (seconds: number): boolean =>
  Number.isInteger(seconds) && seconds >= 0 && seconds <= MAX_UNIX_SECONDS

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

type FieldKind = 'string' | 'text' | 'boolean' | 'number' | 'unixSeconds' | 'numbers' | 'any'

const KIND_CHECKS: Record<FieldKind, (value: unknown) => boolean> = {
  string: value => typeof value === 'string',
  text: value => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)),
  boolean: value => typeof value === 'boolean',
  number: value => typeof value === 'number' && Number.isFinite(value),
  unixSeconds: value => typeof value === 'number' && isUsableUnixTime(value),
  numbers: value =>
    Array.isArray(value) && value.every(item => typeof item === 'number' && Number.isFinite(item)),
  any: () => true
}

// Like `pick`, but a value of another type than the DTO declares is left out too, and its name is
// reported (never its value): WhatsApp Web changes shapes without notice and one drifted field must not
// turn the response of a message that is otherwise fine into a 500
function pickTyped<T extends object>(
  source: T,
  kinds: Readonly<Partial<Record<keyof T & string, FieldKind>>>,
  onDropped?: (field: string) => void
): Partial<T> {
  const out: Partial<T> = {}
  for (const [key, kind] of Object.entries(kinds) as [keyof T & string, FieldKind][]) {
    const value = source[key]
    if (value === undefined || value === null) continue
    // A number where text is expected (an audio duration) is kept as its text
    if (KIND_CHECKS[kind](value))
      out[key] = (kind === 'text' ? String(value) : value) as T[typeof key]
    else onDropped?.(key)
  }
  return out
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

// The typings of wwebjs say the coordinates are strings, but WhatsApp Web hands numbers
export interface LocationSource extends Omit<LocationDto, 'latitude' | 'longitude'> {
  latitude: number | string
  longitude: number | string
}

export interface MessageSource extends Omit<
  MessageDto,
  | MessageGatewayFields
  | 'ack'
  | 'broadcast'
  | 'isEphemeral'
  | 'isForwarded'
  | 'timestamp'
  | 'location'
  | 'isStarred'
  | 'links'
  | 'vCards'
  | 'isStatus'
  | 'isGif'
  | 'forwardingScore'
  | 'deviceType'
  | 'body'
  | 'from'
  | 'to'
  | 'type'
  | 'fromMe'
  | 'hasMedia'
  | 'hasQuotedMsg'
  | 'hasReaction'
  | 'mentionedIds'
  | 'groupMentions'
> {
  id: IdLike
  // Message.js copies these without a default, so a real account can lack any of them (see `mapMessageFields`)
  deviceType?: string | null
  body?: string | null
  from?: string | null
  to?: string | null
  type?: string | null
  fromMe?: boolean | null
  hasMedia?: boolean | null
  hasQuotedMsg?: boolean | null
  hasReaction?: boolean | null
  location?: LocationSource | null
  // Message.js copies these as they come (`this.isStarred = data.star`, `this.links = data.links`)
  // and a message of a special type can lack them: absent is false, empty or 0
  isStarred?: boolean | null
  links?: MessageDto['links'] | null
  vCards?: string[] | null
  isStatus?: boolean | null
  isGif?: boolean | null
  forwardingScore?: number | null
  // WhatsApp leaves these out of some messages
  broadcast?: boolean | null
  isEphemeral?: boolean | null
  isForwarded?: boolean | null
  timestamp?: number | null
  // Some incoming messages come without one
  ack?: number | null
  // The typings of wwebjs say string, but Message.js copies what WhatsApp Web holds, which can be wids
  mentionedIds?: IdLike[] | null
  groupMentions?: ({ groupSubject: string; groupJid: IdLike } | null)[] | null
  businessOwnerJid?: IdLike | null
  // Typed string[], but Message.js copies the `{ name, localId }` options WhatsApp Web holds
  pollOptions?: (string | { name: string })[] | null
  dynamicReplyButtons?: object | null
  // WhatsApp Web hands every key as a string, `inviteCodeExp` included (typed number)
  inviteV4?: Partial<Record<keyof InviteV4Dto, unknown>> | null
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
  // Where a message's media can be downloaded from the gateway. Without it a message gets no
  // `media` block: the mapper does not guess a URL.
  mediaUrl?: (messageId: string) => string
  // Called when a message carries a timestamp that is not a date (NaN, Infinity, out of range): it
  // is kept, dated by its arrival, instead of being lost
  onInvalidTimestamp?: () => void
  // Called with the names of the fields (never the values) when the last message of a chat does not
  // fit its schema: it is left out of the chat instead of turning the whole listing into a 500
  onUnreadableMessage?: (fields: string) => void
  // Called with the NAME of an optional field WhatsApp filled with another type (never the value):
  // the field is left out of the message instead of failing its schema
  onDroppedField?: (field: string) => void
  // The chat a sent message went to, which the caller knows: used when the answer names none
  fallbackChatId?: string
}

// The optional fields copied as they come, and the type each must have to be copied
const MESSAGE_OPTIONAL_KINDS = {
  author: 'string',
  duration: 'text',
  mediaKey: 'string',
  orderId: 'string',
  title: 'string',
  description: 'string',
  productId: 'string',
  latestEditSenderTimestampMs: 'number',
  selectedButtonId: 'string',
  selectedRowId: 'string',
  pollName: 'string',
  allowMultipleAnswers: 'boolean',
  eventStartTime: 'unixSeconds',
  eventEndTime: 'unixSeconds',
  eventDescription: 'string',
  eventLocation: 'any',
  eventJoinLink: 'string',
  messageSecret: 'numbers'
} as const satisfies Partial<Record<keyof MessageSource, FieldKind>>

const textOr = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback
const flag = (value: unknown): boolean => value === true

const LOCATION_FIELDS = [
  'latitude',
  'longitude',
  'name',
  'address',
  'url',
  'description'
] as const satisfies readonly (keyof LocationDto)[]

// A number, or a string that is one: null, '' and blank strings are not 0
function coordinate(value: unknown): number | undefined {
  if (typeof value === 'string' && value.trim() === '') return undefined
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

// A location without usable coordinates is left out; the message itself is kept
function mapLocation(source: LocationSource | null | undefined): LocationDto | undefined {
  if (!source) return undefined
  const latitude = coordinate(source.latitude)
  const longitude = coordinate(source.longitude)
  if (latitude === undefined || longitude === undefined) return undefined
  return { ...pick(source, LOCATION_FIELDS), latitude, longitude }
}

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

// A whole number of seconds, from a number or from the string WhatsApp Web really delivers
function wholeSeconds(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value : undefined
  if (typeof value === 'string' && /^\d{1,15}$/.test(value)) return Number(value)
  return undefined
}

// An invite that lacks a field (or whose expiration is not a number) cannot be accepted, so it is
// left out; the message itself is kept
function mapInvite(source: MessageSource['inviteV4']): InviteV4Dto | undefined {
  if (!source) return undefined
  const inviteCode = text(source.inviteCode)
  const inviteCodeExp = wholeSeconds(source.inviteCodeExp)
  const groupId = text(source.groupId)
  const fromId = text(source.fromId)
  const toId = text(source.toId)
  if (
    inviteCode === undefined ||
    inviteCodeExp === undefined ||
    groupId === undefined ||
    fromId === undefined ||
    toId === undefined
  ) {
    return undefined
  }
  const groupName = text(source.groupName)
  return {
    inviteCode,
    inviteCodeExp,
    groupId,
    fromId,
    toId,
    ...(groupName !== undefined && { groupName })
  }
}

// The route of `messages.media` on the public address of the gateway, which may sit under a path
// prefix behind a reverse proxy
export function mediaDownloadUrl(baseUrl: string, sessionId: string, messageId: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  return `${base}/v1/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/media`
}

// What WhatsApp Web holds of the file of a message (TDD §5.5): its type, name and size, read from
// the raw data without downloading anything. The type is required by the DTO, so a message whose
// raw data does not name one gets no block (its `hasMedia` still says there is a file).
function extractMedia(
  source: MessageSource,
  messageId: string,
  mediaUrl: MessageMapOptions['mediaUrl']
): MessageMediaDto | undefined {
  if (!source.hasMedia || mediaUrl === undefined || !isRecord(source.rawData)) return undefined
  const mimetype = textField(source.rawData, 'mimetype')
  if (mimetype === undefined) return undefined
  const filename = textField(source.rawData, 'filename')
  const size = source.rawData['size']
  return {
    mimetype,
    ...(filename !== undefined && { filename }),
    ...(typeof size === 'number' && Number.isInteger(size) && size >= 0 && { size }),
    downloadUrl: mediaUrl(messageId)
  }
}

function usableTimestamp(
  value: number | null | undefined,
  options: MessageMapOptions
): number | null {
  if (value === undefined || value === null) return null
  // A fraction is floored: the order buffer sorts by this second, and a message must keep its place
  const whole = Number.isFinite(value) ? Math.floor(value) : value
  if (isUsableUnixTime(whole)) return whole
  options.onInvalidTimestamp?.()
  return null
}

// Postgres cannot store U+0000, and what is stored must be what is published, so the DTO leaves the
// mapper without any: the single place every message (live, reconciled, fetched) is built.
export function mapMessage(source: MessageSource, options: MessageMapOptions): MessageDto {
  return stripNul(mapMessageFields(source, options))
}

function mapMessageFields(source: MessageSource, options: MessageMapOptions): MessageDto {
  const timestamp = usableTimestamp(source.timestamp, options)
  // A message is placed by its chat: without one there is no safe default (it would be stored and
  // published under the wrong conversation), so it is refused and the caller leaves it out
  const named = source.fromMe === true ? source.to : source.from
  const chatId = typeof named === 'string' && named !== '' ? named : options.fallbackChatId
  if (chatId === undefined || chatId === '') {
    throw new Error('A message names no chat (from or to is missing)')
  }
  const message: MessageDto = {
    ...(pickTyped(source, MESSAGE_OPTIONAL_KINDS, options.onDroppedField) as Partial<MessageDto>),
    // The type and the device are labels: a missing one is 'unknown' and the body is empty
    deviceType: textOr(source.deviceType, 'unknown'),
    body: textOr(source.body, ''),
    type: textOr(source.type, 'unknown'),
    // The other side of the conversation stays empty when only it is missing
    from: textOr(source.from, ''),
    to: textOr(source.to, ''),
    fromMe: flag(source.fromMe),
    hasMedia: flag(source.hasMedia),
    hasQuotedMsg: flag(source.hasQuotedMsg),
    hasReaction: flag(source.hasReaction),
    id: serializeId(source.id),
    ack: source.ack ?? null,
    isStarred: source.isStarred ?? false,
    links: source.links ?? [],
    vCards: (Array.isArray(source.vCards) ? source.vCards : []).filter(
      (card): card is string => typeof card === 'string'
    ),
    isStatus: source.isStatus ?? false,
    isGif: source.isGif ?? false,
    forwardingScore: source.forwardingScore ?? 0,
    broadcast: source.broadcast ?? false,
    isEphemeral: source.isEphemeral ?? false,
    isForwarded: source.isForwarded ?? false,
    timestamp,
    // For a group chat `from` is the group, `author` the sender
    chatId,
    // A message without a usable timestamp is dated by its arrival so that it still has a place in the order
    sentAt: timestamp === null ? toIso(options.receivedAt) : unixToIso(timestamp),
    receivedAt: toIso(options.receivedAt),
    mentionedIds: (Array.isArray(source.mentionedIds) ? source.mentionedIds : []).map(serializeId),
    groupMentions: (Array.isArray(source.groupMentions) ? source.groupMentions : []).flatMap(
      mention =>
        mention && typeof mention.groupSubject === 'string' && mention.groupJid
          ? [{ groupSubject: mention.groupSubject, groupJid: serializeId(mention.groupJid) }]
          : []
    )
  }
  const businessOwnerJid = optionalId(source.businessOwnerJid)
  if (businessOwnerJid !== undefined) message.businessOwnerJid = businessOwnerJid
  const dynamicReplyButtons = toJson(source.dynamicReplyButtons)
  if (dynamicReplyButtons !== undefined) message.dynamicReplyButtons = dynamicReplyButtons
  if (Array.isArray(source.pollOptions)) {
    message.pollOptions = source.pollOptions.flatMap(option => {
      const name = typeof option === 'string' ? option : option?.name
      return typeof name === 'string' ? [name] : []
    })
  }
  const location = mapLocation(source.location)
  if (location) message.location = location
  const inviteV4 = mapInvite(source.inviteV4)
  if (inviteV4) message.inviteV4 = inviteV4
  const latestEditMsgKey = optionalId(source.latestEditMsgKey)
  if (latestEditMsgKey !== undefined) message.latestEditMsgKey = latestEditMsgKey
  const protocolMessageKey = optionalId(source.protocolMessageKey)
  if (protocolMessageKey !== undefined) message.protocolMessageKey = protocolMessageKey
  if (typeof source.isEventCaneled === 'boolean') message.isEventCanceled = source.isEventCaneled

  const origin = extractOrigin(source.rawData)
  if (origin) message.origin = origin
  const media = extractMedia(source, message.id, options.mediaUrl)
  if (media) message.media = media
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

// wwebjs hands the poll message itself as `parentMessage`; we keep its id. The typings of 1.34.8 say
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

// WhatsApp Web's contact model does not always carry the flags (`isEnterprise` and `statusMute` are
// copied from it as they come), and a missing flag means the contact is not that: false
type ContactFlag =
  | 'isBusiness'
  | 'isEnterprise'
  | 'isGroup'
  | 'isMe'
  | 'isMyContact'
  | 'isUser'
  | 'isWAContact'
  | 'isBlocked'
  | 'statusMute'

// `verifiedLevel` is a number at runtime (the typings say string) and `number` can be null
export type ContactSource = Omit<
  WithIds<ContactDto, 'id'>,
  ContactFlag | 'verifiedLevel' | 'number'
> &
  Partial<Pick<ContactDto, ContactFlag>> & {
    verifiedLevel?: string | number | null
    number?: string | null
  }

const CONTACT_FIELDS = [
  'number',
  'labels',
  'name',
  'pushname',
  'sectionHeader',
  'shortName',
  'type',
  'verifiedName'
] as const satisfies readonly (keyof ContactSource)[]

export function mapContact(source: ContactSource): ContactDto {
  return {
    ...(pick(source, CONTACT_FIELDS) as ContactDto),
    id: serializeId(source.id),
    ...(source.verifiedLevel !== undefined &&
      source.verifiedLevel !== null && { verifiedLevel: String(source.verifiedLevel) }),
    isBusiness: source.isBusiness ?? false,
    isEnterprise: source.isEnterprise ?? false,
    isGroup: source.isGroup ?? false,
    isMe: source.isMe ?? false,
    isMyContact: source.isMyContact ?? false,
    isUser: source.isUser ?? false,
    isWAContact: source.isWAContact ?? false,
    isBlocked: source.isBlocked ?? false,
    statusMute: source.statusMute ?? false
  }
}

// The runtime key is `isProfileLinked`; the typings (and our DTO) spell it `ifProfileLinked`
export interface BusinessContactSource extends ContactSource {
  businessProfile: Omit<
    WithIds<BusinessContactDto['businessProfile'], 'id'>,
    'ifProfileLinked' | 'categories'
  > & {
    isProfileLinked?: boolean | null
    ifProfileLinked?: boolean | null
    categories?: BusinessContactDto['businessProfile']['categories'] | null
  }
}

const BUSINESS_PROFILE_FIELDS = [
  'tag',
  'description',
  'profileOptions',
  'email',
  'website',
  'latitude',
  'longitude',
  'businessHours',
  'address',
  'fbPage',
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
      id: serializeId(source.businessProfile.id),
      categories: source.businessProfile.categories ?? [],
      ifProfileLinked:
        source.businessProfile.isProfileLinked ?? source.businessProfile.ifProfileLinked ?? false
    }
  }
}

// ---- Chats, groups, channels -------------------------------------------------------------------

export interface ChatSource extends Omit<
  ChatDto,
  | 'id'
  | 'lastMessage'
  | 'archived'
  | 'isReadOnly'
  | 'isLocked'
  | 'timestamp'
  | 'isGroup'
  | 'isMuted'
  | 'unreadCount'
  | 'pinned'
> {
  id: IdLike
  // WhatsApp leaves these out of some chats; a missing flag is false and a missing count is 0
  isGroup?: boolean | null
  isMuted?: boolean | null
  unreadCount?: number | null
  pinned?: boolean | null
  archived?: boolean | null
  isReadOnly?: boolean | null
  isLocked?: boolean | null
  timestamp?: number | null
  lastMessage?: MessageSource | null
}

const usableChatTime = (value: number | null | undefined): number | null =>
  value !== undefined && value !== null && isUsableUnixTime(Math.floor(value))
    ? Math.floor(value)
    : null

const CHAT_FIELDS = ['name'] as const satisfies readonly (keyof ChatSource)[]

// The last message of a chat is shown only when it fits its schema: one odd message must not
// turn a listing of every chat into a 500 (ADR 0006). The message stays in `messages` and the events.
// The fields (never the values) a schema rejected, looking inside a union too, where the issue holds the
// issues of every branch
export function failedFields(error: z.ZodError): string[] {
  const names = new Set<string>()
  const visit = (issues: readonly z.core.$ZodIssue[]): void => {
    for (const issue of issues) {
      if (issue.code === 'invalid_union') for (const branch of issue.errors) visit(branch)
      else names.add(issue.path.join('.') || '(root)')
    }
  }
  visit(error.issues)
  return [...names]
}

function mapTolerantMessage(
  source: MessageSource,
  options: MessageMapOptions
): MessageDto | undefined {
  try {
    const message = mapMessage(source, options)
    const parsed = MessageSchema.safeParse(message)
    if (parsed.success) return message
    options.onUnreadableMessage?.(failedFields(parsed.error).join(', '))
  } catch (error: unknown) {
    options.onUnreadableMessage?.(
      `(mapping failed: ${error instanceof Error ? error.name : typeof error})`
    )
  }
  return undefined
}

export function mapChat(source: ChatSource, options: MessageMapOptions): ChatDto {
  const chat: ChatDto = {
    ...(pick(source, CHAT_FIELDS) as ChatDto),
    id: serializeId(source.id),
    // a group chat id is on the g.us server, so a missing flag is still known
    isGroup: source.isGroup ?? serializeId(source.id).endsWith('@g.us'),
    isMuted: source.isMuted ?? false,
    unreadCount: source.unreadCount ?? 0,
    pinned: source.pinned ?? false,
    archived: source.archived ?? false,
    isReadOnly: source.isReadOnly ?? false,
    isLocked: source.isLocked ?? false,
    timestamp: usableChatTime(source.timestamp)
  }
  if (
    source.muteExpiration !== undefined &&
    source.muteExpiration !== null &&
    isUsableUnixTime(source.muteExpiration)
  ) {
    chat.muteExpiration = source.muteExpiration
  }
  const lastMessage = source.lastMessage
    ? mapTolerantMessage(source.lastMessage, options)
    : undefined
  if (lastMessage) chat.lastMessage = lastMessage
  return chat
}

export interface GroupChatSource extends Omit<ChatSource, never> {
  owner?: IdLike | null
  createdAt?: Date | number | null
  description?: string | null
  participants?: (Omit<GroupChatDto['participants'][number], 'id' | 'isAdmin' | 'isSuperAdmin'> & {
    id: IdLike
    isAdmin?: boolean | null
    isSuperAdmin?: boolean | null
  })[]
}

function creationOf(value: Date | number | null | undefined): { createdAt?: string } {
  if (value === undefined || value === null) return {}
  const time = new Date(value)
  return Number.isNaN(time.getTime()) ? {} : { createdAt: time.toISOString() }
}

export function mapGroupChat(source: GroupChatSource, options: MessageMapOptions): GroupChatDto {
  return {
    ...mapChat(source, options),
    owner: source.owner === undefined || source.owner === null ? null : serializeId(source.owner),
    // GroupChat.createdAt is `new Date(creation * 1000)`: an Invalid Date when WhatsApp sent no `creation`
    ...creationOf(source.createdAt),
    description: source.description ?? null,
    // wwebjs itself reads a group without participants as empty (`participants || []`)
    participants: (Array.isArray(source.participants) ? source.participants : []).map(
      participant => ({
        id: serializeId(participant.id),
        isAdmin: participant.isAdmin ?? false,
        isSuperAdmin: participant.isSuperAdmin ?? false
      })
    )
  }
}

export interface ChannelSource extends Omit<
  ChannelDto,
  'id' | 'lastMessage' | 'isChannel' | 'isGroup' | 'isReadOnly' | 'unreadCount' | 'isMuted'
> {
  id: IdLike
  // a missing flag is false and a missing count is 0; every id of a channel is a newsletter
  isChannel?: boolean | null
  isGroup?: boolean | null
  isReadOnly?: boolean | null
  unreadCount?: number | null
  isMuted?: boolean | null
  lastMessage?: MessageSource | null
}

const CHANNEL_FIELDS = [
  'name',
  'description',
  'timestamp',
  'muteExpiration'
] as const satisfies readonly (keyof ChannelSource)[]

export function mapChannel(source: ChannelSource, options: MessageMapOptions): ChannelDto {
  const channel: ChannelDto = {
    ...(pick(source, CHANNEL_FIELDS) as ChannelDto),
    id: serializeId(source.id),
    isChannel: source.isChannel ?? true,
    isGroup: source.isGroup ?? false,
    isReadOnly: source.isReadOnly ?? false,
    unreadCount: source.unreadCount ?? 0,
    isMuted: source.isMuted ?? false
  }
  const lastMessage = source.lastMessage
    ? mapTolerantMessage(source.lastMessage, options)
    : undefined
  if (lastMessage) channel.lastMessage = lastMessage
  return channel
}

export type MembershipRequestSource = Omit<
  MembershipRequestDto,
  'id' | 'addedBy' | 'parentGroupId'
> & {
  id: IdLike
  addedBy?: IdLike | null
  parentGroupId?: IdLike | null
}

export function mapMembershipRequest(source: MembershipRequestSource): MembershipRequestDto {
  const request: MembershipRequestDto = {
    ...pick(source, ['requestMethod', 't'] as const),
    id: serializeId(source.id)
  }
  const addedBy = optionalId(source.addedBy)
  if (addedBy !== undefined) request.addedBy = addedBy
  const parentGroupId = optionalId(source.parentGroupId)
  if (parentGroupId !== undefined) request.parentGroupId = parentGroupId
  return request
}

export type GroupNotificationSource = Omit<WithIds<GroupNotificationDto, 'id'>, 'recipientIds'> & {
  recipientIds: IdLike[]
}

export function mapGroupNotification(source: GroupNotificationSource): GroupNotificationDto {
  return {
    ...pick(source, ['author', 'timestamp'] as const),
    id: serializeId(source.id),
    body: source.body,
    chatId: source.chatId,
    recipientIds: source.recipientIds.map(serializeId),
    type: source.type
  }
}

// ---- Labels, broadcasts, calls -----------------------------------------------------------------

export function mapLabel(source: LabelDto): LabelDto {
  return { ...pick(source, ['hexColor'] as const), id: source.id, name: source.name }
}

export interface BroadcastSource extends Omit<
  BroadcastDto,
  'id' | 'msgs' | 'totalCount' | 'unreadCount'
> {
  id: IdLike
  // Broadcast.js builds `msgs` with `data.msgs?.map(...)` and copies the counts without a default
  msgs?: MessageSource[]
  totalCount?: number | null
  unreadCount?: number | null
}

export function mapBroadcast(source: BroadcastSource, options: MessageMapOptions): BroadcastDto {
  // One status that does not fit its schema is left out, as the last message of a chat is: it must not
  // turn the listing of every broadcast into a 500
  const msgs = (Array.isArray(source.msgs) ? source.msgs : []).flatMap(message => {
    const mapped = mapTolerantMessage(message, options)
    return mapped === undefined ? [] : [mapped]
  })
  return {
    id: serializeId(source.id),
    timestamp: source.timestamp,
    totalCount: source.totalCount ?? msgs.length,
    unreadCount: source.unreadCount ?? 0,
    msgs
  }
}

// `from` is `data.peerJid` in Call.js, the wid WhatsApp Web holds, though the typings say string
export type CallSource = Omit<
  CallDto,
  'from' | 'participants' | 'isVideo' | 'isGroup' | 'fromMe'
> & {
  isVideo?: boolean | null
  isGroup?: boolean | null
  fromMe?: boolean | null
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
  // The id is what a call is told apart by: without one there is nothing to deliver
  if (typeof source.id !== 'string' || source.id === '') throw new Error('A call has no id')
  // Call.js copies the flags without a default: a missing one is false, as `outgoing` is in the patched hook
  const call: CallDto = {
    ...pick(source, CALL_FIELDS),
    isVideo: source.isVideo ?? false,
    isGroup: source.isGroup ?? false,
    fromMe: source.fromMe ?? false
  }
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
  products?: ProductDto[] // Order.js sets it only `if (data.products)`
}

export function mapOrder(source: OrderSource): OrderDto {
  return {
    ...pick(source, ['subtotal', 'total', 'currency', 'createdAt'] as const),
    products: (source.products ?? []).map(mapProduct)
  }
}

export type PaymentSource = Omit<WithIds<PaymentDto, 'id'>, 'paymentMessageReceiverJid'> & {
  paymentMessageReceiverJid?: IdLike | null
}

const PAYMENT_FIELDS = [
  'paymentCurrency',
  'paymentAmount1000',
  'paymentTransactionTimestamp',
  'paymentStatus',
  'paymentTxnStatus',
  'paymentNote'
] as const satisfies readonly (keyof PaymentSource)[]

export function mapPayment(source: PaymentSource): PaymentDto {
  const payment: PaymentDto = {
    ...(pick(source, PAYMENT_FIELDS) as PaymentDto),
    id: serializeId(source.id)
  }
  const receiver = optionalId(source.paymentMessageReceiverJid)
  if (receiver !== undefined) payment.paymentMessageReceiverJid = receiver
  return payment
}

// ---- Client ------------------------------------------------------------------------------------

export function mapBatteryInfo(source: BatteryInfoDto): BatteryInfoDto {
  return { battery: source.battery, plugged: source.plugged }
}

// The note comes out of the page serialized, with whatever else WhatsApp keeps on it: only the six
// fields of the contract leave
export function mapCustomerNote(source: CustomerNote): CustomerNote {
  return {
    id: source.id,
    chatId: source.chatId,
    content: source.content,
    type: source.type,
    createdAt: source.createdAt,
    modifiedAt: source.modifiedAt
  }
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
