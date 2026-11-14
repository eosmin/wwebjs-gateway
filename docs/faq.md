# FAQ

Short answers, each one with the guide that holds the detail.

## About the project

**Is this an official WhatsApp product?**
No. The gateway drives WhatsApp Web through `whatsapp-web.js`, an unofficial library. Automating an
account can go against the terms of WhatsApp and can get a number restricted or banned. For anything
critical, such as notifications, billing or authentication codes, use the official WhatsApp Business
Platform and keep this gateway for conversations ([operations](operations.md), [limits](limits.md)).

**Is there a public demo or a hosted API?**
No. The repository is public, the instance that runs it is private, and the committed
`docs/openapi.json` and the guides are the public reference. The Swagger UI exists only when
`ENABLE_DOCS` is on, and a production start refuses it.

**Is there an admin interface?**
No. The REST and Socket.IO surface and `docs/openapi.json` are meant for a separate project to consume.
The queues can be inspected with Bull Board at `/admin/queues` when `BULL_BOARD_ENABLED=true`.

**Does it cover the whole `whatsapp-web.js` API?**
Every public symbol of the pinned version is either mapped to an operation, an event or a field, or
listed as not supported with its reason, and a test fails when one is neither
([parity-matrix](parity-matrix.md)). The operations are listed in [operations-list](operations-list.md).

**What is the license?**
All rights reserved. See `LICENSE`.

## Running it

**Can I run more than one replica?**
No. A session's browser and saved login belong to one Node process and some state lives in its memory,
so the gateway is a single-instance service ([architecture](architecture.md)).

**How many sessions can it hold?**
`MAX_SESSIONS` (10) is the number it accepts to create. Each started session is its own Chromium, so size
the host for the sessions you actually run ([limits](limits.md)).

**Where does a session keep its login, and how careful should I be with it?**
Under `WWEBJS_DATA_PATH`, in one folder per session. Whoever has that folder can use the WhatsApp
account: never commit it, share it or store a copy unprotected ([sessions](sessions.md)).

**Do I need a public address?**
For REST and Socket.IO, only what your clients need to reach. A webhook target has to be a public host,
unless you list a private one in `WEBHOOK_PRIVATE_HOST_ALLOWLIST` ([webhooks](webhooks.md)).

**Does a restart lose my queued messages?**
Sends wait in a Redis queue with AOF persistence in the compose stack, and a restart continues them.
A send interrupted in the middle of its call is reported as `UNKNOWN_OUTCOME` and never sent again
([send-queue](send-queue.md)).

## Sending

**Why does my first message to a number answer `422 POLICY_BLOCKED`?**
Cold sends, to a chat where the contact has not written in the last 24 hours, are off by default
(`ALLOW_COLD_SENDS`). Replies in an open conversation are always allowed by that rule
([safety](safety.md)).

**Why did a send answer `202` instead of `201`?**
It is still waiting: for the pacing of the policy, for the session, or behind other sends. The result
arrives as `message_sent` or `message_failed` and at `GET …/send-jobs/:jobId` ([messages](messages.md)).

**How do I avoid sending a message twice?**
Send an `Idempotency-Key` (1 to 128 characters, per session, kept 24 hours). The same key with the same
request answers the first result. After `UNKNOWN_OUTCOME` the gateway never retries on its own; check the
chat and use a new key ([send-queue](send-queue.md)).

**How do I reply to, quote or mention?**
`quotedMessageId` and `mentions` are options of every send, and `POST …/messages/:messageId/reply` replies
in the chat of a message ([messages](messages.md)).

**Can I send buttons or lists?**
No: WhatsApp stopped rendering them. Use a poll ([limits](limits.md), [messages](messages.md)).

**Can I see who read my message?**
`message_ack` shows how far a message got, and `GET …/messages/:messageId/info` lists who received,
played and read it ([reactions-and-receipts](reactions-and-receipts.md)).

## Receiving

**Webhooks or Socket.IO?**
Webhooks when a server of yours receives the events and has to survive its own downtime: deliveries are
stored, retried and can be replayed. Socket.IO when a client wants the events live and wants to run
commands on the same connection. They carry the same events with the same per-session `seq`
([webhooks](webhooks.md), [websocket](websocket.md)).

**In what order do messages arrive?**
The gateway holds a burst of a chat for a moment and publishes it sorted by the sender's timestamp,
then assigns `seq`. Timestamps have one-second resolution, so messages of the same second keep the
order WhatsApp Web shows. A burst of messages from the contact also produces a `message_batch` event
([ordering](ordering.md)).

**Is every event delivered exactly once?**
At least once. Deduplicate by `seq` per session, and by `X-Gateway-Delivery` for webhooks. `seq` only
goes up and can skip, so a gap is not a lost event ([events](events.md)).

**Can I know that the contact is typing?**
No. The library has no event for it. You can show typing yourself with
`POST …/chats/:chatId/state` or with `humanize` on a send ([chats](chats.md), [limits](limits.md)).

**What if the gateway was down while messages arrived?**
When a session becomes `ready` the reconciler fetches the recent incoming messages that the gateway never
saw and publishes them as a burst ([ordering](ordering.md)).

**Can I tell that a conversation came from an ad?**
When WhatsApp attaches the Click-to-WhatsApp context, the message has an `origin` object. The gateway only
delivers it ([origin](origin.md)).

## Keys and security

**How do I give an application limited access?**
Create an API key with a `sessionId` and the scopes it needs (`read`, `send`, `events`, ...). It reaches
only that session. The raw key is shown once ([authentication](authentication.md)).

**How do I rotate a key without downtime?**
`POST /v1/api-keys/{id}/rotate` issues the new key and keeps the old one valid for
`API_KEY_ROTATION_GRACE_MINUTES` ([authentication](authentication.md)).

**Where do I find an error code?**
In [errors](errors.md), with its status and meaning; [troubleshooting](troubleshooting.md) says what to do
about the usual ones.
