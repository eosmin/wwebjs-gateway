import { rm } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

import { Logger } from '@nestjs/common'
import wwebjs, {
  type Channel,
  type Chat,
  type ClientOptions,
  type Contact,
  type GroupChat,
  type GroupNotification,
  type Message,
  type MessageContent,
  type MessageSendOptions
} from 'whatsapp-web.js'
import { z } from 'zod'

import { LONG_CALL_TIMEOUT_MS } from '../common/lib/call-limits.js'
import { withTimeout } from '../common/lib/timeout.js'
import type { AppConfig } from '../config/env.schema.js'
import { processTreeRssBytes } from '../infra/process/process-memory.js'
import { AnyChat } from '../types/chats.dto.js'
import { AnyContact } from '../types/contacts.dto.js'
import type {
  BatteryInfoDto,
  BroadcastDto,
  ChannelDto,
  ClientInfoDto,
  GroupChatDto,
  InviteV4Dto,
  LabelDto,
  MembershipRequestDto,
  MessageDto,
  MessageInfoDto,
  OrderDto,
  PaymentDto,
  PollVoteDto,
  ReactionListDto
} from '../types/dto.js'
import {
  BroadcastDto as BroadcastSchema,
  MessageDto as MessageSchema,
  ChannelDto as ChannelSchema,
  LabelDto as LabelSchema
} from '../types/dto.js'

import {
  ConsoleTail,
  cleanConsoleLine,
  isLogoutRelevant,
  logoutReasonOf
} from './logout-diagnostics.js'
import {
  failedFields,
  mapBatteryInfo,
  mapCustomerNote,
  mapBroadcast,
  mapBusinessContact,
  mapCall,
  mapChannel,
  mapChat,
  mapClientInfo,
  mapContact,
  mapGroupChat,
  mapGroupNotification,
  mapLabel,
  mapMembershipRequest,
  mapMessage,
  mapMessageInfo,
  mapOrder,
  mapPayment,
  mapPollVote,
  mapReaction,
  mapReactionList,
  sanitizeRaw,
  type IdLike,
  type MessageMapOptions,
  mediaDownloadUrl
} from './mappers.js'
import { releaseProfileLock } from './profile-lock.js'
import {
  type CauseCode,
  describeCause,
  sanitize,
  isPageWaitTimeout,
  isPuppeteerFailure,
  mapping,
  notReady,
  runWaCall
} from './wa-call.js'
import {
  WaChatNotFoundError,
  WaAuthStalledError,
  WaDisconnectedError,
  WaMappingError,
  WaOperationError,
  WaProfileLockedError
} from './wa-errors.js'
import type {
  AddParticipantsOptions,
  AddParticipantsResult,
  AnyChatDto,
  AnyContactDto,
  ChannelSendOptions,
  ChannelSubscriber,
  ChatStateKind,
  ClientEvent,
  ClientEventListener,
  ClientEventName,
  SkippedEventListener,
  CreateChannelOptions,
  CreateChannelResult,
  CreateGroupOptions,
  CreateGroupResult,
  CustomerNote,
  DownloadedMedia,
  EditOptions,
  FetchMessagesOptions,
  LidAndPhone,
  MembershipRequestActionOptions,
  MembershipRequestActionResult,
  MuteResult,
  OutboundContent,
  OutboundMedia,
  PairingCodeRequest,
  SearchChannelsOptions,
  SearchMessagesOptions,
  SendOptions,
  TransferChannelOwnershipOptions,
  UnsubscribeOptions,
  WhatsAppClientFactory,
  WhatsAppClientOptions,
  RejectCallResult,
  WhatsAppClientPort
} from './whatsapp-client.port.js'

// The ONLY file that imports whatsapp-web.js (lint rule `no-restricted-imports`). It is as thin as it
// can be: it builds the client, runs every call through `runWaCall` (deadline + error translation),
// turns every wwebjs object into a DTO with `mappers.ts` before it leaves, and forwards the events.
// It cannot run without a WhatsApp account, so it is the one file out of the coverage threshold; its
// wiring is still tested by driving a real `Client` with `emit` (wwebjs-adapter.spec.ts).

// Named imports fail at runtime: Node reads the exports of this CommonJS package statically, and the
// `...Constants` spread of its index.js hides LocalAuth and the rest from it
// eslint-disable-next-line import-x/no-named-as-default-member -- see above
const { Client, LocalAuth, Location, MessageMedia, Poll, ScheduledEvent } = wwebjs

// ---- Configuration -----------------------------------------------------------------------------

export type WwebjsAdapterConfig = Pick<
  AppConfig,
  | 'WWEBJS_DATA_PATH'
  | 'PUPPETEER_EXECUTABLE_PATH'
  | 'WWEB_VERSION'
  | 'WWEB_VERSION_CACHE_TYPE'
  | 'WWEB_CACHE_PATH'
  | 'WWEB_VERSION_REMOTE_PATH'
  | 'WWEB_VERSION_STRICT'
  | 'QR_MAX_RETRIES'
  | 'TAKEOVER_ON_CONFLICT'
  | 'DEVICE_NAME'
  | 'BROWSER_NAME'
  | 'PROXY_URL'
  | 'WA_CALL_TIMEOUT_MS'
  | 'CALL_CACHE_SIZE'
  | 'FFMPEG_PATH'
  | 'INCLUDE_RAW'
  | 'RAW_MAX_FIELD_BYTES'
  | 'PUBLIC_BASE_URL'
>

const CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-zygote'
]

// Sending and moving media take longer than a query (TDD §6.3)
const LONG_CALLS: ReadonlySet<string> = new Set([
  'sendMessage',
  'sendChannelMessage',
  'replyToMessage',
  'forwardMessage',
  'downloadMedia',
  'setProfilePicture',
  'setGroupPicture',
  'setChannelProfilePicture',
  'createChannel',
  // Their time grows with the input: wwebjs pauses 250-500 ms per participant or requester, and a
  // big account has thousands of chats, contacts and messages
  'createGroup',
  'addParticipants',
  'approveGroupMembershipRequests',
  'rejectGroupMembershipRequests',
  'syncHistory',
  'getChats',
  'getContacts',
  'searchMessages',
  'fetchMessages',
  'fetchChannelMessages'
])
// `page.goto` of wwebjs has no timeout of its own, so initialize gets one; the watchdog still guards
// the status
const INITIALIZE_TIMEOUT_MS = 180_000
const PAGE_PROBE_TIMEOUT_MS = 5000

// Calls that work while the browser is down: they are how a session comes back or goes away
const WORKS_WHEN_NOT_READY: ReadonlySet<string> = new Set([
  'initialize',
  'destroy',
  'logout',
  'resetState',
  'getState',
  'getWWebVersion',
  'requestPairingCode',
  'cancelPairingCode'
])

// The text of an auth failure is the library's, not ours
// F25: bounds the lines of the page console a run that is not ready may log
const PAGE_LINES_PER_RUN = 50
const MAX_AUTH_FAILURE_LENGTH = 200

// Builds the options of `new Client(...)` from the environment (TDD §6.3). `userDataDir` is never
// set: LocalAuth owns it and throws when it is supplied.
export function buildClientOptions(
  config: WwebjsAdapterConfig,
  sessionId: string,
  options: WhatsAppClientOptions
): ClientOptions {
  const args = [...CHROMIUM_ARGS]
  let proxyAuthentication: ClientOptions['proxyAuthentication']
  if (config.PROXY_URL) {
    const proxy = new URL(config.PROXY_URL)
    args.push(`--proxy-server=${proxy.protocol}//${proxy.host}`)
    if (proxy.username) {
      proxyAuthentication = {
        username: decodeURIComponent(proxy.username),
        password: decodeURIComponent(proxy.password)
      }
    }
  }

  const clientOptions: ClientOptions = {
    authStrategy: new LocalAuth({ clientId: sessionId, dataPath: config.WWEBJS_DATA_PATH }),
    puppeteer: {
      headless: true,
      args,
      ...(config.PUPPETEER_EXECUTABLE_PATH
        ? { executablePath: config.PUPPETEER_EXECUTABLE_PATH }
        : {})
    },
    qrMaxRetries: config.QR_MAX_RETRIES,
    takeoverOnConflict: config.TAKEOVER_ON_CONFLICT,
    webVersionCache: webVersionCache(config)
  }
  if (config.WWEB_VERSION) clientOptions.webVersion = config.WWEB_VERSION
  if (config.FFMPEG_PATH) clientOptions.ffmpegPath = config.FFMPEG_PATH
  if (config.DEVICE_NAME) clientOptions.deviceName = config.DEVICE_NAME
  if (config.BROWSER_NAME) clientOptions.browserName = config.BROWSER_NAME
  if (proxyAuthentication) clientOptions.proxyAuthentication = proxyAuthentication
  if (options.pairWithPhoneNumber) clientOptions.pairWithPhoneNumber = options.pairWithPhoneNumber
  return clientOptions
}

