import { z } from 'zod'

import { envSchema } from '../config/env.schema.js'
import { ChatMessagesQuery } from '../types/chats.dto.js'
import * as dto from '../types/dto.js'
import { EditMessageBody, SendMessageBody } from '../types/messages.dto.js'
import { EditEventBody } from '../types/polls-events.dto.js'
import { PairingCodeBody } from '../types/sessions.dto.js'

// Where a wwebjs data member lives in the gateway: a field of a DTO, of a request body or query, or an
// environment variable (TDD §6.12, source d). A member that has the same name in the schema of its owner
// is linked by that name; a different name is listed in `renames`, as a path with dots into the schema
// (`categories.id`); a member that must not be linked at all is in `skip`.
export interface FieldSource {
  schema: z.ZodType
  renames?: Readonly<Record<string, string>>
  skip?: readonly string[]
}

// Whatever sits at the end of a path of a schema, one level at a time. Optional, nullable, default, a
// list, a record and a union are looked through; an object is read by its `shape`.
function children(schema: z.ZodType, key: string): z.ZodType[] {
  if (schema instanceof z.ZodObject) {
    const field = (schema.shape as Record<string, z.ZodType | undefined>)[key]
    return field === undefined ? [] : [field]
  }
  if (schema instanceof z.ZodUnion) {
    return (schema.options as z.ZodType[]).flatMap(option => children(option, key))
  }
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return children(schema.unwrap() as z.ZodType, key)
  }
  if (schema instanceof z.ZodDefault) return children(schema.def.innerType as z.ZodType, key)
  if (schema instanceof z.ZodArray) return children(schema.element as z.ZodType, key)
  if (schema instanceof z.ZodRecord) return children(schema.valueType as z.ZodType, key)
  return []
}

export function hasField(schema: z.ZodType, path: string): boolean {
  let level: z.ZodType[] = [schema]
  for (const key of path.split('.')) {
    level = level.flatMap(item => children(item, key))
    if (level.length === 0) return false
  }
  return true
}

