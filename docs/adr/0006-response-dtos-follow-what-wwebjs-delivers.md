# ADR 0006: response DTOs follow what `whatsapp-web.js` really delivers

Status: Accepted (2026-11-12)

## Context

The typings of `whatsapp-web.js` 1.34.7 say that most fields are always there, and the response
schemas were written from them. A real account showed the typings lie: a send of a location answered
`500` after the message went out (`latitude` is a number, the typing says string), `GET contacts`
answered `500` (no `pushname`), `GET labels` answered `500` (no `hexColor`). A response that fails
its schema is a `500`, which also hides an action that already happened.

## Decision

1. **Required in a response DTO:** the `id`s, what the gateway fills (`chatId`, `sentAt`, …), what the
   wwebjs structure fills with a default (`body || ''`, `recipientIds = []`) and what is derived
   (`deviceType`). Every other field that a structure copies as it comes (`this.x = data.x`) is
   **optional**: a real object must never fail its own schema.
2. **Numbers:** `LocationDto.latitude` and `longitude` are numbers. The mapper converts what wwebjs
   hands (number or string); a location without usable coordinates, or an invite that lacks a field
   (it could not be accepted), is left out of the message, which is kept.
3. **A send never answers 500 because of its own message:** if the message of a send job does not fit
   its schema, it is left out of the answer, the job still says `sent`, and the field names (never
   the values) are logged as an error.
4. **Contract tests** (`src/whatsapp/mappers.contract.spec.ts`) map complete, redacted payloads minus
   the fields a real account lacks, and parse the result with the schema.
5. **Calls whose answer wwebjs does not report** (`Chat.unpin`, `Chat.unarchive` end in
   `return false` after doing it): the gateway re-reads the chat and judges by its state.

## Audit of the 79 required text/id/date fields (QA M0-7, phase B)

Made optional: `InviteV4Dto` none (an invite without all its fields is dropped), `ReactionDto.timestamp,
reaction, senderId`, `ReactionListDto.aggregateEmoji`, `ContactDto.number, pushname, sectionHeader,
type`, `BusinessProfileDto.tag, businessHours (and its config, timezone)`, `ChatDto.name,
muteExpiration`, `ChannelDto.name, description, timestamp, muteExpiration`, `MembershipRequestDto.
addedBy, requestMethod, t`, `GroupNotificationDto.author, timestamp`, `LabelDto.hexColor`,
`BroadcastDto.timestamp`, `CallDto.timestamp`, `ProductDto.thumbnailUrl, currency, name`,
`OrderDto.subtotal, total, currency, createdAt`, `PaymentDto.paymentCurrency,
paymentMessageReceiverJid, paymentTransactionTimestamp, paymentNote`, `ClientInfoDto.platform, pushname`.

Kept required: every `id`, `MessageDto.from/to/body/deviceType` (always set by `Message.js`),
`MessageMediaDto.mimetype/downloadUrl` (the mapper builds the block only with them),
`PollVoteDto.voter/parentMessageId` (the mapper refuses a vote without a poll),
`GroupNotificationDto.body/chatId`, `ClientInfoDto.wid/me`, `ProductDto.id`.

## Consequences

- Clients must treat the fields listed above as possibly absent.
- Booleans and numbers that wwebjs copies without a default were not part of the audit: see the
  follow-up in `docs/IMPLEMENTATION_PLAN.md`.

## Addendum (F11, H-F9B-01): flags and counters of contacts, chats, groups, channels

A real address book (201 contacts, wwebjs 1.34.8) answered `GET contacts` with 500: `isEnterprise` is
absent on every non-business contact and `statusMute` on about half; `verifiedLevel` is a number (the
typings say string) and `number` can be `null`. The business profile's link flag is `isProfileLinked`
at runtime (typings: `ifProfileLinked`).

- The mappers fill what "absent" means: a missing flag is `false`, a missing count is `0`
  (`isGroup` of a chat falls back to the `@g.us` server). The DTOs keep them required, so clients
  never see them missing.
- `verifiedLevel` is delivered as a string, `number: null` is left out, `profileOptions` is optional,
  `categories` defaults to `[]`. `BusinessProfileDto.ifProfileLinked` keeps its name (no API break) and
  reads `isProfileLinked` first.
- A response that still fails its schema logs the failing paths and issue codes (never values).

## Alternatives considered

- **Keep the strict schemas and fix each field as a real account breaks it.** Rejected: every miss is a
  `500` in production, and for a send it hides a message that went out.
- **Turn response validation off.** Rejected: the generated OpenAPI and the docs derive from the
  schemas, and a wrong shape would reach clients without anyone noticing.
- **Default every missing string to `''`.** Rejected: an empty `pushname` or `hexColor` is false data;
  an absent field says the truth.