// Without a pinned version the live build runs, and no snapshot is looked up
function webVersionCache(
  config: WwebjsAdapterConfig
): NonNullable<ClientOptions['webVersionCache']> {
  if (!config.WWEB_VERSION || config.WWEB_VERSION_CACHE_TYPE === 'none') return { type: 'none' }
  if (config.WWEB_VERSION_CACHE_TYPE === 'remote') {
    return {
      type: 'remote',
      remotePath: config.WWEB_VERSION_REMOTE_PATH ?? '',
      strict: config.WWEB_VERSION_STRICT
    }
  }
  return { type: 'local', path: config.WWEB_CACHE_PATH, strict: config.WWEB_VERSION_STRICT }
}

// ---- Boundary helpers --------------------------------------------------------------------------

// Causes logged at debug (see `logCause`)
const QUIET_CAUSES: ReadonlySet<CauseCode> = new Set([
  'CHAT_NOT_FOUND',
  'TIMEOUT',
  'BROWSER_GONE',
  'GATEWAY_ERROR'
])

const errorKind = (error: unknown): string => (error instanceof Error ? error.name : typeof error)

// The typings of wwebjs say `object` for some ids that are wids at runtime
const WidLike = z.looseObject({ _serialized: z.string() })
type BroadcastInput = Omit<Parameters<typeof mapBroadcast>[0], 'id'> & {
  id?: Parameters<typeof mapBroadcast>[0]['id']
}

const toIdLike = (value: unknown): IdLike =>
  typeof value === 'string' ? value : WidLike.parse(value)

const toIdLikeOrNull = (value: unknown): IdLike | null =>
  value === null || value === undefined ? null : toIdLike(value)

// The outcomes of `addParticipants` and `createGroup` are typed wrongly in wwebjs 1.34.8 (`{ [id]: { [id]: … } }`);
// this is what WhatsApp answers. Each field is read on its own: one of another type is left out, never
// a failure, because the action (participants added, group created) has already happened
const outcomeOf = (codeKey: 'code' | 'statusCode') =>
  z.object({
    [codeKey]: z.number().optional().catch(undefined),
    message: z.string().optional().catch(undefined),
    isGroupCreator: z.boolean().optional().catch(undefined),
    isInviteV4Sent: z.boolean().optional().catch(undefined)
  })
const Outcomes = (codeKey: 'code' | 'statusCode') =>
  z.record(z.string(), outcomeOf(codeKey).catch({}))

const isChannel = (chat: Chat | Channel): chat is Channel =>
  'isChannel' in chat && chat.isChannel === true
const isGroupChat = (chat: Chat | Channel): chat is GroupChat =>
  !isChannel(chat) && chat.isGroup && 'participants' in chat

// ---- Adapter -----------------------------------------------------------------------------------

export class WwebjsAdapter implements WhatsAppClientPort {
  private readonly logger: Logger
  private readonly listeners = new Set<ClientEventListener>()
  private readonly skippedListeners = new Set<SkippedEventListener>()
  // Calls received, so that `rejectCall` finds the wwebjs object of the call it is asked about
  private readonly calls = new Map<string, wwebjs.Call>()
  private readonly guardedBrowsers = new WeakSet<object>()
  // F25: what the page wrote about a reload or a logout. While the session is not ready the lines go
  // to the debug log (at most PAGE_LINES_PER_RUN), while it is ready the last few are held for the
  // 5 s before a LOGOUT
  private readonly consoleTail = new ConsoleTail(5_000, 20)
  private pageLines = 0
  private ready = false
  // Set when the session ended (a disconnect event, a destroy or a logout), so that the browser
  // closing right after is not reported a second time
  private ended = false
  // The initialize in flight, kept so that destroy can clean up after it
  private starting: Promise<void> | undefined
  // Set by destroy, cleared by initialize: tells an initialize that was waiting to stand down
  private destroyRequested = false

  constructor(
    readonly sessionId: string,
    private readonly client: InstanceType<typeof Client>,
    private readonly config: WwebjsAdapterConfig,
    // The look at the profile lock before each start; a spec of timers replaces it, since it reads the disk
    private readonly releaseLock: typeof releaseProfileLock = releaseProfileLock
  ) {
    this.logger = new Logger(`WwebjsAdapter:${sessionId}`)
    this.wireEvents()
  }

  // ---- Calls -----------------------------------------------------------------------------------

  private async run<T>(operation: string, call: () => Promise<T>): Promise<T> {
    if (!WORKS_WHEN_NOT_READY.has(operation) && !this.ready) throw notReady(operation)
    const timeoutMs = LONG_CALLS.has(operation)
      ? Math.max(this.config.WA_CALL_TIMEOUT_MS, LONG_CALL_TIMEOUT_MS)
      : this.config.WA_CALL_TIMEOUT_MS
    return await runWaCall(operation, timeoutMs, call, error => {
      this.logCause(operation, error)
    })
  }

  // Why a call failed, for the log: the error that reaches the caller says only what failed, so this
  // line is the one place that keeps the original (see `describeCause` for what it holds and masks)
  private logCause(operation: string, error: unknown): void {
    const { code, kind, message } = describeCause(error)
    const line = `${operation} failed [${code}] (${kind})${message ? `: ${message}` : ''}`
    // What a flapping session or a wrong id makes routine (a timeout, a browser that went away, a chat
    // that does not exist, an error of ours already told to the caller) stays at debug, so the log of a
    // busy gateway keeps the faults: the library failing, a mapper of ours, an unknown outcome
    if (QUIET_CAUSES.has(code)) this.logger.debug(line)
    else this.logger.warn(line)
  }

  // The participants outcomes, read field by field. The action already happened, so an odd answer is
  // delivered with what is known and logged, never turned into a failure
  private outcomes(
    operation: string,
    codeKey: 'code' | 'statusCode',
    raw: unknown
  ): Record<string, Record<string, unknown>> {
    const parsed = Outcomes(codeKey).safeParse(raw)
    if (!parsed.success) {
      this.logger.warn(
        `[${this.sessionId}] ${operation}: the participant outcomes had an unexpected shape`
      )
      return {}
    }
    // The message of an outcome is WhatsApp's text: it can quote a number, so it is masked like the other texts
    return Object.fromEntries(
      Object.entries(parsed.data).map(([id, outcome]) => [
        id,
        typeof outcome.message === 'string'
          ? { ...outcome, message: sanitize(outcome.message) }
          : outcome
      ])
    )
  }

  // The library answers a text instead of throwing, and the text can quote ids, numbers or the names
  // the caller sent (subject, title, description): it is masked (the names too, which the masking
  // cannot know) before it is logged or reaches the client and the webhooks
  private refusedReason(operation: string, text: string, names: readonly string[] = []): string {
    let unnamed = text.slice(0, 2000)
    for (const name of names) {
      const literal = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // Whole words only, any case: a one-letter name must not mangle the rest of the text. Names go
      // first, before the cap of `sanitize` could cut one in half
      if (literal) {
        unnamed = unnamed.replace(
          new RegExp(`(?<![\\p{L}\\p{N}_])${literal}(?![\\p{L}\\p{N}_])`, 'giu'),
          '[name]'
        )
      }
    }
    const reason = sanitize(unnamed)
    this.logger.warn(`${operation} refused: ${reason}`)
    return reason
  }

  // WhatsApp accepted the message by the time it is mapped: a failure here is an unknown outcome and
  // must never read as "not sent", or a worker could send it twice. The exception is null: the
  // patched library answers it when the page found no chat, or the content is not supported in a
  // channel or status, so nothing was sent. undefined stays an unknown outcome
  private sent(operation: string, source: Message | null | undefined, chatId?: string): MessageDto {
    if (source === null) {
      throw new WaOperationError(operation, 'Chat not found or content not supported')
    }
    try {
      if (source === undefined) throw new TypeError('The library answered no message')
      // The caller knows where the message went: an answer that names no chat is still a message that went out
      return mapping(() => mapMessage(source, { ...this.mapOptions(), fallbackChatId: chatId }))
    } catch (error: unknown) {
      this.logger.warn(`Mapping the result of ${operation} failed (${errorKind(error)})`)
      throw new WaMappingError(operation, `${operation}: the result could not be read`)
    }
  }

  private mapOptions(): MessageMapOptions {
    return {
      receivedAt: new Date(),
      onInvalidTimestamp: () =>
        this.logger.warn(
          'A message came with a timestamp that is not a date; dated by its arrival'
        ),
      onUnreadableMessage: fields =>
        this.logger.warn(
          `[${this.sessionId}] A message does not fit its schema (${fields}); left out of the chat or broadcast that holds it`
        ),
      onDroppedField: field =>
        this.logger.warn(
          `[${this.sessionId}] A message field came with an unexpected type (${field}); left out of the message`
        ),
      includeRaw: this.config.INCLUDE_RAW,
      rawMaxFieldBytes: this.config.RAW_MAX_FIELD_BYTES,
      mediaUrl: messageId =>
        mediaDownloadUrl(this.config.PUBLIC_BASE_URL, this.sessionId, messageId)
    }
  }

  private message(source: Message): MessageDto {
    return mapping(() => mapMessage(source, this.mapOptions()))
  }

  private messages(sources: readonly Message[]): MessageDto[] {
    return this.listed(
      'messages',
      sources,
      source => mapMessage(source, this.mapOptions()),
      MessageSchema
    )
  }

