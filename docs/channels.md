# Channels

The routes under `/v1/sessions/:sessionId/channels` (TDD §6.11). Each one is a call to the session's WhatsApp client, so the session must be `ready` (`409 SESSION_NOT_READY` otherwise). A channel id ends in `@newsletter`; anything else is `400 VALIDATION_ERROR`. A user (an admin, an owner) is a user id, `5215500000001@c.us` or `100000000000001@lid`.

| Operation                    | Route                                          | Scope    | Answer                                   |
| ---------------------------- | ---------------------------------------------- | -------- | ---------------------------------------- |
| `channels.list`              | `GET …/channels`                               | `read`   | `{ items }` of channels                  |
| `channels.byInvite`          | `GET …/channels/by-invite/:inviteCode`         | `read`   | the channel                              |
| `channels.search`            | `GET …/channels/search`                        | `read`   | `{ items }` of channels                  |
| `channels.create`            | `POST …/channels`                              | `manage` | `201 { name, channelId, inviteLink, createdAt }` |
| `channels.get`               | `GET …/channels/:channelId`                    | `read`   | the channel                              |
| `channels.delete`            | `DELETE …/channels/:channelId`                 | `manage` | `204`                                    |
| `channels.update`            | `PATCH …/channels/:channelId`                  | `manage` | `204`                                    |
| `channels.setPicture`        | `PUT …/channels/:channelId/picture`            | `manage` | `204`                                    |
| `channels.reactionSetting`   | `PUT …/channels/:channelId/reaction-setting`   | `manage` | `204`                                    |
| `channels.subscribe`         | `POST …/channels/:channelId/subscribe`         | `manage` | `204`                                    |
| `channels.unsubscribe`       | `POST …/channels/:channelId/unsubscribe`       | `manage` | `204`                                    |
| `channels.mute`              | `POST …/channels/:channelId/mute`              | `manage` | `204`                                    |
| `channels.unmute`            | `POST …/channels/:channelId/unmute`            | `manage` | `204`                                    |
| `channels.subscribers`       | `GET …/channels/:channelId/subscribers`        | `read`   | `{ items }` of `{ contact, role }`       |
| `channels.messages`          | `GET …/channels/:channelId/messages`           | `read`   | `{ items }` of posts                     |
| `channels.post`              | `POST …/channels/:channelId/messages`          | `send`   | `201` with the message, or `202` with the job |
| `channels.inviteAdmin`       | `POST …/channels/:channelId/admins/invite`     | `manage` | `204`                                    |
| `channels.acceptAdminInvite` | `POST …/channels/:channelId/admins/accept`     | `manage` | `204`                                    |
| `channels.revokeAdminInvite` | `DELETE …/channels/:channelId/admins/:userId/invite` | `manage` | `204`                              |
| `channels.demoteAdmin`       | `POST …/channels/:channelId/admins/:userId/demote`   | `manage` | `204`                              |
| `channels.transferOwnership` | `POST …/channels/:channelId/transfer-ownership` | `manage` | `204`                                   |

Reading a channel as a chat is `chats.get`, and marking it as seen is `chats.seen` (`Channel.sendSeen` is that call). A channel has no chat state and no history to clear: `chats.setState` and `chats.clearMessages` refuse it, and **`chats.delete` refuses it too: `channels.delete` is the way to delete a channel.**

## Reads

- **`channels.list`** is the channels WhatsApp Web has loaded (followed or owned); **`channels.get`** answers one and `404 CHAT_NOT_FOUND` for a chat that is not a channel. It has no wwebjs symbol of its own (`gateway: true`): it filters `chats.get`. A channel has `id`, `name`, `description`, `isReadOnly`, `unreadCount`, `timestamp`, `isMuted`, `muteExpiration` and `lastMessage`.
- **`channels.byInvite`** reads the channel of a link (`https://whatsapp.com/channel/<inviteCode>`) without following it. The route takes the code, not the link.
- **`channels.search`** searches the directory: `searchText`, `countryCodes` (one comma-separated value, `MX,US`), `skipSubscribedNewsletters`, `view` and `limit` (at most 100). The directory needs the session to be ready and counts as WhatsApp traffic: do not call it in a loop.
- **`channels.subscribers`** lists the subscribers that are in the account's contact list (`limit`, default 50, at most 1000) with their `role`; WhatsApp Web does not give the rest. It needs an admin account.
- **`channels.messages`** reads the latest posts WhatsApp Web has loaded (`limit`, default 50, at most 500; `fromMe`). It reads the page, not the gateway store.

