import type {
  BatteryInfoDto,
  BroadcastDto,
  BusinessContactDto,
  ChannelDto,
  ChatDto,
  ClientInfoDto,
  ContactDto,
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
import type { WaEventName, WaEventPayloadMap } from '../types/events.js'

// The only WhatsApp abstraction the rest of the app sees. It mirrors the whatsapp-web.js 1.34.7
// surface (TDD §6.12) with our DTOs in and out, and it never mentions a wwebjs type, so that
// `wwebjs-adapter.ts` stays the single file that imports the library. Ids are WhatsApp ids such as
// `5215512345678@c.us`; phone numbers are resolved before they get here. Every method rejects with
// `WaDisconnectedError`, `WaTimeoutError` or `WaOperationError` (wa-errors.ts), never with a
// Puppeteer error.
//
// `Buttons` and `List` are not part of it: WhatsApp stopped rendering them (TDD §1).

// ---- Events ------------------------------------------------------------------------------------

// What a client emits: the events of wwebjs plus `session_error` for adapter-level failures. The
// other synthesized events are made further up, by the pipeline and the session manager.
export type GatewayOnlyEvent =
  | 'session_status'
  | 'message_batch'
  | 'message_sent'
  | 'message_failed'
  | 'chat_suppressed'
  | 'chat_unreachable'
  | 'ping'
export type ClientEventName = Exclude<WaEventName, GatewayOnlyEvent>

export type ClientEvent = {
  [E in ClientEventName]: { event: E; data: WaEventPayloadMap[E] }
}[ClientEventName]

export type ClientEventListener = (event: ClientEvent) => void

// ---- Content and options -----------------------------------------------------------------------

// The bytes of a media file, always as base64. Downloading from a URL happens before the port, so
// that the SSRF guard sees the URL (`MediaFromURLOptions` has no equivalent here).
export interface OutboundMedia {
  mimetype: string
  data: string
  filename?: string | null
}

export type OutboundContent =
  | { type: 'text'; body: string }
  | { type: 'media'; media: OutboundMedia }
  | {
      type: 'location'
      latitude: number
      longitude: number
      name?: string
      address?: string
      url?: string
    }
  | {
      type: 'poll'
      name: string
      options: string[]
      allowMultipleAnswers?: boolean
      messageSecret?: number[]
    }
  | { type: 'contacts'; contactIds: string[] }
  | {
      type: 'event'
      name: string
      startTime: Date
      description?: string
      endTime?: Date
      location?: string
      callType?: string
      isEventCanceled?: boolean
      messageSecret?: number[]
    }

// `MessageSendOptions` of wwebjs, except `media` (it is the content) and `extra` (typed here)
export interface SendOptions {
  linkPreview?: boolean
  sendAudioAsVoice?: boolean
  sendVideoAsGif?: boolean
  sendMediaAsSticker?: boolean
  sendMediaAsDocument?: boolean
  sendMediaAsHd?: boolean
  isViewOnce?: boolean
  parseVCards?: boolean
  caption?: string
  quotedMessageId?: string
  mentions?: string[]
  groupMentions?: { subject: string; id: string }[]
  sendSeen?: boolean
  invokedBotWid?: string
  extra?: Record<string, unknown>
  stickerName?: string
  stickerAuthor?: string
  stickerCategories?: string[]
  ignoreQuoteErrors?: boolean
  waitUntilMsgSent?: boolean
}

export interface EditOptions {
  linkPreview?: boolean
  mentions?: string[]
  extra?: Record<string, unknown>
}

export interface ChannelSendOptions {
  caption?: string
  mentions?: string[]
  extra?: Record<string, unknown>
}

export interface FetchMessagesOptions {
  limit?: number
  fromMe?: boolean
}

export interface SearchMessagesOptions {
  chatId?: string
  page?: number
  limit?: number
}

export interface CreateGroupOptions {
  messageTimer?: number
  parentGroupId?: string
  autoSendInviteV4?: boolean
  comment?: string
  memberAddMode?: boolean
  membershipApprovalMode?: boolean
  isRestrict?: boolean
  isAnnounce?: boolean
}

export interface AddParticipantsOptions {
  sleep?: number | number[]
  autoSendInviteV4?: boolean
  comment?: string
}

export interface MembershipRequestActionOptions {
  requesterIds?: string | string[] | null
  sleep?: number | number[] | null
}

export interface CreateChannelOptions {
  description?: string
  picture?: OutboundMedia
}

export interface SearchChannelsOptions {
  searchText?: string
  countryCodes?: string[]
  skipSubscribedNewsletters?: boolean
  view?: number
  limit?: number
}

export interface UnsubscribeOptions {
  deleteLocalModels?: boolean
}

export interface TransferChannelOwnershipOptions {
  shouldDismissSelfAsAdmin?: boolean
}

export interface PairingCodeRequest {
  phoneNumber: string
  showNotification?: boolean
  intervalMs?: number
}

// ---- Results -----------------------------------------------------------------------------------

export type AnyChatDto = ChatDto | GroupChatDto | ChannelDto
export type AnyContactDto = ContactDto | BusinessContactDto

export interface MuteResult {
  isMuted: boolean
  muteExpiration: number
}

export interface CustomerNote {
  chatId: string
  content: string
  createdAt: number
  id: string
  modifiedAt: number
  type: string
}

export interface CreateGroupResult {
  title: string
  gid: string
  participants: Record<
    string,
    { statusCode: number; message: string; isGroupCreator: boolean; isInviteV4Sent: boolean }
  >
}

export interface CreateChannelResult {
  title: string
  nid: string
  inviteLink: string
  createdAtTs: number
}

// What wwebjs answers when a participant could not be added is a plain text, kept as it comes
export type AddParticipantsResult =
  Record<string, { code: number; message: string; isInviteV4Sent: boolean }> | string

export interface MembershipRequestActionResult {
  requesterId: string | string[] | null
  error?: number
  message: string
}

export interface ChannelSubscriber {
  contact: AnyContactDto
  role: string
}

export interface LidAndPhone {
  lid: string
  pn: string
}

export type ChatStateKind = 'typing' | 'recording' | 'clear'

export interface DownloadedMedia {
  mimetype: string
  data: string
  filename?: string | null
  filesize?: number | null
}

// ---- The port ----------------------------------------------------------------------------------

export interface WhatsAppClientPort {
  // Lifecycle. `initialize` resolves when the browser is up; readiness arrives as the `ready` event.
  initialize(): Promise<void>
  destroy(): Promise<void>
  logout(): Promise<void>
  resetState(): Promise<void>
  getState(): Promise<string | null>
  getWWebVersion(): Promise<string>
  getClientInfo(): Promise<ClientInfoDto>
  getBatteryStatus(): Promise<BatteryInfoDto>
  // Resident memory of the browser and every process it started; undefined when it cannot be read
  getBrowserMemoryBytes(): Promise<number | undefined>
  requestPairingCode(request: PairingCodeRequest): Promise<string>
  cancelPairingCode(): Promise<void>
  // Delivers every event to the listener inside a try/catch; returns the way to stop listening
  onEvent(listener: ClientEventListener): () => void

  // Presence and profile
  sendPresenceAvailable(): Promise<void>
  sendPresenceUnavailable(): Promise<void>
  setStatus(status: string): Promise<void>
  setDisplayName(displayName: string): Promise<boolean>
  setProfilePicture(media: OutboundMedia): Promise<boolean>
  deleteProfilePicture(): Promise<boolean>
  setAutoDownloadAudio(flag: boolean): Promise<void>
  setAutoDownloadDocuments(flag: boolean): Promise<void>
  setAutoDownloadPhotos(flag: boolean): Promise<void>
  setAutoDownloadVideos(flag: boolean): Promise<void>
  setBackgroundSync(flag: boolean): Promise<void>

  // Messages
  sendMessage(chatId: string, content: OutboundContent, options?: SendOptions): Promise<MessageDto>
  sendChannelMessage(
    channelId: string,
    content: Extract<OutboundContent, { type: 'text' | 'media' }>,
    options?: ChannelSendOptions
  ): Promise<MessageDto>
  sendReaction(messageId: string, reaction: string): Promise<void>
  getMessageById(messageId: string): Promise<MessageDto | null>
  searchMessages(query: string, options?: SearchMessagesOptions): Promise<MessageDto[]>
  fetchMessages(chatId: string, options?: FetchMessagesOptions): Promise<MessageDto[]>
  getPinnedMessages(chatId: string): Promise<MessageDto[]>
  revokeStatusMessage(messageId: string): Promise<void>
  reloadMessage(messageId: string): Promise<MessageDto>
  replyToMessage(
    messageId: string,
    content: OutboundContent,
    chatId?: string,
    options?: SendOptions
  ): Promise<MessageDto>
  forwardMessage(messageId: string, chatId: string): Promise<void>
  editMessage(
    messageId: string,
    content: Extract<OutboundContent, { type: 'text' }>,
    options?: EditOptions
  ): Promise<MessageDto | null>
  editScheduledEvent(
    messageId: string,
    event: Extract<OutboundContent, { type: 'event' }>
  ): Promise<MessageDto | null>
  deleteMessage(messageId: string, everyone?: boolean, clearMedia?: boolean): Promise<void>
  starMessage(messageId: string): Promise<void>
  unstarMessage(messageId: string): Promise<void>
  pinMessage(messageId: string, durationSeconds: number): Promise<boolean>
  unpinMessage(messageId: string): Promise<boolean>
  // null when the media is not available (wwebjs answers undefined)
  downloadMedia(messageId: string): Promise<DownloadedMedia | null>
  getMessageChat(messageId: string): Promise<AnyChatDto>
  getMessageContact(messageId: string): Promise<AnyContactDto>
  getMessageMentions(messageId: string): Promise<AnyContactDto[]>
  getMessageGroupMentions(messageId: string): Promise<GroupChatDto[]>
  getQuotedMessage(messageId: string): Promise<MessageDto | null>
  getMessageInfo(messageId: string): Promise<MessageInfoDto | null>
  getMessageOrder(messageId: string): Promise<OrderDto>
  getMessagePayment(messageId: string): Promise<PaymentDto>
  getMessageReactions(messageId: string): Promise<ReactionListDto[]>
  getPollVotes(messageId: string): Promise<PollVoteDto[]>
  vote(messageId: string, selectedOptions: string[]): Promise<void>
  sendResponseToScheduledEvent(response: number, eventMessageId: string): Promise<boolean>
  acceptGroupV4Invite(invite: InviteV4Dto): Promise<{ status: number }>

  // Chats
  getChats(): Promise<AnyChatDto[]>
  getChatById(chatId: string): Promise<AnyChatDto>
  sendSeen(chatId: string): Promise<boolean>
  sendChatState(chatId: string, state: ChatStateKind): Promise<void>
  markChatUnread(chatId: string): Promise<void>
  archiveChat(chatId: string): Promise<boolean>
  unarchiveChat(chatId: string): Promise<boolean>
  pinChat(chatId: string): Promise<boolean>
  unpinChat(chatId: string): Promise<boolean>
  muteChat(chatId: string, unmuteDate?: Date): Promise<MuteResult>
  unmuteChat(chatId: string): Promise<MuteResult>
  clearChatMessages(chatId: string): Promise<boolean>
  deleteChat(chatId: string): Promise<boolean>
  syncHistory(chatId: string): Promise<boolean>
  addOrEditCustomerNote(userId: string, note: string): Promise<void>
  getCustomerNote(userId: string): Promise<CustomerNote>

  // Contacts and numbers
  getContacts(): Promise<AnyContactDto[]>
  getContactById(contactId: string): Promise<AnyContactDto>
  getBlockedContacts(): Promise<AnyContactDto[]>
  blockContact(contactId: string): Promise<boolean>
  unblockContact(contactId: string): Promise<boolean>
  getContactAbout(contactId: string): Promise<string | null>
  getProfilePicUrl(contactId: string): Promise<string | null>
  getCommonGroups(contactId: string): Promise<string[]>
  getContactDeviceCount(userId: string): Promise<number>
  getContactBroadcast(contactId: string): Promise<BroadcastDto>
  getContactChat(contactId: string): Promise<AnyChatDto>
  getContactLidAndPhone(userIds: string[]): Promise<LidAndPhone[]>
  saveOrEditAddressbookContact(
    phoneNumber: string,
    firstName: string,
    lastName: string,
    syncToAddressbook?: boolean
  ): Promise<void>
  deleteAddressbookContact(phoneNumber: string): Promise<void>
  isRegisteredUser(contactId: string): Promise<boolean>
  getNumberId(number: string): Promise<string | null>
  getCountryCode(number: string): Promise<string>
  getFormattedNumber(number: string): Promise<string>

  // Groups
  createGroup(
    title: string,
    participantIds: string[],
    options?: CreateGroupOptions
  ): Promise<CreateGroupResult | string>
  addParticipants(
    groupId: string,
    participantIds: string[],
    options?: AddParticipantsOptions
  ): Promise<AddParticipantsResult>
  removeParticipants(groupId: string, participantIds: string[]): Promise<{ status: number }>
  promoteParticipants(groupId: string, participantIds: string[]): Promise<{ status: number }>
  demoteParticipants(groupId: string, participantIds: string[]): Promise<{ status: number }>
  setGroupSubject(groupId: string, subject: string): Promise<boolean>
  setGroupDescription(groupId: string, description: string): Promise<boolean>
  setAddMembersAdminsOnly(groupId: string, adminsOnly?: boolean): Promise<boolean>
  setMessagesAdminsOnly(groupId: string, adminsOnly?: boolean): Promise<boolean>
  setInfoAdminsOnly(groupId: string, adminsOnly?: boolean): Promise<boolean>
  getGroupInviteCode(groupId: string): Promise<string>
  revokeGroupInvite(groupId: string): Promise<void>
  leaveGroup(groupId: string): Promise<void>
  setGroupPicture(groupId: string, media: OutboundMedia): Promise<boolean>
  deleteGroupPicture(groupId: string): Promise<boolean>
  getGroupMembershipRequests(groupId: string): Promise<MembershipRequestDto[]>
  approveGroupMembershipRequests(
    groupId: string,
    options: MembershipRequestActionOptions
  ): Promise<MembershipRequestActionResult[]>
  rejectGroupMembershipRequests(
    groupId: string,
    options: MembershipRequestActionOptions
  ): Promise<MembershipRequestActionResult[]>
  acceptInvite(inviteCode: string): Promise<string>
  getInviteInfo(inviteCode: string): Promise<Record<string, unknown>>

  // Channels
  getChannels(): Promise<ChannelDto[]>
  getChannelByInviteCode(inviteCode: string): Promise<ChannelDto>
  searchChannels(options: SearchChannelsOptions): Promise<ChannelDto[]>
  createChannel(
    title: string,
    options?: CreateChannelOptions
  ): Promise<CreateChannelResult | string>
  deleteChannel(channelId: string): Promise<boolean>
  subscribeToChannel(channelId: string): Promise<boolean>
  unsubscribeFromChannel(channelId: string, options?: UnsubscribeOptions): Promise<boolean>
  getChannelSubscribers(channelId: string, limit?: number): Promise<ChannelSubscriber[]>
  setChannelSubject(channelId: string, subject: string): Promise<boolean>
  setChannelDescription(channelId: string, description: string): Promise<boolean>
  setChannelProfilePicture(channelId: string, media: OutboundMedia): Promise<boolean>
  setChannelReactionSetting(channelId: string, reactionCode: number): Promise<boolean>
  muteChannel(channelId: string): Promise<boolean>
  unmuteChannel(channelId: string): Promise<boolean>
  fetchChannelMessages(channelId: string, options?: FetchMessagesOptions): Promise<MessageDto[]>
  sendChannelAdminInvite(
    chatId: string,
    channelId: string,
    options?: { comment?: string }
  ): Promise<boolean>
  acceptChannelAdminInvite(channelId: string): Promise<boolean>
  revokeChannelAdminInvite(channelId: string, userId: string): Promise<boolean>
  demoteChannelAdmin(channelId: string, userId: string): Promise<boolean>
  transferChannelOwnership(
    channelId: string,
    newOwnerId: string,
    options?: TransferChannelOwnershipOptions
  ): Promise<boolean>

  // Labels, broadcasts and calls
  getLabels(): Promise<LabelDto[]>
  getLabelById(labelId: string): Promise<LabelDto>
  getChatLabels(chatId: string): Promise<LabelDto[]>
  getChatsByLabelId(labelId: string): Promise<AnyChatDto[]>
  addOrRemoveLabels(labelIds: (number | string)[], chatIds: string[]): Promise<void>
  getBroadcasts(): Promise<BroadcastDto[]>
  getBroadcastById(contactId: string): Promise<BroadcastDto>
  createCallLink(startTime: Date, callType: string): Promise<string>
  rejectCall(callId: string): Promise<void>
}

// ---- Factory -----------------------------------------------------------------------------------

export interface WhatsAppClientOptions {
  // Log in with a phone number instead of a QR code
  pairWithPhoneNumber?: PairingCodeRequest
}

// `SessionManager` gets one client per session through this factory; tests replace it with the fake
export type WhatsAppClientFactory = (
  sessionId: string,
  options: WhatsAppClientOptions
) => WhatsAppClientPort

export const WHATSAPP_CLIENT_FACTORY = Symbol('WHATSAPP_CLIENT_FACTORY')
