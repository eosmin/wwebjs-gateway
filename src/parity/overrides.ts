// whatsapp-web.js symbols the gateway deliberately does not expose, each with the reason. The parity
// test fails on a symbol that is neither here, linked by an operation, nor an event, and on an
// entry here that the library no longer declares.
const EXTRA_REASON =
  'security: wwebjs spreads extra into the message after the chat, text, media, quote and mentions the gateway validated, so it would undo the send policy and the SSRF guard'

export const UNSUPPORTED_SYMBOLS: Readonly<Record<string, string>> = {
  'Client.pupPage': 'security: raw Puppeteer page access would allow arbitrary evaluate',
  'Client.pupBrowser': 'security: raw Puppeteer browser access would bypass every guard',
  'ClientOptions.authStrategy': 'internal: the gateway always uses LocalAuth (single instance)',
  'MessageSendOptions.extra': EXTRA_REASON,
  'MessageEditOptions.extra': EXTRA_REASON,
  'ClientOptions.evalOnNewDoc': 'security: injects arbitrary script into every page'
}