  // wwebjs answers undefined, not an error, for a message that is not in the page
  private async messageById(operation: string, messageId: string): Promise<Message> {
    const found: Message | null | undefined = await this.client.getMessageById(messageId)
    if (!found) throw new WaOperationError(operation, 'Message not found')
    return found
  }

  private async chatById(operation: string, chatId: string): Promise<Chat | Channel> {
    const found: Chat | Channel | null | undefined = await this.client.getChatById(chatId)
    if (!found) throw new WaChatNotFoundError(operation)
    return found
  }

  private async groupById(operation: string, groupId: string): Promise<GroupChat> {
    const chat = await this.chatById(operation, groupId)
    if (!isGroupChat(chat)) throw new WaOperationError(operation, 'The chat is not a group')
    return chat
  }

  private async channelById(operation: string, channelId: string): Promise<Channel> {
    const chat = await this.chatById(operation, channelId)
    if (!isChannel(chat)) throw new WaOperationError(operation, 'The chat is not a channel')
    return chat
  }

  private mapAnyChat(chat: Chat | Channel): AnyChatDto {
    const options = this.mapOptions()
    if (isChannel(chat)) return mapChannel(chat, options)
    if (isGroupChat(chat)) return mapGroupChat(chat, options)
    return mapChat(chat, options)
  }

  private anyChat(chat: Chat | Channel): AnyChatDto {
    return mapping(() => this.mapAnyChat(chat))
  }

  // A listing leaves out an item that cannot be mapped or does not fit the schema of its response, and
  // says so in the log (field names only, never values or ids): one odd item of the account must not
  // turn the whole listing, which the rest of the account needs, into a 500. The item stays reachable
  // by its own id, where a failure is reported as such. See ADR 0006.
  private listed<S, D>(
    what: string,
    sources: readonly S[],
    map: (source: S) => D,
    schema: z.ZodType
  ): D[] {
    const items: D[] = []
    const reasons = new Set<string>()
    let skipped = 0
    for (const source of sources) {
      try {
        const dto = map(source)
        const parsed = schema.safeParse(dto)
        if (parsed.success) {
          items.push(dto)
          continue
        }
        for (const field of failedFields(parsed.error)) reasons.add(field)
      } catch (error: unknown) {
        reasons.add(`mapping failed: ${error instanceof Error ? error.name : typeof error}`)
      }
      skipped += 1
    }
    if (skipped > 0 && skipped === sources.length) {
      // Every item failing is a mapper that broke (a renamed field of the library), not an odd item
      this.logger.error(
        `[${this.sessionId}] ${what}: every item (${skipped}) left out of the listing (${[...reasons].join(', ')})`
      )
    } else if (skipped > 0) {
      this.logger.warn(
        `[${this.sessionId}] ${what}: ${skipped} of ${sources.length} items left out of the listing (${[...reasons].join(', ')})`
      )
    }
    return items
  }

  private chatDtos(chats: readonly (Chat | Channel)[]): AnyChatDto[] {
    return this.listed('chats', chats, chat => this.mapAnyChat(chat), AnyChat)
  }

  private channelDtos(channels: readonly Channel[]): ChannelDto[] {
    return this.listed(
      'channels',
      channels,
      channel => mapChannel(channel, this.mapOptions()),
      ChannelSchema
    )
  }

  private groupChatDto(chat: GroupChat): GroupChatDto {
    return mapping(() => mapGroupChat(chat, this.mapOptions()))
  }

  private channelDto(channel: Channel): ChannelDto {
    return mapping(() => mapChannel(channel, this.mapOptions()))
  }

  private mapAnyContact(contact: Contact): AnyContactDto {
    // BusinessContact assigns the property even when the profile is not loaded (undefined)
    return 'businessProfile' in contact && contact.businessProfile
      ? mapBusinessContact(contact as Parameters<typeof mapBusinessContact>[0]) // BusinessContact is a Contact with a profile
      : mapContact(contact)
  }

  private contactDto(contact: Contact): AnyContactDto {
    return mapping(() => this.mapAnyContact(contact))
  }

  private contactDtos(contacts: readonly Contact[]): AnyContactDto[] {
    return this.listed('contacts', contacts, contact => this.mapAnyContact(contact), AnyContact)
  }

  private labelDtos(labels: readonly LabelDto[]): LabelDto[] {
    return this.listed('labels', labels, mapLabel, LabelSchema)
  }

  // wwebjs builds a `Broadcast` without `id` and `msgs` when WhatsApp Web holds no statuses of the user
  private broadcastDto(source: BroadcastInput): BroadcastDto | null {
    const { id } = source
    if (id === undefined) return null
    return mapping(() => mapBroadcast({ ...source, id }, this.mapOptions()))
  }

  private broadcastDtos(sources: readonly BroadcastInput[]): BroadcastDto[] {
    const withId = sources.flatMap(source =>
      source.id === undefined ? [] : [{ ...source, id: source.id }]
    )
    return this.listed(
      'broadcasts',
      withId,
      source => mapBroadcast(source, this.mapOptions()),
      BroadcastSchema
    )
  }

  private async media(media: OutboundMedia): Promise<InstanceType<typeof MessageMedia>> {
    return await Promise.resolve(new MessageMedia(media.mimetype, media.data, media.filename))
  }

  private async toContent(content: OutboundContent): Promise<MessageContent> {
    switch (content.type) {
      case 'text':
        return content.body
      case 'media':
        return await this.media(content.media)
      case 'location':
        return new Location(content.latitude, content.longitude, {
          name: content.name,
          address: content.address,
          url: content.url
        })
      case 'poll':
        return new Poll(content.name, content.options, {
          allowMultipleAnswers: content.allowMultipleAnswers,
          messageSecret: content.messageSecret
        })
      case 'contacts':
        return await Promise.all(content.contactIds.map(id => this.client.getContactById(id)))
      case 'event':
        return this.toEvent(content)
    }
  }

  private toEvent(
    event: Extract<OutboundContent, { type: 'event' }>
  ): InstanceType<typeof ScheduledEvent> {
    return new ScheduledEvent(event.name, event.startTime, {
      description: event.description,
      endTime: event.endTime,
      location: event.location,
      callType: event.callType ?? 'none',
      isEventCanceled: event.isEventCanceled,
      messageSecret: event.messageSecret
    })
  }

  private toSendOptions(options: SendOptions | undefined): MessageSendOptions {
    return { ...options }
  }

  // ---- Events ----------------------------------------------------------------------------------

  onEvent(listener: ClientEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  onSkipped(listener: SkippedEventListener): () => void {
    this.skippedListeners.add(listener)
    return () => {
      this.skippedListeners.delete(listener)
    }
  }

  private deliver(event: ClientEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (error: unknown) {
        this.logger.warn(`A listener of ${event.event} threw (${errorKind(error)})`)
      }
    }
  }

  // A handler runs inside wwebjs: whatever it throws must not reach the library or the process
  private forward(name: string, produce: () => ClientEvent | undefined): void {
    try {
      const event = produce()
      if (event) this.deliver(event)
    } catch (error: unknown) {
      this.logger.warn(`Mapping the ${name} event failed (${errorKind(error)})`)
      this.notifySkipped(name as ClientEventName)
    }
  }

  // A listener that throws must not stop the others, nor bring the event handler of wwebjs down
  private notifySkipped(name: ClientEventName): void {
    for (const listener of [...this.skippedListeners]) {
      try {
        listener(name)
      } catch (error: unknown) {
        this.logger.warn(`A skipped-event listener failed (${errorKind(error)})`)
      }
    }
  }

  private failSession(code: string, message: string): void {
    if (this.ended) return
    this.ended = true
    this.ready = false
    this.forward('session_error', () => ({ event: 'session_error', data: { code, message } }))
  }

  // The browser or the page dying is reported once per run, unless the adapter closed it itself
  private guardBrowser(): void {
    try {
      this.watchBrowser()
    } catch (error: unknown) {
      this.logger.warn(`Watching the browser failed (${errorKind(error)})`)
    }
  }

  private watchBrowser(): void {
    const browser = this.client.pupBrowser
    if (browser && !this.guardedBrowsers.has(browser)) {
      this.guardedBrowsers.add(browser)
      browser.on('disconnected', () => {
        this.failSession('BROWSER_DISCONNECTED', 'The browser disconnected')
      })
    }
    const page = this.client.pupPage
    if (page && !this.guardedBrowsers.has(page)) {
      this.guardedBrowsers.add(page)
      page.on('close', () => {
        this.failSession('PAGE_CLOSED', 'The WhatsApp Web page closed')
      })
      page.on('error', () => {
        this.failSession('PAGE_CRASHED', 'The WhatsApp Web page crashed')
      })
      page.on('console', message => {
        this.keepPageLine(message)
      })
    }
  }

  private keepPageLine(message: { text(): string }): void {
    try {
      const text = message.text()
      if (!isLogoutRelevant(text)) return
      const line = cleanConsoleLine(text)
      if (this.ready) {
        this.consoleTail.add(line)
      } else if (this.pageLines < PAGE_LINES_PER_RUN) {
        this.pageLines += 1
        this.logger.debug(`WhatsApp Web page: ${line}`)
      }
    } catch {
      // A console message that cannot be read is not worth a failure of the session
    }
  }

