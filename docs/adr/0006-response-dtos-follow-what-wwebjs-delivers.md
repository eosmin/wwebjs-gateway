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

## Addendum (F13, H-F9B-04): one odd message must not take down a listing of chats

A `groups_v4_invite` delivers every `inviteV4` key as a string (`inviteCodeExp` is typed number), and
while it was the last message of a chat, `GET chats` answered 500 for the whole session.

- `inviteCodeExp` is read from a number or a numeric string; an invite whose expiration is not a
  whole number is left out (it cannot be accepted), the message is kept.
- **Decision reversed for the last message of a chat or channel:** the earlier rule "a response that
  fails its schema is a 500, by design" stays for single objects and for message lists, but the
  `lastMessage` of a chat/group/channel is validated by the mapper and **left out** when it does not fit
  (or cannot be mapped); the adapter logs the field names, never the values. A listing of N chats
  must not fail for one message of a special type.
- `Message.js` copies `isStarred`, `links`, `vCards`, `isStatus`, `isGif`, `forwardingScore` without a
  default, so the mapper defaults them (false, `[]`, `[]`, false, false, 0).

## Addendum (F21, review E): the same rule for every listing and for the mappers

The review of the mappers found the F13 pattern still open elsewhere: one odd group, broadcast, order,
call or message made a whole listing a `500`.

- **Listings leave out what cannot be delivered.** Chats (groups and channels included), contacts,
  channels, labels and broadcasts are mapped one by one and validated against the schema of the
  response; an item that cannot be mapped or does not fit is left out and the listing goes on. The
  adapter logs one warn per listing: the session, how many items of how many, and the field names
  (never values or ids). The item stays reachable by its own id, where a failure is reported as such.
  This **extends** the F13 reversal (a last message) to the items of a listing; single objects and
  message lists keep the earlier rule. The client cannot yet tell "left out" from "does not exist":
  see the debt in the plan (a skipped-items counter, step 10.4).
- **Optional fields are copied by type.** A field WhatsApp filled with another type is left out of the
  message and reported by name; a missing `body` is `''`, a missing `type`/`deviceType` is `'unknown'`,
  a missing flag is false. A message that names no chat (`from`/`to` of its side) is refused: there is no
  safe default, it would be stored under the wrong conversation. A call or any item without `id` is
  refused too.
- **Group and broadcast gaps:** `GroupChatDto.createdAt` is optional (an Invalid Date is left out),
  `participants` defaults to `[]`; a broadcast without `msgs` has none, `totalCount` is the number of
  statuses it holds and `unreadCount` 0; an order without `products` has none; a call flag that is
  missing is false. A unix time must be a whole number (a fraction would fail the `.int()` of the DTO).
- **An action that happened is never reported as failed:** the outcomes of `createGroup` and
  `addParticipants` are read field by field (all optional in the DTO); an odd answer is delivered with
  what is known and logged.
- The contract tests derive the required keys of each DTO from its schema, so a new required field
  cannot be left unfilled by a mapper without a test failing.

## Alternatives considered

- **Keep the strict schemas and fix each field as a real account breaks it.** Rejected: every miss is a
  `500` in production, and for a send it hides a message that went out.
- **Turn response validation off.** Rejected: the generated OpenAPI and the docs derive from the
  schemas, and a wrong shape would reach clients without anyone noticing.
- **Default every missing string to `''`.** Rejected: an empty `pushname` or `hexColor` is false data;
  an absent field says the truth.
