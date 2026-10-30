import type { MessageDto } from '../../src/types/dto.js'
import {
  WaDisconnectedError,
  type WaOperationError,
  type WaTimeoutError
} from '../../src/whatsapp/wa-errors.js'
import type {
  ClientEvent,
  ClientEventListener,
  OutboundContent,
  WhatsAppClientFactory,
  WhatsAppClientOptions,
  WhatsAppClientPort
} from '../../src/whatsapp/whatsapp-client.port.js'

type PortMethod = Exclude<keyof WhatsAppClientPort, 'onEvent'>
type Args<K extends PortMethod> = Parameters<WhatsAppClientPort[K]>
type Result<K extends PortMethod> = Awaited<ReturnType<WhatsAppClientPort[K]>>

// What a test plugs in with `script()`: it receives the arguments and answers like WhatsApp would
export type FakeScript<K extends PortMethod> = (...args: Args<K>) => Result<K> | Promise<Result<K>>
type Scripts = { [K in PortMethod]?: FakeScript<K> }

export interface FakeCall {
  method: PortMethod
  args: unknown[]
}

// Raised by a method that returns a DTO nobody scripted: inventing a chat or a contact would hide
// the test that forgot to say what the session should see
export class FakeNotScriptedError extends Error {
  constructor(readonly method: string) {
    super(`FakeWhatsAppClient.${method} has no script: call script('${method}', ...) first`)
    this.name = 'FakeNotScriptedError'
  }
}

// Calls that work while the browser is down (they are how the session comes back or goes away)
const WORKS_WHEN_DISCONNECTED: ReadonlySet<PortMethod> = new Set([
  'initialize',
  'destroy',
  'logout',
  'resetState',
  'getState',
  'getWWebVersion',
  'requestPairingCode',
  'cancelPairingCode'
])

const FAKE_SELF_ID = '5215500000001@c.us'
const FAKE_PEER_ID = '5215500000002@c.us'
const FAKE_SENT_AT = '2026-01-01T00:00:00.000Z'
const FAKE_TIMESTAMP = 1_767_225_600

export function buildMessageDto(overrides: Partial<MessageDto> = {}): MessageDto {
  return {
    id: `true_${FAKE_SELF_ID}_FAKE0000000000000000`,
    chatId: FAKE_PEER_ID,
    sentAt: FAKE_SENT_AT,
    receivedAt: FAKE_SENT_AT,
    ack: 1,
    deviceType: 'android',
    body: '',
    broadcast: false,
    isStatus: false,
    isGif: false,
    isEphemeral: false,
    from: FAKE_SELF_ID,
    fromMe: true,
    hasMedia: false,
    hasQuotedMsg: false,
    hasReaction: false,
    isForwarded: false,
    forwardingScore: 0,
    isStarred: false,
    vCards: [],
    mentionedIds: [],
    groupMentions: [],
    timestamp: FAKE_TIMESTAMP,
    to: FAKE_PEER_ID,
    type: 'chat',
    links: [],
    ...overrides
  }
}

// An in-memory WhatsAppClientPort for every test above the adapter. Every method records its call,
// then (1) rejects with `WaDisconnectedError` while the client is disconnected, (2) rejects with the
// next error queued by `failNext`, (3) answers with the `script` of the test, or (4) answers with a
// default: `true` for flags, an empty list for lists, `null` for lookups, a plausible message for
// sends. Methods that return a DTO a test must describe (chats, contacts, groups, ...) throw
// `FakeNotScriptedError` (not a Wa* error, so it fails loudly) instead of inventing one.
//
// Limits, on purpose: `failNext` takes only the errors the port allows, while a `script` may throw
// anything. A `script` replaces the whole default, side effects included (a scripted `initialize`
// does not reconnect, a scripted send does not fill `sent`). `emit` plays the part of the browser
// but does not change the connection: emitting `disconnected` needs `disconnect()` as well. A
// failure queued while disconnected is kept until after `reconnect()`. Placeholders: `getCountryCode`
// takes two digits, `getNumberId` finds every number, and only text and media sends come back with
// a matching `type` (the others are `chat`).
export class FakeWhatsAppClient implements WhatsAppClientPort {
  readonly calls: FakeCall[] = []
  // Errors thrown by listeners; the port promises a failing listener never reaches the emitter
  readonly listenerErrors: unknown[] = []
  readonly sent: MessageDto[] = []
  private connected = true
  private readonly listeners = new Set<ClientEventListener>()
  private readonly scripts: Scripts = {}
  private readonly failures = new Map<
    PortMethod,
    (WaDisconnectedError | WaTimeoutError | WaOperationError)[]
  >()
  private messageCounter = 0