  // What wwebjs saw when it reported the logout: its flag (set by an event of the page and left set
  // when no navigation follows) and whether the frame went to the logout address. Two booleans: no
  // address and no account data. It only looks; the logout goes on as it always did.
  private logLogout(): void {
    try {
      const flagStale = (this.client as { lastLoggedOut?: unknown }).lastLoggedOut === true
      const address = this.client.pupPage?.url() ?? ''
      const postLogoutUrl = address.includes('post_logout=1')
      // The token WhatsApp Web gives as the reason, when it is a short one: never the address
      const reason = logoutReasonOf(address)
      this.logger.warn(
        `WhatsApp Web reported a LOGOUT (flagStale=${flagStale}, postLogoutUrl=${postLogoutUrl}${
          reason ? `, logoutReason=${reason}` : ''
        })`
      )
      for (const line of this.consoleTail.recent()) {
        this.logger.debug(`WhatsApp Web page before the logout: ${line}`)
      }
    } catch (error: unknown) {
      this.logger.warn(
        `WhatsApp Web reported a LOGOUT (reading the page failed: ${errorKind(error)})`
      )
    }
  }

  private wireEvents(): void {
    const client = this.client
    const forward = (name: string, produce: () => ClientEvent | undefined): void => {
      this.guardBrowser()
      this.forward(name, produce)
    }

    client.on('qr', qr => {
      forward('qr', () => ({ event: 'qr', data: { qr } }))
    })
    client.on('code', code => {
      forward('code', () => ({ event: 'code', data: { code } }))
    })
    client.on('authenticated', () => {
      forward('authenticated', () => ({ event: 'authenticated', data: {} }))
    })
    client.on('auth_failure', message => {
      this.ready = false
      // wwebjs destroys the client right after: the browser closing then is not a new failure
      this.ended = true
      forward('auth_failure', () => ({
        event: 'auth_failure',
        data: { message: String(message).slice(0, MAX_AUTH_FAILURE_LENGTH) }
      }))
    })
    client.on('ready', () => {
      this.ready = true
      this.ended = false
      this.pageLines = 0
      forward('ready', () => ({ event: 'ready', data: {} }))
    })
    client.on('loading_screen', (percent, message) => {
      forward('loading_screen', () => ({
        event: 'loading_screen',
        data: { percent: String(percent), message }
      }))
    })
    client.on('disconnected', reason => {
      if (reason === 'LOGOUT') this.logLogout()
      this.ready = false
      this.ended = true
      forward('disconnected', () => ({ event: 'disconnected', data: { reason: String(reason) } }))
    })
    client.on('change_state', state => {
      forward('change_state', () => ({ event: 'change_state', data: { state: String(state) } }))
    })
    client.on('change_battery', info => {
      forward('change_battery', () => ({ event: 'change_battery', data: mapBatteryInfo(info) }))
    })

    client.on('message', message => {
      forward('message', () => ({ event: 'message', data: this.message(message) }))
    })
    client.on('message_create', message => {
      forward('message_create', () => ({ event: 'message_create', data: this.message(message) }))
    })
    client.on('message_ack', (message, ack) => {
      forward('message_ack', () => ({
        event: 'message_ack',
        data: { message: this.message(message), ack: Number(ack) }
      }))
    })
    client.on('message_edit', (message, newBody, prevBody) => {
      forward('message_edit', () => ({
        event: 'message_edit',
        data: {
          message: this.message(message),
          newBody: String(newBody),
          prevBody: String(prevBody)
        }
      }))
    })
    client.on('message_revoke_everyone', (message, revoked) => {
      forward('message_revoke_everyone', () => ({
        event: 'message_revoke_everyone',
        data: {
          message: this.message(message),
          revokedMessage: revoked ? this.message(revoked) : null
        }
      }))
    })
    client.on('message_revoke_me', message => {
      forward('message_revoke_me', () => ({
        event: 'message_revoke_me',
        data: this.message(message)
      }))
    })
    client.on('message_reaction', reaction => {
      forward('message_reaction', () => ({
        event: 'message_reaction',
        data: mapReaction(reaction)
      }))
    })
    client.on('message_ciphertext', message => {
      forward('message_ciphertext', () => ({
        event: 'message_ciphertext',
        data: this.message(message)
      }))
    })
    client.on('message_ciphertext_failed', message => {
      forward('message_ciphertext_failed', () => ({
        event: 'message_ciphertext_failed',
        data: this.message(message)
      }))
    })
    client.on('media_uploaded', message => {
      forward('media_uploaded', () => ({ event: 'media_uploaded', data: this.message(message) }))
    })

    client.on('unread_count', chat => {
      forward('unread_count', () => ({
        event: 'unread_count',
        data: mapChat(chat, this.mapOptions())
      }))
    })
    client.on('chat_removed', chat => {
      forward('chat_removed', () => ({
        event: 'chat_removed',
        data: mapChat(chat, this.mapOptions())
      }))
    })
    client.on('chat_archived', (chat, currState, prevState) => {
      forward('chat_archived', () => ({
        event: 'chat_archived',
        data: {
          chat: mapChat(chat, this.mapOptions()),
          currState: Boolean(currState),
          prevState: Boolean(prevState)
        }
      }))
    })
    client.on('contact_changed', (message, oldId, newId, isContact) => {
      forward('contact_changed', () => ({
        event: 'contact_changed',
        data: {
          message: this.message(message),
          oldId: String(oldId),
          newId: String(newId),
          isContact: Boolean(isContact)
        }
      }))
    })

    const groupEvents = [
      'group_join',
      'group_leave',
      'group_update',
      'group_admin_changed',
      'group_membership_request'
    ] as const
    for (const name of groupEvents) {
      client.on(name, (notification: GroupNotification) => {
        forward(name, () => ({
          event: name,
          data: mapGroupNotification({ ...notification, id: toIdLike(notification.id) })
        }))
      })
    }

    client.on('vote_update', vote => {
      forward('vote_update', () => ({ event: 'vote_update', data: mapPollVote(vote) }))
    })
    client.on('call', call => {
      if (typeof call.id === 'string' && call.id !== '') this.rememberCall(call)
      forward('call', () => ({ event: 'call', data: mapCall(call) }))
    })
    // RemoteAuth is not used, so this never fires; it is wired so that no wwebjs event is left out
    client.on('remote_session_saved', () => {
      forward('remote_session_saved', () => ({ event: 'remote_session_saved', data: {} }))
    })
  }

  private rememberCall(call: wwebjs.Call): void {
    // A call that fires again (its state changed) moves to the newest slot instead of keeping an old one
    this.calls.delete(call.id)
    this.calls.set(call.id, call)
    const oldest = this.calls.keys().next()
    if (this.calls.size > this.config.CALL_CACHE_SIZE && !oldest.done)
      this.calls.delete(oldest.value)
  }

  // ---- Lifecycle -------------------------------------------------------------------------------

  async initialize(): Promise<void> {
    this.ended = false
    this.destroyRequested = false
    await this.freeProfile()
    // A destroy that came while the lock was being cleared: a browser started now would belong to
    // nobody and would hold the profile
    if (this.destroyRequested) throw new WaDisconnectedError('initialize', false)
    const starting = this.client.initialize()
    this.starting = starting
    let waitTimedOut = false
    try {
      await runWaCall(
        'initialize',
        Math.max(this.config.WA_CALL_TIMEOUT_MS, INITIALIZE_TIMEOUT_MS),
        () => starting,
        error => {
          this.logCause('initialize', error)
          waitTimedOut = isPageWaitTimeout(error)
        }
      )
    } catch (error: unknown) {
      // A page that loaded and a connection that did not open: the manager decides what that means
      if (waitTimedOut && (await this.pageLoaded())) throw new WaAuthStalledError()
      throw error
    }
    this.guardBrowser()
  }

  // Read-only: has WhatsApp Web itself loaded in the page (its build number is defined)? False when
  // there is no page or it does not answer in time.
  private async pageLoaded(): Promise<boolean> {
    const page = this.client.pupPage
    if (!page) return false
    try {
      const loaded: unknown = await withTimeout(
        page.evaluate('window.Debug?.VERSION !== undefined'),
        PAGE_PROBE_TIMEOUT_MS,
        'page probe'
      )
      return loaded === true
    } catch {
      return false
    }
  }

  // Where LocalAuth keeps the profile of this session (the folder it names `session-<clientId>`)
  private profileDir(): string {
    return resolve(this.config.WWEBJS_DATA_PATH, `session-${this.sessionId}`)
  }

  // A browser that a dead gateway left behind holds the profile lock and the next browser would not
  // start; a lock of a dead process is cleared and an orphan of this very profile is closed. A lock held
  // by anything else stops the start with an error that says so. Failing to look is not a reason to
  // fail: the browser then gets its chance.
  private async freeProfile(): Promise<void> {
    try {
      const outcome = await this.releaseLock(this.profileDir())
      if (outcome !== 'free') this.logger.warn(`Found a leftover browser lock (${outcome})`)
    } catch (error: unknown) {
      if (error instanceof WaProfileLockedError) throw error
      this.logger.warn(`Checking the browser profile failed (${errorKind(error)})`)
    }
  }

