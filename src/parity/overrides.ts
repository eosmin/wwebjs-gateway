// whatsapp-web.js symbols the gateway deliberately does not expose, each with the reason. The parity
// test fails on a symbol that is neither here, linked by an operation, nor an event, and on an
// entry here that the library no longer declares.
const EXTRA_REASON =
  'security: wwebjs spreads extra into the message after the chat, text, media, quote and mentions the gateway validated, so it would undo the send policy and the SSRF guard'

const ID_REASON =
  'internal: an id travels as its serialized string (`user@server`), the parts are in the string'
const AUTH_REASON =
  'internal: the gateway always uses LocalAuth, so a custom strategy and its hooks never run'
const REMOTE_AUTH_REASON =
  'internal: single instance by design, the session lives in the local profile and not in a RemoteAuth store'
const BUTTONS_REASON =
  'internal: WhatsApp stopped rendering buttons and lists; polls replace them (TDD §1)'
const PRODUCT_REASON =
  'internal: reads the catalog of a business account, which no operation needs yet (IMPLEMENTATION_PLAN, 9.1 debts)'

export const UNSUPPORTED_SYMBOLS: Readonly<Record<string, string>> = {
  'Client.pupPage': 'security: raw Puppeteer page access would allow arbitrary evaluate',
  'Client.pupBrowser': 'security: raw Puppeteer browser access would bypass every guard',
  'ClientOptions.authStrategy': 'internal: the gateway always uses LocalAuth (single instance)',
  'MessageSendOptions.extra': EXTRA_REASON,
  'MessageEditOptions.extra': EXTRA_REASON,
  'ClientOptions.evalOnNewDoc': 'security: injects arbitrary script into every page',
  // 1.34.8 streams big downloads. The gateway buffers a download under MAX_MEDIA_BYTES, so the stream
  // waits for its own step (IMPLEMENTATION_PLAN, F9a debts)
  'Message.downloadMediaStream':
    'internal: media streaming is not exposed yet, downloads are buffered',
  'MessageMediaStream.stream':
    'internal: media streaming is not exposed yet, downloads are buffered',
  'MediaStreamOptions.chunkSize':
    'internal: media streaming is not exposed yet, downloads are buffered',
  // Declared by 1.34.8 as the shared base of MessageMedia, whose fields the gateway already returns
  'MessageMediaMetadata.mimetype': 'internal: the same field is returned as MessageMedia.mimetype',
  'MessageMediaMetadata.filename': 'internal: the same field is returned as MessageMedia.filename',
  'MessageMediaMetadata.filesize': 'internal: the same field is returned as MessageMedia.filesize',
  'MessageSendChannelOptions.extra': EXTRA_REASON,
  'MessageSendOptions.invokedBotWid':
    'security: names a Meta AI bot to invoke in the chat, which the send policy cannot judge',
  'PollSendOptions.messageSecret':
    'security: a caller-chosen poll secret makes the poll id predictable; WhatsApp generates it',
  'ScheduledEventSendOptions.messageSecret':
    'security: a caller-chosen event secret makes the event id predictable; WhatsApp generates it',
  'ScheduledEventSendOptions.callType':
    'internal: a call link needs a WhatsApp Web module that no longer exists, so a send refuses it',
  'MessageMedia.fromFilePath':
    'security: reads a file of the gateway host, and a caller must never choose the path',
  'MediaFromURLOptions.client':
    'internal: the gateway downloads the URL itself, behind the SSRF guard, before the adapter',
  'MediaFromURLOptions.reqOptions':
    'security: arbitrary request options (headers, redirects, agents) would undo the SSRF guard',
  'MediaFromURLOptions.unsafeMime':
    'security: skips the media type check that keeps what is sent to a known type',
  'Client.interface': 'security: drives the WhatsApp Web interface of the page, like pupPage',
  'Client.on': 'internal: events reach a consumer through webhooks and the socket, not a listener',
  'Product.getData': PRODUCT_REASON,
  'ProductMetadata.description': PRODUCT_REASON,
  'ProductMetadata.id': PRODUCT_REASON,
  'ProductMetadata.name': PRODUCT_REASON,
  'ProductMetadata.retailer_id': PRODUCT_REASON,
  'Buttons.body': BUTTONS_REASON,
  'Buttons.buttons': BUTTONS_REASON,
  'Buttons.footer': BUTTONS_REASON,
  'Buttons.title': BUTTONS_REASON,
  'List.body': BUTTONS_REASON,
  'List.buttonText': BUTTONS_REASON,
  'List.footer': BUTTONS_REASON,
  'List.sections': BUTTONS_REASON,
  'List.title': BUTTONS_REASON,
  'ClientOptions.authTimeoutMs':
    'internal: the library default applies; the gateway watchdog owns the time a session may take',
  'ClientOptions.bypassCSP': 'security: turns off the content security policy of WhatsApp Web',
  'ClientOptions.takeoverTimeoutMs':
    'internal: the library default applies; TAKEOVER_ON_CONFLICT decides whether to take over',
  'ClientOptions.userAgent':
    'internal: the user agent stays the one of the pinned browser; another one changes what WhatsApp sees',
  'LocalAuth.clientId': 'internal: LocalAuth always takes the id of the session as its client id',
  ...Object.fromEntries(
    [
      'afterAuthReady',
      'afterBrowserInitialized',
      'beforeBrowserInitialized',
      'destroy',
      'disconnect',
      'getAuthEventPayload',
      'logout',
      'onAuthenticationNeeded',
      'setup'
    ].map(member => [`AuthStrategy.${member}`, AUTH_REASON])
  ),
  ...Object.fromEntries(
    ['_serialized', 'server', 'user'].flatMap(member => [
      [`ChatId.${member}`, ID_REASON],
      [`ContactId.${member}`, ID_REASON]
    ])
  ),
  ...Object.fromEntries(
    ['_serialized', 'fromMe', 'id', 'remote'].map(member => [`MessageId.${member}`, ID_REASON])
  ),
  ...Object.fromEntries(
    ['clientId', 'dataPath'].map(member => [`RemoteAuth.${member}`, REMOTE_AUTH_REASON])
  ),
  ...Object.fromEntries(
    ['delete', 'extract', 'save', 'sessionExists'].map(member => [
      `Store.${member}`,
      REMOTE_AUTH_REASON
    ])
  )
}