## Create, follow and delete

`channels.create` takes `{ name, description?, picture? }` (name up to 100 characters, description up to 2048, picture an image from the same `source` as `profile.setPicture`: `base64`, a public `url` through the SSRF guard, or a stored message; anything that is not an image is `400`). When WhatsApp does not create the channel, wwebjs answers a text instead of throwing; the gateway turns it into `502 WHATSAPP_ERROR` (`details.reason` carries the text).

`channels.delete` deletes a channel the account owns **for every subscriber, and it cannot be undone**; keep its key out of reach of a plugin that only needs to read. `channels.subscribe` and `channels.unsubscribe` follow and unfollow; `unsubscribe` takes `{ deleteLocalModels? }`, which also removes the channel from the account. Every one of them answers `502 WHATSAPP_ERROR` when WhatsApp says it did not do it.

## Change a channel

- **`channels.update`** sets the name and/or the description, name first: a failure of the second leaves the first applied, and the `502` carries `details.failed` and `details.applied`.
- **`channels.setPicture`** and **`channels.reactionSetting`** (`{ setting: none | basic | all }`: no reactions, the six of WhatsApp, any emoji) need an admin account.
- **`channels.mute`** and **`channels.unmute`** act on the linked account only. There is no `until`: wwebjs mutes a channel for ever.

## Posting

`channels.post` takes `{ type: 'text', body, mentions? }` or `{ type: 'media', source, caption?, mentions? }` and nothing else (a poll, a location or a contact is `400`). It is a send like `messages.send`: it goes through the [send queue](send-queue.md), the [send policy and the pacing](safety.md), answers `201` with the message when it went out within `SEND_SYNC_TIMEOUT_MS` and `202` with the job otherwise (`wait=false`), and takes an `Idempotency-Key` with the same rules (the same key and post returns the first result; a post that ends `UNKNOWN_OUTCOME` is never retried). The body can be up to 40 MiB, like `messages.send`. A channel has no typing indicator or read receipt to show first, so there is no `humanize`. The policy sees the channel as one more chat: its limits and the duplicate-text guard apply.

`messages.send` with a channel id in `to` takes the same path (the worker posts to a `@newsletter` id with the channel call), and accepts text and media with a caption and mentions only: a quote (`messages.reply` on a post), a media flag or a forward to a channel is `400`, because the channel call cannot carry them.

## Admins and ownership

`channels.inviteAdmin` (`{ userId, comment? }`), `channels.revokeAdminInvite`, `channels.demoteAdmin` and `channels.transferOwnership` (`{ newOwnerId, shouldDismissSelfAsAdmin? }`; the new owner must already be an admin) need the owner account. `channels.acceptAdminInvite` is called from the account that was invited. All of them answer `502 WHATSAPP_ERROR` when WhatsApp refuses.

## What the wwebjs symbols map to

`Channel.*` methods and `Client.*` channel methods are the routes above (`Channel.deleteChannel` and `Client.deleteChannel` are both `channels.delete`, and the same for the admin calls). `Channel.sendMessage` is `channels.post`, `Channel.fetchMessages` is `channels.messages`, and the fields of `Channel` are those of `channels.list`. `MessageSendChannelOptions.extra` is not exposed (tracked in the plan with the `extra` of `messages.send`).

## Known limits

`channels.create`, `channels.subscribe` and the changes are not sends: they take no `Idempotency-Key`, and WhatsApp offers no way to ask whether a channel was created. After a `WHATSAPP_TIMEOUT` the caller must read `channels.list` before retrying, or it can create a second channel. What a real account answers (a non-owner `delete`, an unknown id in `subscribe`, the shape of the subscribers) is tracked in the plan (12.3, channels).