  async discardAuth(): Promise<void> {
    const dir = this.profileDir()
    // The folder of this session only: the id is validated upstream, and this refuses a path that
    // would leave the data folder anyway
    if (!dir.startsWith(resolve(this.config.WWEBJS_DATA_PATH) + sep)) {
      throw new WaOperationError('discardAuth', 'discardAuth failed')
    }
    try {
      await rm(dir, { recursive: true, force: true })
    } catch (error: unknown) {
      this.logger.warn(`Deleting the saved login failed (${errorKind(error)})`)
      throw new WaOperationError('discardAuth', 'discardAuth failed')
    }
  }

  async destroy(): Promise<void> {
    this.ended = true
    this.destroyRequested = true
    this.ready = false
    try {
      await this.run('destroy', () => this.client.destroy())
    } finally {
      this.killBrowser()
      // An initialize abandoned at its deadline may still be launching Chromium; the browser it
      // ends up with would keep the profile lock of the session
      this.starting?.then(
        () => {
          this.killBrowser()
        },
        () => {
          this.killBrowser()
        }
      )
    }
  }

  // wwebjs closes the browser politely and only when it is connected; a hung one needs the signal
  private killBrowser(): void {
    try {
      this.client.pupBrowser?.process()?.kill('SIGKILL')
    } catch (error: unknown) {
      this.logger.warn(`Killing the browser failed (${errorKind(error)})`)
    }
  }

  async logout(): Promise<void> {
    this.ended = true
    this.ready = false
    await this.run('logout', () => this.client.logout())
  }

  resetState(): Promise<void> {
    return this.run('resetState', () => this.client.resetState())
  }

  getState(): Promise<string | null> {
    return this.run('getState', async () => {
      const state: string | null | undefined = await this.client.getState()
      return state ?? null
    })
  }

  getWWebVersion(): Promise<string> {
    return this.run('getWWebVersion', () => this.client.getWWebVersion())
  }

  getClientInfo(): Promise<ClientInfoDto> {
    return this.run('getClientInfo', () => {
      const info: typeof this.client.info | undefined = this.client.info
      if (!info) throw notReady('getClientInfo')
      return Promise.resolve(mapping(() => mapClientInfo(info)))
    })
  }

  // Not a call into WhatsApp Web, so it is not timed or counted like one
  async getBrowserMemoryBytes(): Promise<number | undefined> {
    const pid = this.client.pupBrowser?.process()?.pid
    return pid === undefined ? undefined : await processTreeRssBytes(pid)
  }

  getBatteryStatus(): Promise<BatteryInfoDto> {
    return this.run('getBatteryStatus', async () => {
      const battery = await this.client.info.getBatteryStatus()
      return mapping(() => mapBatteryInfo(battery))
    })
  }

  requestPairingCode(request: PairingCodeRequest): Promise<string> {
    return this.run('requestPairingCode', () =>
      this.client.requestPairingCode(
        request.phoneNumber,
        request.showNotification,
        request.intervalMs
      )
    )
  }

  cancelPairingCode(): Promise<void> {
    return this.run('cancelPairingCode', () => this.client.cancelPairingCode())
  }

  // ---- Presence and profile --------------------------------------------------------------------

  sendPresenceAvailable(): Promise<void> {
    return this.run('sendPresenceAvailable', () => this.client.sendPresenceAvailable())
  }

  sendPresenceUnavailable(): Promise<void> {
    return this.run('sendPresenceUnavailable', () => this.client.sendPresenceUnavailable())
  }

  setStatus(status: string): Promise<void> {
    return this.run('setStatus', () => this.client.setStatus(status))
  }

  setDisplayName(displayName: string): Promise<boolean> {
    return this.run('setDisplayName', () => this.client.setDisplayName(displayName))
  }

  setProfilePicture(media: OutboundMedia): Promise<boolean> {
    return this.run('setProfilePicture', async () =>
      this.client.setProfilePicture(await this.media(media))
    )
  }

  deleteProfilePicture(): Promise<boolean> {
    return this.run('deleteProfilePicture', () => this.client.deleteProfilePicture())
  }

  setAutoDownloadAudio(flag: boolean): Promise<void> {
    return this.run('setAutoDownloadAudio', () => this.client.setAutoDownloadAudio(flag))
  }

  setAutoDownloadDocuments(flag: boolean): Promise<void> {
    return this.run('setAutoDownloadDocuments', () => this.client.setAutoDownloadDocuments(flag))
  }

  setAutoDownloadPhotos(flag: boolean): Promise<void> {
    return this.run('setAutoDownloadPhotos', () => this.client.setAutoDownloadPhotos(flag))
  }

  setAutoDownloadVideos(flag: boolean): Promise<void> {
    return this.run('setAutoDownloadVideos', () => this.client.setAutoDownloadVideos(flag))
  }

  setBackgroundSync(flag: boolean): Promise<void> {
    return this.run('setBackgroundSync', () => this.client.setBackgroundSync(flag))
  }

  // ---- Messages --------------------------------------------------------------------------------

  sendMessage(
    chatId: string,
    content: OutboundContent,
    options?: SendOptions
  ): Promise<MessageDto> {
    return this.run('sendMessage', async () =>
      this.sent(
        'sendMessage',
        await this.client.sendMessage(
          chatId,
          await this.toContent(content),
          this.toSendOptions(options)
        ),
        chatId
      )
    )
  }

  sendChannelMessage(
    channelId: string,
    content: Extract<OutboundContent, { type: 'text' | 'media' }>,
    options?: ChannelSendOptions
  ): Promise<MessageDto> {
    return this.run('sendChannelMessage', async () => {
      const channel = await this.channelById('sendChannelMessage', channelId)
      const body = content.type === 'text' ? content.body : await this.media(content.media)
      return this.sent(
        'sendChannelMessage',
        await channel.sendMessage(body, { ...options }),
        channelId
      )
    })
  }

  sendReaction(messageId: string, reaction: string): Promise<void> {
    return this.run('sendReaction', () => this.client.sendReaction(messageId, reaction))
  }

  getMessageById(messageId: string): Promise<MessageDto | null> {
    return this.run('getMessageById', async () => {
      const found: Message | null | undefined = await this.client.getMessageById(messageId)
      return found ? this.message(found) : null
    })
  }

  searchMessages(query: string, options?: SearchMessagesOptions): Promise<MessageDto[]> {
    return this.run('searchMessages', async () =>
      this.messages(await this.client.searchMessages(query, options))
    )
  }

  fetchMessages(chatId: string, options?: FetchMessagesOptions): Promise<MessageDto[]> {
    return this.run('fetchMessages', async () => {
      const chat = await this.chatById('fetchMessages', chatId)
      return this.messages(await chat.fetchMessages({ ...options }))
    })
  }

  getPinnedMessages(chatId: string): Promise<MessageDto[]> {
    return this.run('getPinnedMessages', async () =>
      this.messages(await this.client.getPinnedMessages(chatId))
    )
  }

  revokeStatusMessage(messageId: string): Promise<void> {
    return this.run('revokeStatusMessage', () => this.client.revokeStatusMessage(messageId))
  }

  reloadMessage(messageId: string): Promise<MessageDto> {
    return this.run('reloadMessage', async () => {
      const message = await this.messageById('reloadMessage', messageId)
      return this.message(await message.reload())
    })
  }

  replyToMessage(
    messageId: string,
    content: OutboundContent,
    chatId?: string,
    options?: SendOptions
  ): Promise<MessageDto> {
    return this.run('replyToMessage', async () => {
      const message = await this.messageById('replyToMessage', messageId)
      const reply = await message.reply(
        await this.toContent(content),
        chatId,
        this.toSendOptions(options)
      )
      return this.sent('replyToMessage', reply)
    })
  }

  forwardMessage(messageId: string, chatId: string): Promise<void> {
    return this.run('forwardMessage', async () => {
      const message = await this.messageById('forwardMessage', messageId)
      await message.forward(chatId)
    })
  }

  editMessage(
    messageId: string,
    content: Extract<OutboundContent, { type: 'text' }>,
    options?: EditOptions
  ): Promise<MessageDto | null> {
    return this.run('editMessage', async () => {
      const message = await this.messageById('editMessage', messageId)
      const edited = await message.edit(content.body, { ...options })
      return edited ? this.message(edited) : null
    })
  }

  editScheduledEvent(
    messageId: string,
    event: Extract<OutboundContent, { type: 'event' }>
  ): Promise<MessageDto | null> {
    return this.run('editScheduledEvent', async () => {
      const message = await this.messageById('editScheduledEvent', messageId)
      // The typings of wwebjs 1.34.8 ask for the DOM `Event`; the method reads a ScheduledEvent
      const scheduled = this.toEvent(event) as unknown as Parameters<
        Message['editScheduledEvent']
      >[0]
      const edited = await message.editScheduledEvent(scheduled)
      return edited ? this.message(edited) : null
    })
  }

