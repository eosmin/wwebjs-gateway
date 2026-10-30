# Messages

The routes under `/v1/sessions/:sessionId/messages` (TDD §6.8 and §6.11). Sending goes through the [send queue](send-queue.md) and the [send policy](safety.md); the rest are reads and actions on one message, each one a call to the session's WhatsApp client, so the session must be `ready` (`409 SESSION_NOT_READY` otherwise).

## Sending

`POST /v1/sessions/:sessionId/messages` takes `to` and a `type`:

| `type`         | Fields                                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`         | `body`                                                                                                                                                    |
| `media`        | `source` (`{ base64, mimetype, filename? }`, `{ url, filename? }` or `{ messageId }`), `caption`, `asDocument`, `asVoice`, `asGif`, `asSticker` (+ `stickerName`, `stickerAuthor`, `stickerCategories`), `asHd`, `viewOnce` |
| `location`     | `latitude`, `longitude`, `name`, `address`, `url`                                                                                                         |
| `contact`      | `contactId` or `vcard` (one of them). An id goes as a contact card; a vCard goes as text with `parseVCards`                                              |
| `contacts`     | `contactIds` (1 to 20)                                                                                                                                    |
| `poll`         | `name`, `options` (2 to 12), `allowMultipleAnswers`                                                                                                       |
| `event`        | `name`, `startTime`, `endTime`, `description`, `location`, `callType`                                                                                     |
| `groupInvite`  | `inviteCode`: sent as `https://chat.whatsapp.com/<code>`, which WhatsApp shows as a card                                                                  |

Every type also takes `quotedMessageId`, `ignoreQuoteErrors`, `mentions`, `groupMentions`, `linkPreview`, `parseVCards`, `sendSeen`, `waitUntilMsgSent` (these map one to one to `MessageSendOptions`) and `humanize` (`enabled`, `typing`, `recording`, `markSeenFirst`, `minReplyDelayMs`; `enabled: false` switches the typing off for this message even when the session humanizes its texts). A text without `humanize` gets the defaults of the session (`settings.humanize`, see [sessions.md](sessions.md)); other types get none.

- **`to`** is a phone number (spaces, dashes, dots, parentheses and a leading `+` are fine) or a WhatsApp id (`@c.us`, `@g.us`, `@lid`, `@newsletter`, `status@broadcast`). A number is looked up with `getNumberId`; an unregistered one answers `422 NUMBER_NOT_ON_WHATSAPP`. The answer, positive or negative, is cached in Redis for an hour and shared by all sessions (whether a number is on WhatsApp does not depend on who asks). The look-ups that miss the cache count against `LOOKUPS_PER_DAY`.
- **Answers.** By default the call waits up to `SEND_SYNC_TIMEOUT_MS` and answers `201 { jobId, status: "sent", message }`. If the send is still queued by then (or with `?wait=false`) it answers `202 { jobId, status: "queued" }`; the result arrives as the `message_sent` or `message_failed` event and at `GET …/send-jobs/:jobId`. A send that ended in failure answers the error itself (`WHATSAPP_ERROR`, `UNKNOWN_OUTCOME`, a policy code, …).
- **Order of the work.** The cheap checks come first: the body schema, the recipient (a look-up counts against `LOOKUPS_PER_DAY` on a cache miss) and the send policy; only then is media downloaded. A suppressed or blocked recipient never triggers a fetch.
- **Idempotency.** `Idempotency-Key` (1 to 128 characters, per session, kept 24 h). The same key with the same request answers the first result, or the job in flight, and adds `Idempotent-Replayed: true`; with another request it is `422 IDEMPOTENCY_KEY_REUSED`. A replay never waits: a key whose job is still queued answers `202` with the job at once, even with `wait=true`, and if the first request failed after the key was claimed but before the job was added (Redis down), retries get `202` with a job id for up to 5 minutes, after which the key closes as `UNKNOWN_OUTCOME`; a retry never sends twice. A key is looked up **before** any work, and the request is hashed as it was written (without `wait`), so a retry is answered with the stored result even if the recipient is now suppressed, the media URL now serves other bytes, the session defaults changed or the session is not ready. A key whose process died is closed as `UNKNOWN_OUTCOME` after 5 minutes; check the chat before sending again with a new key.
- **Policy.** The send policy is asked twice: right away (a cold send, a suppressed or unreachable recipient, … answer `422` at once) and again in the worker before dispatch (budgets and pacing, which delay and never fail).
- **Media.** `base64` is checked against `MAX_MEDIA_BYTES` after decoding. A `url` is downloaded by the gateway: only `http(s)` URLs whose host resolves to public addresses (the SSRF guard runs again on every download, the connection goes only to the addresses it returned, a redirect is an error), at most `MAX_MEDIA_BYTES`, within `MEDIA_FETCH_TIMEOUT_MS`. The type is the `Content-Type` of the server when it is well formed and does not contradict the bytes (text/html on a PNG is replaced by what the bytes are), or what the first bytes look like when it says nothing specific. `messageId` sends again the media of a message the session can still download. Failures are `422 MEDIA_FETCH_FAILED` (a blocked URL is `400 VALIDATION_ERROR`).
- **Body size.** The send route and the reply route take bodies up to 40 MiB; every other route 1 MiB. A larger body is `413 PAYLOAD_TOO_LARGE`. A body that is declared larger than 1 MiB (or does not declare its size) is read only after the API key is checked: it needs a key that may send in that session, and it counts against the rate limit of the address like any request (so it counts twice). Without it the answer is `401`/`403`/`429` and the body is never read. A 32 MiB file is about 43 MiB as base64, above the 40 MiB of the route: a file between roughly 30 and 32 MiB sent as `base64` is refused by the body limit; send it as a `url` instead.
- **Memory.** A download, or the media of another message sent again by `messageId`, can hold its file about three times over while it is converted (the chunks, the joined buffer and the base64 text), so at most `MEDIA_FETCH_CONCURRENCY` (4) run at once; the others wait their turn, and the wait counts in the time of a synchronous send.