  constructor(
    readonly sessionId = 'fake-session',
    readonly options: WhatsAppClientOptions = {}
  ) {}

  // ---- Test controls ---------------------------------------------------------------------------

  script<K extends PortMethod>(method: K, handler: FakeScript<K>): this {
    this.scripts[method] = handler as Scripts[K]
    return this
  }

  // Back to the default answer of `method`
  unscript(method: PortMethod): this {
    delete this.scripts[method]
    return this
  }

  // The next `times` calls of `method` reject with `error`, then it goes back to normal
  failNext(
    method: PortMethod,
    error: WaDisconnectedError | WaTimeoutError | WaOperationError,
    times = 1
  ): this {
    const queue = this.failures.get(method) ?? []
    for (let n = 0; n < times; n++) queue.push(error)
    this.failures.set(method, queue)
    return this
  }

  // The browser died: everything but the lifecycle calls rejects with WaDisconnectedError
  disconnect(): this {
    this.connected = false
    return this
  }

  reconnect(): this {
    this.connected = true
    return this
  }

  emit(event: ClientEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (error: unknown) {
        this.listenerErrors.push(error)
      }
    }
  }

  get listenerCount(): number {
    return this.listeners.size
  }

  callsOf(method: PortMethod): FakeCall[] {
    return this.calls.filter(call => call.method === method)
  }

  // ---- Lifecycle -------------------------------------------------------------------------------

  readonly initialize = this.stub('initialize', () => {
    this.connected = true
  })
  readonly destroy = this.stub('destroy', () => {
    this.connected = false
  })
  readonly logout = this.stub('logout', () => {
    this.connected = false
  })
  readonly resetState = this.stub('resetState', () => undefined)
  readonly getState = this.stub('getState', () => (this.connected ? 'CONNECTED' : null))
  readonly getWWebVersion = this.stub('getWWebVersion', () => '2.3000.0')
  readonly getClientInfo = this.stub('getClientInfo', () => ({
    wid: FAKE_SELF_ID,
    me: FAKE_SELF_ID,
    platform: 'android',
    pushname: 'Fake'
  }))
  readonly getBrowserMemoryBytes = this.stub('getBrowserMemoryBytes', () => 100 * 1024 * 1024)
  readonly getBatteryStatus = this.stub('getBatteryStatus', () => ({ battery: 100, plugged: true }))
  readonly requestPairingCode = this.stub('requestPairingCode', () => 'ABCD-1234')
  readonly cancelPairingCode = this.stub('cancelPairingCode', () => undefined)

  onEvent(listener: ClientEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  // ---- Presence and profile --------------------------------------------------------------------

  readonly sendPresenceAvailable = this.stub('sendPresenceAvailable', () => undefined)
  readonly sendPresenceUnavailable = this.stub('sendPresenceUnavailable', () => undefined)
  readonly setStatus = this.stub('setStatus', () => undefined)
  readonly setDisplayName = this.stub('setDisplayName', () => true)
  readonly setProfilePicture = this.stub('setProfilePicture', () => true)
  readonly deleteProfilePicture = this.stub('deleteProfilePicture', () => true)
  readonly setAutoDownloadAudio = this.stub('setAutoDownloadAudio', () => undefined)
  readonly setAutoDownloadDocuments = this.stub('setAutoDownloadDocuments', () => undefined)
  readonly setAutoDownloadPhotos = this.stub('setAutoDownloadPhotos', () => undefined)
  readonly setAutoDownloadVideos = this.stub('setAutoDownloadVideos', () => undefined)
  readonly setBackgroundSync = this.stub('setBackgroundSync', () => undefined)

  // ---- Messages --------------------------------------------------------------------------------

  readonly sendMessage = this.stub('sendMessage', (chatId, content, options) =>
    this.record(chatId, content, options?.caption)
  )
  readonly sendChannelMessage = this.stub('sendChannelMessage', (channelId, content, options) =>
    this.record(channelId, content, options?.caption)
  )
  readonly sendReaction = this.stub('sendReaction', () => undefined)
  readonly getMessageById = this.stub(
    'getMessageById',
    messageId => this.sent.find(message => message.id === messageId) ?? null
  )
  readonly searchMessages = this.stub('searchMessages', () => [])
  readonly fetchMessages = this.stub('fetchMessages', () => [])
  readonly getPinnedMessages = this.stub('getPinnedMessages', () => [])
  readonly revokeStatusMessage = this.stub('revokeStatusMessage', () => undefined)
  readonly reloadMessage = this.notScripted('reloadMessage')
  readonly replyToMessage = this.stub('replyToMessage', (messageId, content, chatId, options) =>
    this.record(
      chatId ?? this.sent.find(message => message.id === messageId)?.chatId ?? FAKE_PEER_ID,
      content,
      options?.caption
    )
  )
  readonly forwardMessage = this.stub('forwardMessage', () => undefined)
  readonly editMessage = this.stub('editMessage', () => null)
  readonly editScheduledEvent = this.stub('editScheduledEvent', () => null)
  readonly deleteMessage = this.stub('deleteMessage', () => undefined)
  readonly starMessage = this.stub('starMessage', () => undefined)
  readonly unstarMessage = this.stub('unstarMessage', () => undefined)
  readonly pinMessage = this.stub('pinMessage', () => true)
  readonly unpinMessage = this.stub('unpinMessage', () => true)
  readonly downloadMedia = this.stub('downloadMedia', () => null)
  readonly getMessageChat = this.notScripted('getMessageChat')
  readonly getMessageContact = this.notScripted('getMessageContact')
  readonly getMessageMentions = this.stub('getMessageMentions', () => [])
  readonly getMessageGroupMentions = this.stub('getMessageGroupMentions', () => [])
  readonly getQuotedMessage = this.stub('getQuotedMessage', () => null)
  readonly getMessageInfo = this.stub('getMessageInfo', () => null)
  readonly getMessageOrder = this.notScripted('getMessageOrder')
  readonly getMessagePayment = this.notScripted('getMessagePayment')
  readonly getMessageReactions = this.stub('getMessageReactions', () => [])
  readonly getPollVotes = this.stub('getPollVotes', () => [])
  readonly vote = this.stub('vote', () => undefined)
  readonly sendResponseToScheduledEvent = this.stub('sendResponseToScheduledEvent', () => true)
  readonly acceptGroupV4Invite = this.stub('acceptGroupV4Invite', () => ({ status: 200 }))

  // ---- Chats -----------------------------------------------------------------------------------

  readonly getChats = this.stub('getChats', () => [])
  readonly getChatById = this.notScripted('getChatById')
  readonly sendSeen = this.stub('sendSeen', () => true)
  readonly sendChatState = this.stub('sendChatState', () => undefined)
  readonly markChatUnread = this.stub('markChatUnread', () => undefined)
  readonly archiveChat = this.stub('archiveChat', () => true)
  readonly unarchiveChat = this.stub('unarchiveChat', () => true)
  readonly pinChat = this.stub('pinChat', () => true)
  readonly unpinChat = this.stub('unpinChat', () => true)
  readonly muteChat = this.stub('muteChat', (_chatId, unmuteDate) => ({
    isMuted: true,
    muteExpiration: unmuteDate ? Math.floor(unmuteDate.getTime() / 1000) : -1
  }))
  readonly unmuteChat = this.stub('unmuteChat', () => ({ isMuted: false, muteExpiration: 0 }))
  readonly clearChatMessages = this.stub('clearChatMessages', () => true)
  readonly deleteChat = this.stub('deleteChat', () => true)
  readonly syncHistory = this.stub('syncHistory', () => true)
  readonly addOrEditCustomerNote = this.stub('addOrEditCustomerNote', () => undefined)
  readonly getCustomerNote = this.notScripted('getCustomerNote')

  // ---- Contacts and numbers --------------------------------------------------------------------

  readonly getContacts = this.stub('getContacts', () => [])
  readonly getContactById = this.notScripted('getContactById')
  readonly getBlockedContacts = this.stub('getBlockedContacts', () => [])
  readonly blockContact = this.stub('blockContact', () => true)
  readonly unblockContact = this.stub('unblockContact', () => true)
  readonly getContactAbout = this.stub('getContactAbout', () => null)
  readonly getProfilePicUrl = this.stub('getProfilePicUrl', () => null)
  readonly getCommonGroups = this.stub('getCommonGroups', () => [])
  readonly getContactDeviceCount = this.stub('getContactDeviceCount', () => 1)
  readonly getContactBroadcast = this.notScripted('getContactBroadcast')
  readonly getContactChat = this.notScripted('getContactChat')
  readonly getContactLidAndPhone = this.stub('getContactLidAndPhone', () => [])
  readonly saveOrEditAddressbookContact = this.stub('saveOrEditAddressbookContact', () => undefined)
  readonly deleteAddressbookContact = this.stub('deleteAddressbookContact', () => undefined)
  readonly isRegisteredUser = this.stub('isRegisteredUser', () => true)
  readonly getNumberId = this.stub('getNumberId', number => `${number}@c.us`)
  readonly getCountryCode = this.stub('getCountryCode', number => number.slice(0, 2))
  readonly getFormattedNumber = this.stub('getFormattedNumber', number => number)

  // ---- Groups ----------------------------------------------------------------------------------

  readonly createGroup = this.notScripted('createGroup')
  readonly addParticipants = this.stub('addParticipants', () => ({}))
  readonly removeParticipants = this.stub('removeParticipants', () => ({ status: 200 }))
  readonly promoteParticipants = this.stub('promoteParticipants', () => ({ status: 200 }))
  readonly demoteParticipants = this.stub('demoteParticipants', () => ({ status: 200 }))
  readonly setGroupSubject = this.stub('setGroupSubject', () => true)
  readonly setGroupDescription = this.stub('setGroupDescription', () => true)
  readonly setAddMembersAdminsOnly = this.stub('setAddMembersAdminsOnly', () => true)
  readonly setMessagesAdminsOnly = this.stub('setMessagesAdminsOnly', () => true)
  readonly setInfoAdminsOnly = this.stub('setInfoAdminsOnly', () => true)
  readonly getGroupInviteCode = this.stub('getGroupInviteCode', () => 'FAKEINVITECODE')
  readonly revokeGroupInvite = this.stub('revokeGroupInvite', () => undefined)
  readonly leaveGroup = this.stub('leaveGroup', () => undefined)
  readonly setGroupPicture = this.stub('setGroupPicture', () => true)
  readonly deleteGroupPicture = this.stub('deleteGroupPicture', () => true)
  readonly getGroupMembershipRequests = this.stub('getGroupMembershipRequests', () => [])
  readonly approveGroupMembershipRequests = this.stub('approveGroupMembershipRequests', () => [])
  readonly rejectGroupMembershipRequests = this.stub('rejectGroupMembershipRequests', () => [])
  readonly acceptInvite = this.stub('acceptInvite', () => '120363000000000001@g.us')
  readonly getInviteInfo = this.stub('getInviteInfo', () => ({}))

  // ---- Channels --------------------------------------------------------------------------------

  readonly getChannels = this.stub('getChannels', () => [])
  readonly getChannelByInviteCode = this.notScripted('getChannelByInviteCode')
  readonly searchChannels = this.stub('searchChannels', () => [])
  readonly createChannel = this.notScripted('createChannel')
  readonly deleteChannel = this.stub('deleteChannel', () => true)
  readonly subscribeToChannel = this.stub('subscribeToChannel', () => true)
  readonly unsubscribeFromChannel = this.stub('unsubscribeFromChannel', () => true)
  readonly getChannelSubscribers = this.stub('getChannelSubscribers', () => [])
  readonly setChannelSubject = this.stub('setChannelSubject', () => true)
  readonly setChannelDescription = this.stub('setChannelDescription', () => true)
  readonly setChannelProfilePicture = this.stub('setChannelProfilePicture', () => true)
  readonly setChannelReactionSetting = this.stub('setChannelReactionSetting', () => true)
  readonly muteChannel = this.stub('muteChannel', () => true)
  readonly unmuteChannel = this.stub('unmuteChannel', () => true)
  readonly fetchChannelMessages = this.stub('fetchChannelMessages', () => [])
  readonly sendChannelAdminInvite = this.stub('sendChannelAdminInvite', () => true)
  readonly acceptChannelAdminInvite = this.stub('acceptChannelAdminInvite', () => true)
  readonly revokeChannelAdminInvite = this.stub('revokeChannelAdminInvite', () => true)
  readonly demoteChannelAdmin = this.stub('demoteChannelAdmin', () => true)
  readonly transferChannelOwnership = this.stub('transferChannelOwnership', () => true)

  // ---- Labels, broadcasts and calls ------------------------------------------------------------

  readonly getLabels = this.stub('getLabels', () => [])
  readonly getLabelById = this.notScripted('getLabelById')
  readonly getChatLabels = this.stub('getChatLabels', () => [])
  readonly getChatsByLabelId = this.stub('getChatsByLabelId', () => [])
  readonly addOrRemoveLabels = this.stub('addOrRemoveLabels', () => undefined)
  readonly getBroadcasts = this.stub('getBroadcasts', () => [])
  readonly getBroadcastById = this.notScripted('getBroadcastById')
  readonly createCallLink = this.stub('createCallLink', () => 'https://call.example.com/fake')
  readonly rejectCall = this.stub('rejectCall', () => undefined)

  // ---- Internals -------------------------------------------------------------------------------

  // One port method: `fallback` is the default answer when no script is set
  private stub<K extends PortMethod>(
    method: K,
    fallback: (...args: Args<K>) => Result<K>
  ): (...args: Args<K>) => Promise<Result<K>> {
    return async (...args: Args<K>): Promise<Result<K>> => {
      this.calls.push({ method, args })
      if (!this.connected && !WORKS_WHEN_DISCONNECTED.has(method)) {
        throw new WaDisconnectedError(method, false)
      }
      const failure = this.failures.get(method)?.shift()
      if (failure) throw failure
      const script = this.scripts[method]
      return script ? await script(...args) : fallback(...args)
    }
  }

  // A method whose answer is a DTO the test has to describe
  private notScripted<K extends PortMethod>(method: K): (...args: Args<K>) => Promise<Result<K>> {
    return this.stub(method, () => {
      throw new FakeNotScriptedError(method)
    })
  }

  // The message WhatsApp would return for a send: sent by us, with a fresh id
  private record(chatId: string, content: OutboundContent, caption?: string): MessageDto {
    this.messageCounter += 1
    const message = buildMessageDto({
      id: `true_${chatId}_FAKE${String(this.messageCounter).padStart(16, '0')}`,
      chatId,
      to: chatId,
      body: content.type === 'text' ? content.body : (caption ?? ''),
      hasMedia: content.type === 'media',
      type: content.type === 'media' ? 'image' : 'chat'
    })
    this.sent.push(message)
    return message
  }
}

// What `SessionManager` receives in tests instead of the real factory. It keeps every client it
// made so a test can reach the one that belongs to a session.
export class FakeWhatsAppClientFactory {
  readonly clients: FakeWhatsAppClient[] = []

  readonly create: WhatsAppClientFactory = (sessionId, options) => {
    const client = new FakeWhatsAppClient(sessionId, options)
    this.clients.push(client)
    return client
  }

  // The newest client of the session (a restart makes a new one)
  clientFor(sessionId: string): FakeWhatsAppClient | undefined {
    return this.clients.findLast(client => client.sessionId === sessionId)
  }
}