// Each owner of a wwebjs member and the schemas that carry it, tried in order
export const FIELD_OWNERS: Readonly<Record<string, readonly FieldSource[]>> = {
  BusinessCategory: [
    {
      schema: dto.BusinessProfileDto,
      renames: { id: 'categories.id', localized_display_name: 'categories.localized_display_name' }
    }
  ],
  BusinessContact: [{ schema: dto.BusinessContactDto }],
  BusinessHours: [
    {
      schema: dto.BusinessProfileDto,
      renames: { config: 'businessHours.config', timezone: 'businessHours.timezone' }
    }
  ],
  BusinessHoursOfDay: [
    {
      schema: dto.BusinessProfileDto,
      renames: { mode: 'businessHours.config.mode', hours: 'businessHours.config.hours' }
    }
  ],
  Chat: [{ schema: dto.ChatDto }],
  Contact: [{ schema: dto.ContactDto }],
  GroupNotification: [{ schema: dto.GroupNotificationDto }],
  Location: [{ schema: dto.LocationDto }],
  LocationSendOptions: [{ schema: SendMessageBody }],
  Message: [
    // wwebjs spells it isEventCaneled; rawData is the sanitized `raw` (TDD §6.6.1)
    { schema: dto.MessageDto, renames: { isEventCaneled: 'isEventCanceled', rawData: 'raw' } }
  ],
  MessageEditOptions: [{ schema: EditMessageBody }],
  MessageMedia: [
    { schema: dto.MessageMediaDto, renames: { data: 'base64', filesize: 'size' } },
    // The URL of a send is downloaded by the gateway behind the SSRF guard (TDD §6.3)
    { schema: SendMessageBody, renames: { fromUrl: 'source.url' } }
  ],
  MediaFromURLOptions: [{ schema: SendMessageBody, renames: { filename: 'source.filename' } }],
  MessageSearchOptions: [{ schema: ChatMessagesQuery }],
  MessageSendOptions: [
    {
      schema: SendMessageBody,
      renames: {
        media: 'source',
        sendAudioAsVoice: 'asVoice',
        sendMediaAsDocument: 'asDocument',
        sendMediaAsHd: 'asHd',
        sendMediaAsSticker: 'asSticker',
        sendVideoAsGif: 'asGif',
        isViewOnce: 'viewOnce'
      }
    }
  ],
  Order: [{ schema: dto.OrderDto }],
  Payment: [{ schema: dto.PaymentDto }],
  Poll: [
    {
      schema: SendMessageBody,
      // `options` is a PollSendOptions, whose fields are flattened into the body: the first stands for it
      renames: { pollName: 'name', pollOptions: 'options', options: 'allowMultipleAnswers' }
    }
  ],
  PollSendOptions: [{ schema: SendMessageBody }],
  PollVote: [
    {
      schema: dto.PollVoteDto,
      renames: { interractedAtTs: 'interactedAtTs', parentMessage: 'parentMessageId' }
    }
  ],
  Product: [{ schema: dto.ProductDto }],
  Reaction: [{ schema: dto.ReactionDto }],
  ScheduledEvent: [
    {
      schema: EditEventBody,
      // `eventSendOptions` holds the other members, flattened into the body: the first stands for it
      renames: { startTimeTs: 'startTime', eventSendOptions: 'description' }
    }
  ],
  ScheduledEventSendOptions: [{ schema: EditEventBody, skip: ['callType'] }],
  SelectedPollOption: [
    {
      schema: dto.PollVoteDto,
      renames: { id: 'selectedOptions.id', name: 'selectedOptions.name' }
    }
  ],
  // The options of `new Client(...)` come from the environment, except the number to pair with, which a
  // request brings (TDD §6.3)
  ClientOptions: [
    {
      schema: envSchema,
      renames: {
        browserName: 'BROWSER_NAME',
        deviceName: 'DEVICE_NAME',
        ffmpegPath: 'FFMPEG_PATH',
        proxyAuthentication: 'PROXY_URL',
        puppeteer: 'PUPPETEER_EXECUTABLE_PATH',
        qrMaxRetries: 'QR_MAX_RETRIES',
        takeoverOnConflict: 'TAKEOVER_ON_CONFLICT',
        webVersion: 'WWEB_VERSION',
        webVersionCache: 'WWEB_VERSION_CACHE_TYPE'
      }
    },
    { schema: PairingCodeBody, renames: { pairWithPhoneNumber: 'phoneNumber' } }
  ],
  LocalAuth: [{ schema: envSchema, renames: { dataPath: 'WWEBJS_DATA_PATH' } }],
  LocalWebCacheOptions: [
    {
      schema: envSchema,
      renames: {
        path: 'WWEB_CACHE_PATH',
        strict: 'WWEB_VERSION_STRICT',
        type: 'WWEB_VERSION_CACHE_TYPE'
      }
    }
  ],
  RemoteWebCacheOptions: [
    {
      schema: envSchema,
      renames: {
        remotePath: 'WWEB_VERSION_REMOTE_PATH',
        strict: 'WWEB_VERSION_STRICT',
        type: 'WWEB_VERSION_CACHE_TYPE'
      }
    }
  ],
  NoWebCacheOptions: [{ schema: envSchema, renames: { type: 'WWEB_VERSION_CACHE_TYPE' } }]
}

// The path a symbol has in the schemas of its owner, or undefined when no schema carries it
function target(symbol: string): { source: FieldSource; path: string } | undefined {
  const [owner = '', member = ''] = symbol.split('.')
  for (const source of FIELD_OWNERS[owner] ?? []) {
    if (source.skip?.includes(member) === true) continue
    const path = source.renames?.[member] ?? member
    if (hasField(source.schema, path)) return { source, path }
  }
  return undefined
}

export const isFieldLinked = (symbol: string): boolean => target(symbol) !== undefined

// A rename that points at nothing: a typo, or a field that left the schema
export function brokenFieldEntries(): string[] {
  const broken: string[] = []
  for (const [owner, sources] of Object.entries(FIELD_OWNERS)) {
    for (const { schema, renames = {} } of sources) {
      for (const [member, path] of Object.entries(renames)) {
        if (!hasField(schema, path)) broken.push(`${owner}.${member} -> ${path}`)
      }
    }
  }
  return broken
}
