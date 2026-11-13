# Groups

The routes under `/v1/sessions/:sessionId/groups` (TDD §6.11). Each one is a call to the session's WhatsApp client, so the session must be `ready` (`409 SESSION_NOT_READY` otherwise). A group id ends in `@g.us`; anything else is `400 VALIDATION_ERROR` (a private chat or a channel is a [chat](chats.md)). A participant is a user id, `5215500000001@c.us` or `100000000000001@lid`. Messages to a group are sent with the [messages](messages.md) routes using the group id as `chatId`.

| Operation                  | Route                                              | Scope    | Answer                                     |
| -------------------------- | -------------------------------------------------- | -------- | ------------------------------------------ |
| `groups.create`            | `POST …/groups`                                    | `manage` | `201 { subject, groupId, participants }`   |
| `groups.list`              | `GET …/groups`                                     | `read`   | `{ items }` of groups                      |
| `groups.join`              | `POST …/groups/join`                               | `manage` | `{ groupId }`                              |
| `groups.inviteInfo`        | `GET …/groups/invite-info/:inviteCode`             | `read`   | `{ info }`                                 |
| `groups.get`               | `GET …/groups/:groupId`                            | `read`   | the group                                  |
| `groups.update`            | `PATCH …/groups/:groupId`                          | `manage` | `204`                                      |
| `groups.settings`          | `PATCH …/groups/:groupId/settings`                 | `manage` | `204`                                      |
| `groups.participants`      | `POST …/groups/:groupId/participants`              | `manage` | `{ participants }` or `{ status }`         |
| `groups.invite`            | `GET …/groups/:groupId/invite`                     | `manage` | `{ code, url }`                            |
| `groups.revokeInvite`      | `POST …/groups/:groupId/invite/revoke`             | `manage` | `204`                                      |
| `groups.setPicture`        | `PUT …/groups/:groupId/picture`                    | `manage` | `204`                                      |
| `groups.deletePicture`     | `DELETE …/groups/:groupId/picture`                 | `manage` | `204`                                      |
| `groups.leave`             | `POST …/groups/:groupId/leave`                     | `manage` | `204`                                      |
| `groups.membershipRequests`| `GET …/groups/:groupId/membership-requests`        | `read`   | `{ items }` of requests                    |
| `groups.approveRequests`   | `POST …/groups/:groupId/membership-requests/approve` | `manage` | `{ items }` per request                  |
| `groups.rejectRequests`    | `POST …/groups/:groupId/membership-requests/reject`  | `manage` | `{ items }` per request                  |

The V4 invite a message carries (a group invite sent to the account) is `messages.acceptGroupInvite`, not a groups route.

## Reads

- **`groups.list`** is `chats.list` without the private chats and the channels; it has no wwebjs symbol of its own (`gateway: true`). **`groups.get`** answers the group with `owner`, `createdAt`, `description` and `participants` (`isAdmin`, `isSuperAdmin`); `404 CHAT_NOT_FOUND` when the session has no such chat or it is not a group.
- **`groups.inviteInfo`** reads what WhatsApp says about the group of an invite code without joining it. The fields are WhatsApp's own, passed through sanitized (`raw` limits apply).
- **`groups.membershipRequests`** lists who asks to enter a group that needs an admin's approval. It needs an admin account.

## Create and join

`groups.create` takes `{ subject, participants, ...options }`: the options are those of wwebjs `CreateGroupOptions` (`messageTimer`, `parentGroupId`, `autoSendInviteV4`, `comment`, `memberAddMode`, `membershipApprovalMode`, `isRestrict`, `isAnnounce`). The account is the creator and is not listed. The answer has one entry per participant, with the `statusCode` WhatsApp gave: a participant that cannot be added directly gets an invite when `autoSendInviteV4` is true (the wwebjs default). When WhatsApp does not create the group, wwebjs answers a text instead of throwing; the gateway turns it into `502 WHATSAPP_ERROR` (`details.reason` carries the text).

`groups.join` takes the code at the end of an invite link, not the link. It answers `502 WHATSAPP_ERROR` for a wrong, expired or revoked code and for a group that asks an admin to approve.

## Change a group

- **`groups.update`** sets the subject (1 to 100 characters) and/or the description (up to 2048; an empty text is passed to WhatsApp Web as it is and is meant to remove it, but since WhatsApp Web 2.3000.1054445547 the value that deletes the description there is `null`, which the gateway does not translate from `''`: not verified with a live account). Subject first, then description: a failure of the second leaves the first applied, and the `502` carries `details.failed` and `details.applied`.
- **`groups.settings`** sets `messagesAdminsOnly`, `infoAdminsOnly` and `addMembersAdminsOnly`, one call each in that order; a failure leaves the ones before it applied (`details.failed`, `details.applied`). `false` is a value: it opens the setting to every member.
- **`groups.participants`** takes `{ action, participants, options? }` with `action` one of `add`, `remove`, `promote`, `demote` and up to 256 ids. `add` answers `{ participants }`, one `{ code, message, isInviteV4Sent }` per id (a `200` call can hold per-participant failures: read each `code`); the others answer the `{ status }` WhatsApp gave. `options` (`sleep`, `autoSendInviteV4`, `comment`) only apply to `add`; `sleep` is the pause in ms between two participants (at most 5000), or a `[min, max]` range with `min <= max`, and wwebjs defaults it to 250 to 500; the ids times the longest pause must not pass 120 000 ms, so the call fits the adapter's long-call timeout. `remove`, `promote` and `demote` answer `502 WHATSAPP_ERROR` (`details.status`) when the status WhatsApp gives is not 2xx.
- **`groups.setPicture`** accepts the same `source` as `profile.setPicture` (inline `base64`, a public `url` through the SSRF guard, or the image of a stored message); anything that is not an image is `400`. **`groups.deletePicture`** removes it.
- **`groups.leave`** leaves the group; the chat stays in the list until `chats.delete`.

All of them need the account to be an admin when the group restricts the action; WhatsApp refuses otherwise and the answer is `502 WHATSAPP_ERROR`.

## Invite link

`groups.invite` answers `{ code, url }` and `groups.revokeInvite` makes the old link stop working (read the new one with `groups.invite`). Both are `manage`, not `read`: the link lets anyone enter the group. The code is never logged.

## Requests to enter

`groups.approveRequests` and `groups.rejectRequests` take `{ requesterIds?, sleep? }`: one id, a list, or nothing for every pending request. The answer has one entry per request; an entry with `error` is one WhatsApp refused.

## What the wwebjs symbols map to

`GroupChat.*` methods are the routes above; `GroupChat.owner`, `createdAt`, `description` and `participants` are the fields of `groups.get`. `GroupMembershipRequest.*` are the fields of a request. `Client.createGroup`, `acceptInvite`, `getInviteInfo`, `getGroupMembershipRequests`, `approveGroupMembershipRequests` and `rejectGroupMembershipRequests` are `groups.create`, `join`, `inviteInfo`, `membershipRequests`, `approveRequests` and `rejectRequests`.

## Known limits

`groups.create`, `groups.participants` and `groups.join` take no `Idempotency-Key`: they are not sends, and WhatsApp offers no way to ask whether a group was created. After a `WHATSAPP_TIMEOUT` the caller must read `groups.list` before retrying, or it can create a second group. Tracked in the plan (12.3, groups).