  deleteMessage(messageId: string, everyone?: boolean, clearMedia?: boolean): Promise<void> {
    return this.run('deleteMessage', async () => {
      const message = await this.messageById('deleteMessage', messageId)
      await message.delete(everyone, clearMedia)
    })
  }

  starMessage(messageId: string): Promise<void> {
    return this.run('starMessage', async () => {
      await (await this.messageById('starMessage', messageId)).star()
    })
  }

  unstarMessage(messageId: string): Promise<void> {
    return this.run('unstarMessage', async () => {
      await (await this.messageById('unstarMessage', messageId)).unstar()
    })
  }

  pinMessage(messageId: string, durationSeconds: number): Promise<boolean> {
    return this.run('pinMessage', async () =>
      (await this.messageById('pinMessage', messageId)).pin(durationSeconds)
    )
  }

  unpinMessage(messageId: string): Promise<boolean> {
    return this.run('unpinMessage', async () =>
      (await this.messageById('unpinMessage', messageId)).unpin()
    )
  }

  downloadMedia(messageId: string): Promise<DownloadedMedia | null> {
    return this.run('downloadMedia', async () => {
      const message = await this.messageById('downloadMedia', messageId)
      // wwebjs answers undefined when the media is gone from the phone
      const media: Awaited<ReturnType<Message['downloadMedia']>> | undefined =
        await message.downloadMedia()
      if (!media) return null
      return {
        mimetype: media.mimetype,
        data: media.data,
        filename: media.filename,
        filesize: media.filesize
      }
    })
  }

  getMessageChat(messageId: string): Promise<AnyChatDto> {
    return this.run('getMessageChat', async () =>
      this.anyChat(await (await this.messageById('getMessageChat', messageId)).getChat())
    )
  }

  getMessageContact(messageId: string): Promise<AnyContactDto> {
    return this.run('getMessageContact', async () =>
      this.contactDto(await (await this.messageById('getMessageContact', messageId)).getContact())
    )
  }

  getMessageMentions(messageId: string): Promise<AnyContactDto[]> {
    return this.run('getMessageMentions', async () =>
      this.contactDtos(
        await (await this.messageById('getMessageMentions', messageId)).getMentions()
      )
    )
  }

  getMessageGroupMentions(messageId: string): Promise<GroupChatDto[]> {
    return this.run('getMessageGroupMentions', async () => {
      const message = await this.messageById('getMessageGroupMentions', messageId)
      return (await message.getGroupMentions()).map(group => this.groupChatDto(group))
    })
  }

  getQuotedMessage(messageId: string): Promise<MessageDto | null> {
    return this.run('getQuotedMessage', async () => {
      const message = await this.messageById('getQuotedMessage', messageId)
      const quoted: Message | null | undefined = await message.getQuotedMessage()
      return quoted ? this.message(quoted) : null
    })
  }

  getMessageInfo(messageId: string): Promise<MessageInfoDto | null> {
    return this.run('getMessageInfo', async () => {
      const info = await (await this.messageById('getMessageInfo', messageId)).getInfo()
      return mapping(() => (info ? mapMessageInfo(info) : null))
    })
  }

  getMessageOrder(messageId: string): Promise<OrderDto | null> {
    return this.run('getMessageOrder', async () => {
      const order = await (await this.messageById('getMessageOrder', messageId)).getOrder()
      // wwebjs answers undefined for a message that is not an order
      return mapping(() => (order ? mapOrder(order) : null))
    })
  }

  getMessagePayment(messageId: string): Promise<PaymentDto | null> {
    return this.run('getMessagePayment', async () => {
      const payment = await (await this.messageById('getMessagePayment', messageId)).getPayment()
      // wwebjs answers undefined for a message that is not a payment
      if (!payment) return null
      return mapping(() =>
        mapPayment({
          ...payment,
          id: toIdLike(payment.id),
          paymentMessageReceiverJid: toIdLikeOrNull(payment.paymentMessageReceiverJid)
        })
      )
    })
  }

  getMessageReactions(messageId: string): Promise<ReactionListDto[]> {
    return this.run('getMessageReactions', async () => {
      const message = await this.messageById('getMessageReactions', messageId)
      // wwebjs answers undefined, not an empty list, for a message nobody reacted to
      const reactions: unknown = await message.getReactions()
      if (!Array.isArray(reactions)) return []
      // An item the mapper cannot read is left out and counted, never logged: one odd reaction must
      // not turn the whole answer into a failure
      const mapped: ReactionListDto[] = []
      let skipped = 0
      for (const item of reactions as unknown[]) {
        try {
          mapped.push(mapReactionList(item as Parameters<typeof mapReactionList>[0]))
        } catch {
          skipped += 1
        }
      }
      if (skipped > 0) {
        this.logger.warn(`getMessageReactions left out ${skipped} item(s) it could not map`)
      }
      return mapped
    })
  }

  getPollVotes(messageId: string): Promise<PollVoteDto[]> {
    return this.run('getPollVotes', async () => {
      const votes = await this.client.getPollVotes(messageId)
      return mapping(() => votes.map(mapPollVote))
    })
  }

  vote(messageId: string, selectedOptions: string[]): Promise<void> {
    return this.run('vote', async () => {
      await (await this.messageById('vote', messageId)).vote(selectedOptions)
    })
  }

  sendResponseToScheduledEvent(response: number, eventMessageId: string): Promise<boolean> {
    return this.run('sendResponseToScheduledEvent', () =>
      this.client.sendResponseToScheduledEvent(response, eventMessageId)
    )
  }

  acceptGroupV4Invite(invite: InviteV4Dto): Promise<{ status: number }> {
    return this.run('acceptGroupV4Invite', () => this.client.acceptGroupV4Invite(invite))
  }

  // ---- Chats -----------------------------------------------------------------------------------

  getChats(): Promise<AnyChatDto[]> {
    return this.run('getChats', async () => this.chatDtos(await this.client.getChats()))
  }

  getChatById(chatId: string): Promise<AnyChatDto> {
    return this.run('getChatById', async () =>
      this.anyChat(await this.chatById('getChatById', chatId))
    )
  }

  sendSeen(chatId: string): Promise<boolean> {
    return this.run('sendSeen', () => this.client.sendSeen(chatId))
  }

  sendChatState(chatId: string, state: ChatStateKind): Promise<void> {
    return this.run('sendChatState', async () => {
      const chat = await this.chatById('sendChatState', chatId)
      if (isChannel(chat))
        throw new WaOperationError('sendChatState', 'A channel has no chat state')
      if (state === 'typing') await chat.sendStateTyping()
      else if (state === 'recording') await chat.sendStateRecording()
      else await chat.clearState()
    })
  }

  markChatUnread(chatId: string): Promise<void> {
    return this.run('markChatUnread', () => this.client.markChatUnread(chatId))
  }

  archiveChat(chatId: string): Promise<boolean> {
    return this.run('archiveChat', () => this.client.archiveChat(chatId))
  }

  unarchiveChat(chatId: string): Promise<boolean> {
    return this.run('unarchiveChat', () => this.client.unarchiveChat(chatId))
  }

  pinChat(chatId: string): Promise<boolean> {
    return this.run('pinChat', () => this.client.pinChat(chatId))
  }

  unpinChat(chatId: string): Promise<boolean> {
    return this.run('unpinChat', () => this.client.unpinChat(chatId))
  }

  muteChat(chatId: string, unmuteDate?: Date): Promise<MuteResult> {
    return this.run('muteChat', () => this.client.muteChat(chatId, unmuteDate))
  }

  unmuteChat(chatId: string): Promise<MuteResult> {
    return this.run('unmuteChat', () => this.client.unmuteChat(chatId))
  }

  clearChatMessages(chatId: string): Promise<boolean> {
    return this.run('clearChatMessages', async () => {
      const chat = await this.chatById('clearChatMessages', chatId)
      if (isChannel(chat))
        throw new WaOperationError('clearChatMessages', 'A channel has no history')
      return chat.clearMessages()
    })
  }

  deleteChat(chatId: string): Promise<boolean> {
    return this.run('deleteChat', async () => {
      const chat = await this.chatById('deleteChat', chatId)
      if (isChannel(chat))
        throw new WaOperationError('deleteChat', 'Use deleteChannel for a channel')
      return chat.delete()
    })
  }

  syncHistory(chatId: string): Promise<boolean> {
    return this.run('syncHistory', () => this.client.syncHistory(chatId))
  }

  addOrEditCustomerNote(userId: string, note: string): Promise<void> {
    return this.run('addOrEditCustomerNote', () => this.client.addOrEditCustomerNote(userId, note))
  }

  getCustomerNote(userId: string): Promise<CustomerNote | null> {
    return this.run('getCustomerNote', async () => {
      const note = await this.client.getCustomerNote(userId)
      return note ? mapping(() => mapCustomerNote(note)) : null
    })
  }

  // ---- Contacts and numbers --------------------------------------------------------------------

  getContacts(): Promise<AnyContactDto[]> {
    return this.run('getContacts', async () => this.contactDtos(await this.client.getContacts()))
  }

