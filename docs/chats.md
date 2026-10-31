# Chats

The routes under `/v1/sessions/:sessionId/chats` (TDD §6.11). Each one is a call to the session's WhatsApp client, so the session must be `ready` (`409 SESSION_NOT_READY` otherwise). A chat id is the serialized WhatsApp id (`5215500000001@c.us`, `120363000000000001@g.us`, `…@newsletter`). Sending a message is [`messages.send`](messages.md), not a chats route.

A route on one chat first checks that the chat exists: WhatsApp Web answers a call on a chat it does not know with a failure that cannot be told from a real one, so the gateway answers `404 CHAT_NOT_FOUND` before it touches anything.

| Operation              | Route                                 | Scope    | Answer                                   |
| ---------------------- | ------------------------------------- | -------- | ---------------------------------------- |
| `chats.list`           | `GET …/chats`                         | `read`   | `{ items }`: chats, groups and channels  |
| `chats.get`            | `GET …/chats/:chatId`                 | `read`   | the chat                                 |
| `chats.messages`       | `GET …/chats/:chatId/messages`        | `read`   | `{ items }` of messages                  |
| `chats.pinnedMessages` | `GET …/chats/:chatId/pinned-messages` | `read`   | `{ items }` of messages                  |
| `chats.setState`       | `POST …/chats/:chatId/state`          | `send`   | `204`                                    |
| `chats.seen`           | `POST …/chats/:chatId/seen`           | `send`   | `204`                                    |
| `chats.markUnread`     | `POST …/chats/:chatId/mark-unread`    | `manage` | `204`                                    |
| `chats.archive`        | `POST …/chats/:chatId/archive`        | `manage` | `204`                                    |
| `chats.unarchive`      | `POST …/chats/:chatId/unarchive`      | `manage` | `204`                                    |
| `chats.pin`            | `POST …/chats/:chatId/pin`            | `manage` | `204`                                    |
| `chats.unpin`          | `POST …/chats/:chatId/unpin`          | `manage` | `204`                                    |
| `chats.mute`           | `POST …/chats/:chatId/mute`           | `manage` | `{ isMuted, muteExpiration }`            |
| `chats.unmute`         | `POST …/chats/:chatId/unmute`         | `manage` | `{ isMuted, muteExpiration }`            |
| `chats.clearMessages`  | `POST …/chats/:chatId/clear-messages` | `manage` | `204`                                    |
| `chats.delete`         | `DELETE …/chats/:chatId`              | `manage` | `204`                                    |
| `chats.syncHistory`    | `POST …/chats/:chatId/sync-history`   | `manage` | `204`                                    |

Labels and customer notes of a chat belong to steps 6.4 and 6.7.

## Reads

- **`chats.list` and `chats.get`** answer the kind of chat WhatsApp Web has: a private chat, a group (with `owner`, `createdAt`, `description` and `participants`) or a channel (its own fields).
- **`chats.messages`** reads the messages WhatsApp Web has loaded, oldest first: `limit` (1 to 500, default 50) and `fromMe` (`true` the account's own, `false` the others'). It is what the page holds, not the history the gateway stored, which is [`messages.stored`](messages.md).

## Typing and recording (`chats.setState`)

`POST …/chats/:chatId/state` with `{ "state": "typing" | "recording" | "clear", "durationMs"?: 1..25000 }`. It is also the socket command `chat.state`.

- `typing` and `recording` show "typing…" or "recording audio…" to the other side. WhatsApp lets the indicator lapse about 25 s after it is shown. `clear` stops it at once.
- With `durationMs` the gateway sends `clear` when that time ends. A new state on the same chat replaces the countdown, and `clear` cancels it. A clear that fails when the countdown ends is only logged.
- **Limit:** the countdown lives in memory. If the gateway restarts before it ends, the indicator lapses by itself within 25 s, which is why `durationMs` cannot be larger than that. The countdown knows nothing of the typing a send with `humanize` shows on the same chat, so it may cut that short when it ends.
- A text sent with `humanize` shows its own typing; this route is for a client that wants the indicator without sending, or for a longer pause before a reply.
- A channel has no chat state (`502 WHATSAPP_ERROR`).

## Actions

- **`chats.seen`** sends the read receipt of the chat: the other side sees the blue ticks. `chats.markUnread` only changes how the linked phone shows the chat.
- **`chats.archive`, `unarchive`, `pin`, `unpin`, `seen`, `clearMessages`, `delete`, `syncHistory`** answer `502 WHATSAPP_ERROR` when WhatsApp Web says it did not do it. WhatsApp allows three pinned chats.
- **`chats.mute`** takes `until` (ISO date, in the future) or nothing to mute for ever; a past date is `400 VALIDATION_ERROR`. `muteExpiration` is Unix seconds, `-1` for ever, `0` when not muted.
- **`chats.clearMessages` and `chats.delete`** act on the linked account only; the other side keeps its copy, and they cannot be undone. The copy in the gateway store stays until its retention ends. A channel has no history to clear and is not deleted here.
- `chats.syncHistory` asks the linked phone for older messages; they arrive over time as events, not in the answer.

## Errors

`SESSION_NOT_READY` (409), `CHAT_NOT_FOUND` (404), `VALIDATION_ERROR` (400), `INSUFFICIENT_SCOPE` (403) and `WHATSAPP_ERROR` / `WHATSAPP_TIMEOUT` (502 / 504). See [errors.md](errors.md).
