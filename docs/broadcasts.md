# Broadcasts (statuses)

The read routes for the statuses (stories) WhatsApp Web holds (TDD §6.11): `/v1/sessions/:sessionId/broadcasts`. Each one is a call to the session's WhatsApp client, so the session must be `ready` (`409 SESSION_NOT_READY` otherwise). A broadcast is the set of status updates of one user; the account's own statuses are one more broadcast.

| Operation         | Route                              | Scope  | Answer                    |
| ----------------- | ---------------------------------- | ------ | ------------------------- |
| `broadcasts.list` | `GET …/broadcasts`                 | `read` | `{ items }` of broadcasts |
| `broadcasts.get`  | `GET …/broadcasts/:broadcastId`    | `read` | the broadcast             |

A broadcast is `{ id, timestamp, totalCount, unreadCount, msgs }`: `id` is the id of the user who posted, `timestamp` the time of the last status, `totalCount` the statuses available, `unreadCount` those not yet viewed and `msgs` the status messages (as `messages.get` answers a message). `:broadcastId` is a user id (`@c.us` or `@lid`), the same one `contacts.get` takes.

- **`broadcasts.get`** answers `404 NOT_FOUND` when WhatsApp Web holds no statuses of that user (the library then builds a broadcast with no `id`, which the gateway does not pass on as an empty one). `contacts.broadcast` answers the same way.
- **`broadcasts.list`** leaves out any broadcast the page returns without an `id`.

## Posting and revoking

Reading is all this controller does. Posting a status is [`messages.send`](messages.md) to `status@broadcast`, and revoking one of the account's own is `messages.revokeStatus`; both go through the send queue and the send policy like any other send.

## What the other wwebjs symbols map to

`Broadcast.getChat` is [`chats.get`](chats.md) and `Broadcast.getContact` is [`contacts.get`](contacts.md), both with the `id` of the broadcast. The fields of `Broadcast` are the fields of the broadcast above.