  getContactById(contactId: string): Promise<AnyContactDto> {
    return this.run('getContactById', async () =>
      this.contactDto(await this.client.getContactById(contactId))
    )
  }

  getBlockedContacts(): Promise<AnyContactDto[]> {
    return this.run('getBlockedContacts', async () =>
      this.contactDtos(await this.client.getBlockedContacts())
    )
  }

  blockContact(contactId: string): Promise<boolean> {
    return this.run('blockContact', async () =>
      (await this.client.getContactById(contactId)).block()
    )
  }

  unblockContact(contactId: string): Promise<boolean> {
    return this.run('unblockContact', async () =>
      (await this.client.getContactById(contactId)).unblock()
    )
  }

  getContactAbout(contactId: string): Promise<string | null> {
    return this.run('getContactAbout', async () => {
      const about = await (await this.client.getContactById(contactId)).getAbout()
      return about ?? null
    })
  }

  getProfilePicUrl(contactId: string): Promise<string | null> {
    return this.run('getProfilePicUrl', async () => {
      // undefined when the privacy settings of the contact do not allow it
      const url: string | null | undefined = await this.client.getProfilePicUrl(contactId)
      return url ?? null
    })
  }

  getCommonGroups(contactId: string): Promise<string[]> {
    return this.run('getCommonGroups', async () =>
      (await this.client.getCommonGroups(contactId)).map(group => group._serialized)
    )
  }

  getContactDeviceCount(userId: string): Promise<number> {
    return this.run('getContactDeviceCount', () => this.client.getContactDeviceCount(userId))
  }

  getContactBroadcast(contactId: string): Promise<BroadcastDto | null> {
    return this.run('getContactBroadcast', async () =>
      this.broadcastDto(await (await this.client.getContactById(contactId)).getBroadcast())
    )
  }

  getContactChat(contactId: string): Promise<AnyChatDto> {
    return this.run('getContactChat', async () =>
      this.anyChat(await (await this.client.getContactById(contactId)).getChat())
    )
  }

  getContactLidAndPhone(userIds: string[]): Promise<LidAndPhone[]> {
    return this.run('getContactLidAndPhone', () => this.client.getContactLidAndPhone(userIds))
  }

  saveOrEditAddressbookContact(
    phoneNumber: string,
    firstName: string,
    lastName: string,
    syncToAddressbook?: boolean
  ): Promise<void> {
    return this.run('saveOrEditAddressbookContact', () =>
      this.client.saveOrEditAddressbookContact(phoneNumber, firstName, lastName, syncToAddressbook)
    )
  }

  deleteAddressbookContact(phoneNumber: string): Promise<void> {
    return this.run('deleteAddressbookContact', () =>
      this.client.deleteAddressbookContact(phoneNumber)
    )
  }

  isRegisteredUser(contactId: string): Promise<boolean> {
    return this.run('isRegisteredUser', () => this.client.isRegisteredUser(contactId))
  }

  getNumberId(number: string): Promise<string | null> {
    return this.run('getNumberId', async () => {
      const id = await this.client.getNumberId(number)
      return id ? id._serialized : null
    })
  }

  getCountryCode(number: string): Promise<string> {
    return this.run('getCountryCode', () => this.client.getCountryCode(number))
  }

  getFormattedNumber(number: string): Promise<string> {
    return this.run('getFormattedNumber', () => this.client.getFormattedNumber(number))
  }

  // ---- Groups ----------------------------------------------------------------------------------

  createGroup(
    title: string,
    participantIds: string[],
    options?: CreateGroupOptions
  ): Promise<CreateGroupResult | string> {
    return this.run('createGroup', async () => {
      const result = await this.client.createGroup(title, participantIds, { ...options })
      if (typeof result === 'string') return this.refusedReason('createGroup', result, [title])
      return {
        title: result.title,
        gid: result.gid._serialized,
        participants: this.outcomes('createGroup', 'statusCode', result.participants)
      }
    })
  }

  addParticipants(
    groupId: string,
    participantIds: string[],
    options?: AddParticipantsOptions
  ): Promise<AddParticipantsResult> {
    return this.run('addParticipants', async () => {
      const group = await this.groupById('addParticipants', groupId)
      const result: unknown = await group.addParticipants(participantIds, { ...options })
      return typeof result === 'string'
        ? this.refusedReason('addParticipants', result)
        : this.outcomes('addParticipants', 'code', result)
    })
  }

  removeParticipants(groupId: string, participantIds: string[]): Promise<{ status: number }> {
    return this.run('removeParticipants', async () =>
      (await this.groupById('removeParticipants', groupId)).removeParticipants(participantIds)
    )
  }

  promoteParticipants(groupId: string, participantIds: string[]): Promise<{ status: number }> {
    return this.run('promoteParticipants', async () =>
      (await this.groupById('promoteParticipants', groupId)).promoteParticipants(participantIds)
    )
  }

  demoteParticipants(groupId: string, participantIds: string[]): Promise<{ status: number }> {
    return this.run('demoteParticipants', async () =>
      (await this.groupById('demoteParticipants', groupId)).demoteParticipants(participantIds)
    )
  }

  setGroupSubject(groupId: string, subject: string): Promise<boolean> {
    return this.run('setGroupSubject', async () =>
      (await this.groupById('setGroupSubject', groupId)).setSubject(subject)
    )
  }

  setGroupDescription(groupId: string, description: string): Promise<boolean> {
    return this.run('setGroupDescription', async () =>
      (await this.groupById('setGroupDescription', groupId)).setDescription(description)
    )
  }

  setAddMembersAdminsOnly(groupId: string, adminsOnly?: boolean): Promise<boolean> {
    return this.run('setAddMembersAdminsOnly', async () =>
      (await this.groupById('setAddMembersAdminsOnly', groupId)).setAddMembersAdminsOnly(adminsOnly)
    )
  }

  setMessagesAdminsOnly(groupId: string, adminsOnly?: boolean): Promise<boolean> {
    return this.run('setMessagesAdminsOnly', async () =>
      (await this.groupById('setMessagesAdminsOnly', groupId)).setMessagesAdminsOnly(adminsOnly)
    )
  }

  setInfoAdminsOnly(groupId: string, adminsOnly?: boolean): Promise<boolean> {
    return this.run('setInfoAdminsOnly', async () =>
      (await this.groupById('setInfoAdminsOnly', groupId)).setInfoAdminsOnly(adminsOnly)
    )
  }

  getGroupInviteCode(groupId: string): Promise<string> {
    return this.run('getGroupInviteCode', async () =>
      (await this.groupById('getGroupInviteCode', groupId)).getInviteCode()
    )
  }

  revokeGroupInvite(groupId: string): Promise<void> {
    return this.run('revokeGroupInvite', async () =>
      (await this.groupById('revokeGroupInvite', groupId)).revokeInvite()
    )
  }

  leaveGroup(groupId: string): Promise<void> {
    return this.run('leaveGroup', async () => (await this.groupById('leaveGroup', groupId)).leave())
  }

  setGroupPicture(groupId: string, media: OutboundMedia): Promise<boolean> {
    return this.run('setGroupPicture', async () =>
      (await this.groupById('setGroupPicture', groupId)).setPicture(await this.media(media))
    )
  }

  deleteGroupPicture(groupId: string): Promise<boolean> {
    return this.run('deleteGroupPicture', async () =>
      (await this.groupById('deleteGroupPicture', groupId)).deletePicture()
    )
  }

  getGroupMembershipRequests(groupId: string): Promise<MembershipRequestDto[]> {
    return this.run('getGroupMembershipRequests', async () => {
      const requests = await this.client.getGroupMembershipRequests(groupId)
      return mapping(() =>
        requests.map(request =>
          mapMembershipRequest({
            id: toIdLike(request.id),
            addedBy: toIdLikeOrNull(request.addedBy),
            parentGroupId: toIdLikeOrNull(request.parentGroupId),
            requestMethod: request.requestMethod,
            t: request.t
          })
        )
      )
    })
  }

  approveGroupMembershipRequests(
    groupId: string,
    options: MembershipRequestActionOptions
  ): Promise<MembershipRequestActionResult[]> {
    return this.run('approveGroupMembershipRequests', () =>
      this.client.approveGroupMembershipRequests(groupId, this.requestAction(options))
    )
  }

  rejectGroupMembershipRequests(
    groupId: string,
    options: MembershipRequestActionOptions
  ): Promise<MembershipRequestActionResult[]> {
    return this.run('rejectGroupMembershipRequests', () =>
      this.client.rejectGroupMembershipRequests(groupId, this.requestAction(options))
    )
  }

  // wwebjs requires both keys; null means "every request" and "no pause"
  private requestAction(
    options: MembershipRequestActionOptions
  ): Parameters<typeof this.client.approveGroupMembershipRequests>[1] {
    // wwebjs types both keys as required but defaults them when they are undefined (`sleep` to a
    // 250-500 ms pause per request); null would switch the pause off
    return {
      requesterIds: options.requesterIds ?? null,
      sleep: options.sleep
    } as Parameters<typeof this.client.approveGroupMembershipRequests>[1]
  }