`POST …/messages/:messageId/reply` takes the same body as a send, with `to` optional: without it the reply goes to the chat of the message, quoting it.

## Reading

| Route                                  | What it gives                                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `GET …/send-jobs/:jobId`               | `queued`, `active`, `sent` (with the message) or `failed` (with the error)                    |
| `GET …/messages/:messageId`            | The message as WhatsApp Web has it                                                             |
| `GET …/messages/search`                | `query`, `chatId`, `limit`, `page`: messages WhatsApp Web has loaded                          |
| `GET …/stored-messages`                | The messages the gateway stored, newest first; page with `cursor`/`nextCursor` until it is null |
| `GET …/messages/:messageId/media`      | The file. The sender of a message chooses its type, so only formats a browser shows without running anything (JPEG, PNG, GIF, WebP, MP4, OGG, MP3, PDF) are served `inline` with their type; everything else is `application/octet-stream` as an `attachment`. Always `nosniff`, `sandbox` and `cache-control: private, no-store`. |
| `…/quoted`, `…/mentions`, `…/group-mentions`, `…/info`, `…/order`, `…/payment`, `…/reactions` | What the names say |

## Actions

`react` (empty `reaction` removes it), `forward` (below), `star`, `unstar`, `pin` (`duration` 86400, 604800 or 2592000 seconds), `unpin`, `PATCH` (edit the text of your own message), `DELETE` (`everyone`, `clearMedia`) and `DELETE …/status-messages/:messageId`. They answer `204` unless noted (`forward` answers like a send, `edit` with the message).

A **forward** is a send like any other: it goes through the queue, the policy, the pacing and the idempotency of the session, takes `?wait` and `Idempotency-Key`, and answers 201 or 202 like `messages.send`. WhatsApp does not say which message the forward created, and the gateway does not guess, so a finished forward is `{ jobId, status: "sent" }` with no `message` (the `message_sent` event has no `message` either). The forwarded copy reaches the event stream as its own `message_create`.

Scopes: `send` for sending, replying, reacting, forwarding and editing; `manage` for star, pin and delete; `read` for the rest.

## Polls, events and group invites

| Route | What it does |
| ----- | ------------ |
| `GET …/polls/:messageId/votes` and `GET …/messages/:messageId/poll-votes` | The votes of a poll message (`voter`, `selectedOptions`, `interactedAtTs`); `404` when the message does not exist, `400` when it is not a poll. Both routes give the same answer; votes also arrive as `vote_update` events |
| `POST …/messages/:messageId/vote` | `{ selectedOptions }` (option names) votes in a poll, replacing the previous vote; an empty list removes it; `404` for a missing message, `400` when it is not a poll or a name matches no option. `204` |
| `POST …/events/:messageId/response` | `{ response }`: `1` going, `2` not going, `3` maybe, `0` removes the answer. `204`; `404` for a missing message, `400` when it is not an event |
| `PATCH …/events/:messageId` | Edits an event you created. Send the whole event (`name`, `startTime`, and optionally `endTime`, `description`, `location`, `callType`): a field left out is cleared. `isEventCanceled: true` cancels it. Answers with the message; `404`/`400` as a vote; `WHATSAPP_ERROR` for an event somebody else created or one already canceled |
| `POST …/messages/:messageId/accept-group-invite` | Joins the group of the V4 invite the message carries and answers `{ status }`; `404` when the message is missing or has no invite, `400` when the invite has expired |

Scopes: `read` for the votes, `send` to vote, answer or edit an event, `manage` to accept an invite. Polls and events are created with `messages.send` (`type: poll` or `event`).

## What a synchronous send does not publish

A send that was accepted with `wait=true` and ended while the caller waited does not publish `message_sent` or `message_failed`: the caller already has the outcome (TDD §6.8, [send-queue.md](send-queue.md)). The events are for sends whose caller did not get the answer: `wait=false`, a timeout that ended in 202, a replay, and a restart. A consumer that follows only the event stream will not see a synchronous send; it sees the message itself as `message_create`, which the pipeline publishes for every message the account sends.

## Not covered by a code check on purpose

There is no `extra` field. TDD §6.8 listed it among the options (the `extra` of `MessageSendOptions` is passed as it is to WhatsApp Web), but wwebjs spreads it into the message after everything the gateway validated (the chat, the text and caption, the media, the quoted message, the mentions), so a caller could change any of them after the send policy and the SSRF guard approved something else; a list of forbidden keys cannot be complete. The bodies of a send, a reply and an edit refuse it like any unknown field (`400 VALIDATION_ERROR`). It can come back as an allowlist of primitive keys if a real need appears. A look-up that the policy would only delay is refused with `POLICY_BLOCKED` instead, the one place where pacing is an error: the caller is waiting for the recipient, and a delayed look-up would hold the request for the length of the delay. A cache hit of a phone number skips the look-up budget, because it costs nothing; it tells a session whether a number is registered only when another session asked about it in the last minutes (a "no") or hour (a "yes").