// The operations that have no socket command, each with the reason. Every other operation declares
// `socket.command` in its `@WaOperation` (TDD §6.10): the parity test fails on an operation that is in
// neither place. A socket follows a conversation and works in it, so the REST-only ones are what
// configures the gateway, what holds a credential, and what a socket cannot carry.
const ADMIN = 'admin: keys and sessions are managed over REST, never over a long-lived socket'
const LIFECYCLE =
  'lifecycle: starts, stops or removes the session the socket follows, so it stays on REST'
const CREDENTIAL =
  'credential: it answers the QR or the pairing code, which reach a socket only as the events qr and code that need manage'
const CONFIGURATION =
  'configuration: changes how the gateway behaves, a decision for the operator and not for a conversation'
const HOOKS = 'configuration: webhooks and inbound hooks carry secrets and are managed over REST'

export const REST_ONLY_OPERATIONS: Readonly<Record<string, string>> = {
  'system.info': ADMIN,
  'apiKeys.create': ADMIN,
  'apiKeys.list': ADMIN,
  'apiKeys.rotate': ADMIN,
  'apiKeys.revoke': ADMIN,
  'sessions.create': ADMIN,
  'sessions.list': ADMIN,
  'sessions.update': LIFECYCLE,
  'sessions.remove': LIFECYCLE,
  'sessions.start': LIFECYCLE,
  'sessions.stop': LIFECYCLE,
  'sessions.restart': LIFECYCLE,
  'sessions.logout': LIFECYCLE,
  'sessions.resetState': LIFECYCLE,
  'sessions.qr': CREDENTIAL,
  'sessions.qrPng': CREDENTIAL,
  'sessions.requestPairingCode': CREDENTIAL,
  'sessions.cancelPairingCode': CREDENTIAL,
  'messages.media': 'binary: it answers the bytes of the file, which an ack of JSON cannot carry',
  'settings.update': CONFIGURATION,
  'sendPolicy.get': CONFIGURATION,
  'sendPolicy.update': CONFIGURATION,
  'sendPolicy.usage': CONFIGURATION,
  'suppressions.list': CONFIGURATION,
  'suppressions.add': CONFIGURATION,
  'suppressions.remove': CONFIGURATION,
  'unreachableChats.list': CONFIGURATION,
  'webhooks.create': HOOKS,
  'webhooks.list': HOOKS,
  'webhooks.get': HOOKS,
  'webhooks.update': HOOKS,
  'webhooks.delete': HOOKS,
  'webhooks.rotateSecret': HOOKS,
  'webhooks.test': HOOKS,
  'webhooks.listDeliveries': HOOKS,
  'webhooks.retryFailed': HOOKS,
  'webhooks.retryDelivery': HOOKS,
  'inboundHooks.create': HOOKS,
  'inboundHooks.list': HOOKS,
  'inboundHooks.revoke': HOOKS,
  'inboundHooks.send':
    'public: its credential is the token in the URL, and a socket has its own key'
}