  acceptInvite(inviteCode: string): Promise<string> {
    return this.run('acceptInvite', () => this.client.acceptInvite(inviteCode))
  }

  getInviteInfo(inviteCode: string): Promise<Record<string, unknown>> {
    return this.run('getInviteInfo', async () => {
      const info = await this.client.getInviteInfo(inviteCode)
      return sanitizeRaw(info, this.config.RAW_MAX_FIELD_BYTES) ?? {}
    })
  }

  // ---- Channels --------------------------------------------------------------------------------

  getChannels(): Promise<ChannelDto[]> {
    return this.run('getChannels', async () => this.channelDtos(await this.client.getChannels()))
  }

  getChannelByInviteCode(inviteCode: string): Promise<ChannelDto> {
    return this.run('getChannelByInviteCode', async () =>
      this.channelDto(await this.client.getChannelByInviteCode(inviteCode))
    )
  }

  searchChannels(options: SearchChannelsOptions): Promise<ChannelDto[]> {
    return this.run('searchChannels', async () =>
      this.channelDtos(await this.client.searchChannels({ ...options }))
    )
  }

  createChannel(
    title: string,
    options?: CreateChannelOptions
  ): Promise<CreateChannelResult | string> {
    return this.run('createChannel', async () => {
      const picture = options?.picture ? await this.media(options.picture) : undefined
      const result = await this.client.createChannel(title, {
        description: options?.description,
        picture
      })
      if (typeof result === 'string') {
        return this.refusedReason('createChannel', result, [title, options?.description ?? ''])
      }
      return {
        title: result.title,
        nid: result.nid._serialized,
        inviteLink: result.inviteLink,
        createdAtTs: result.createdAtTs
      }
    })
  }

  deleteChannel(channelId: string): Promise<boolean> {
    return this.run('deleteChannel', () => this.client.deleteChannel(channelId))
  }

  subscribeToChannel(channelId: string): Promise<boolean> {
    return this.run('subscribeToChannel', () => this.client.subscribeToChannel(channelId))
  }

  unsubscribeFromChannel(channelId: string, options?: UnsubscribeOptions): Promise<boolean> {
    return this.run('unsubscribeFromChannel', () =>
      this.client.unsubscribeFromChannel(channelId, { ...options })
    )
  }

  getChannelSubscribers(channelId: string, limit?: number): Promise<ChannelSubscriber[]> {
    return this.run('getChannelSubscribers', async () => {
      const channel = await this.channelById('getChannelSubscribers', channelId)
      return (await channel.getSubscribers(limit)).map(({ contact, role }) => ({
        contact: this.contactDto(contact),
        role
      }))
    })
  }

  setChannelSubject(channelId: string, subject: string): Promise<boolean> {
    return this.run('setChannelSubject', async () =>
      (await this.channelById('setChannelSubject', channelId)).setSubject(subject)
    )
  }

  setChannelDescription(channelId: string, description: string): Promise<boolean> {
    return this.run('setChannelDescription', async () =>
      (await this.channelById('setChannelDescription', channelId)).setDescription(description)
    )
  }

  setChannelProfilePicture(channelId: string, media: OutboundMedia): Promise<boolean> {
    return this.run('setChannelProfilePicture', async () =>
      (await this.channelById('setChannelProfilePicture', channelId)).setProfilePicture(
        await this.media(media)
      )
    )
  }

  setChannelReactionSetting(channelId: string, reactionCode: number): Promise<boolean> {
    return this.run('setChannelReactionSetting', async () =>
      (await this.channelById('setChannelReactionSetting', channelId)).setReactionSetting(
        reactionCode
      )
    )
  }

  muteChannel(channelId: string): Promise<boolean> {
    return this.run('muteChannel', async () =>
      (await this.channelById('muteChannel', channelId)).mute()
    )
  }

  unmuteChannel(channelId: string): Promise<boolean> {
    return this.run('unmuteChannel', async () =>
      (await this.channelById('unmuteChannel', channelId)).unmute()
    )
  }

  fetchChannelMessages(channelId: string, options?: FetchMessagesOptions): Promise<MessageDto[]> {
    return this.run('fetchChannelMessages', async () => {
      const channel = await this.channelById('fetchChannelMessages', channelId)
      return this.messages(await channel.fetchMessages({ ...options }))
    })
  }

  sendChannelAdminInvite(
    chatId: string,
    channelId: string,
    options?: { comment?: string }
  ): Promise<boolean> {
    return this.run('sendChannelAdminInvite', () =>
      this.client.sendChannelAdminInvite(chatId, channelId, options)
    )
  }

  acceptChannelAdminInvite(channelId: string): Promise<boolean> {
    return this.run('acceptChannelAdminInvite', () =>
      this.client.acceptChannelAdminInvite(channelId)
    )
  }

  revokeChannelAdminInvite(channelId: string, userId: string): Promise<boolean> {
    return this.run('revokeChannelAdminInvite', () =>
      this.client.revokeChannelAdminInvite(channelId, userId)
    )
  }

  demoteChannelAdmin(channelId: string, userId: string): Promise<boolean> {
    return this.run('demoteChannelAdmin', () => this.client.demoteChannelAdmin(channelId, userId))
  }

  transferChannelOwnership(
    channelId: string,
    newOwnerId: string,
    options?: TransferChannelOwnershipOptions
  ): Promise<boolean> {
    return this.run('transferChannelOwnership', () =>
      this.client.transferChannelOwnership(channelId, newOwnerId, { ...options })
    )
  }

  // ---- Labels, broadcasts and calls ------------------------------------------------------------

  getLabels(): Promise<LabelDto[]> {
    return this.run('getLabels', async () => {
      const labels = await this.client.getLabels()
      return this.labelDtos(labels)
    })
  }

  getLabelById(labelId: string): Promise<LabelDto> {
    return this.run('getLabelById', async () => {
      const label = await this.client.getLabelById(labelId)
      return mapping(() => mapLabel(label))
    })
  }

  getChatLabels(chatId: string): Promise<LabelDto[]> {
    return this.run('getChatLabels', async () => {
      const labels = await this.client.getChatLabels(chatId)
      return this.labelDtos(labels)
    })
  }

  getChatsByLabelId(labelId: string): Promise<AnyChatDto[]> {
    return this.run('getChatsByLabelId', async () =>
      this.chatDtos(await this.client.getChatsByLabelId(labelId))
    )
  }

  addOrRemoveLabels(labelIds: (number | string)[], chatIds: string[]): Promise<void> {
    return this.run('addOrRemoveLabels', () => this.client.addOrRemoveLabels(labelIds, chatIds))
  }

  getBroadcasts(): Promise<BroadcastDto[]> {
    return this.run('getBroadcasts', async () =>
      this.broadcastDtos(await this.client.getBroadcasts())
    )
  }

  getBroadcastById(contactId: string): Promise<BroadcastDto | null> {
    return this.run('getBroadcastById', async () =>
      this.broadcastDto(await this.client.getBroadcastById(contactId))
    )
  }

  // The library answers an empty string when the page could not make the link
  createCallLink(startTime: Date, callType: string): Promise<string> {
    return this.run('createCallLink', async () => {
      const link = await this.client.createCallLink(startTime, callType)
      if (typeof link !== 'string' || link === '')
        throw new WaOperationError('createCallLink', 'No link was made')
      return link
    })
  }

  // wwebjs only rejects through the `Call` it handed out with the `call` event: `not_held` when this
  // adapter does not have it (too old for the ring buffer, already rejected, or never seen). The
  // patched page answers what it saw after the reject (see `RejectCallResult`); an answer that is
  // not that, such as `undefined` from a library without the patch, is `unconfirmed`.
  rejectCall(callId: string): Promise<RejectCallResult> {
    return this.run('rejectCall', async () => {
      const call = this.calls.get(callId)
      if (!call) return 'not_held'
      // Taken out first so that a second request for the same call finds nothing while this one is in
      // flight; put back when the page failed, so that the call can be rejected again
      this.calls.delete(callId)
      let answer: unknown
      try {
        answer = await call.reject()
      } catch (error: unknown) {
        if (!this.calls.has(callId)) this.calls.set(callId, call)
        throw error
      }
      return rejectResultOf(answer)
    })
  }
}

// The page answers `{ result: 'gone' }` or `{ result: 'rejected', confirmed }`
function rejectResultOf(answer: unknown): RejectCallResult {
  if (typeof answer !== 'object' || answer === null) return 'unconfirmed'
  const { result, confirmed } = answer as { result?: unknown; confirmed?: unknown }
  if (result === 'gone') return 'gone'
  return result === 'rejected' && confirmed === true ? 'confirmed' : 'unconfirmed'
}

// ---- Factory -----------------------------------------------------------------------------------

export function createWwebjsClientFactory(config: WwebjsAdapterConfig): WhatsAppClientFactory {
  return (sessionId, options) =>
    new WwebjsAdapter(sessionId, new Client(buildClientOptions(config, sessionId, options)), config)
}

// Lets the process guard tell a Puppeteer failure from a bug of ours (TDD §6.14)
export { isPuppeteerFailure }
