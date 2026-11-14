# Reactions and receipts

How a consumer learns that someone reacted to a message, and who received, played or read one of
its own (TDD §6.11). Three routes under `/v1/sessions/:sessionId/messages/:messageId` and two
events. Each route is a call to the WhatsApp client of the session, so the session has to be
`ready` (`409 SESSION_NOT_READY` otherwise) and the message has to be one the client can find
(`502 WHATSAPP_ERROR` with the text "Message not found" otherwise, see [errors](errors.md)). `:messageId` is the serialized id of the message, such as
`false_5215500000001@c.us_3EB0C767D0F2A2B91F42` (the `id` field of a [message](messages.md)).

| Operation            | Route                          | Scope  | Answer                                      |
| -------------------- | ------------------------------ | ------ | ------------------------------------------- |
| `messages.react`     | `POST …/react`                 | `send` | `204`, no body                              |
| `messages.reactions` | `GET …/reactions`              | `read` | `{ items: ReactionListDto[] }`              |
| `messages.info`      | `GET …/info`                   | `read` | `{ delivery, played, read, …Remaining }`    |

The socket commands are `message.react`, `message.reactions` and `message.info`
([websocket-commands](websocket-commands.md)).

## React to a message

`POST …/react` takes `{ "reaction": "👍" }`: an emoji of up to 32 characters. An empty string
removes the reaction the session had put. It answers `204`.

```bash
curl -X POST "http://localhost:3000/v1/sessions/main/messages/$MESSAGE_ID/react" \
  -H "X-API-Key: $API_KEY" -H 'Content-Type: application/json' \
  -d '{"reaction":"👍"}'
```

Unlike a send, a reaction does not go through the [send queue](send-queue.md) or the
[send policy](safety.md): the call goes straight to WhatsApp and the answer is the outcome of that
call. A reaction on a message of a chat the account cannot write to fails like any WhatsApp call
(`502 WHATSAPP_ERROR`).

## Read the reactions of a message

`GET …/reactions` answers the reactions grouped by emoji:

```bash
curl "http://localhost:3000/v1/sessions/main/messages/$MESSAGE_ID/reactions" \
  -H "X-API-Key: $API_KEY"
```

Each item of `items` has:

| Field             | Meaning                                                                       |
| ----------------- | ----------------------------------------------------------------------------- |
| `id`              | Id of the group, the emoji itself                                             |
| `aggregateEmoji`  | The emoji WhatsApp shows for the group                                        |
| `hasReactionByMe` | `true` when the session itself put that reaction                              |
| `senders`         | A `Reaction` for each sender (fields below)                                   |

A message nobody reacted to answers `{ "items": [] }`. An item that the gateway cannot read is left
out of the list (and counted in a warning of the log) instead of failing the whole answer.

## The `Reaction` fields

The same object is the payload of the `message_reaction` event and each element of `senders`:

| Field          | Type    | Meaning                                                                                      |
| -------------- | ------- | -------------------------------------------------------------------------------------------- |
| `id`           | string  | Serialized key of the reaction message (`msgKey` in `whatsapp-web.js`)                       |
| `msgId`        | string  | Serialized key of the message that was reacted to                                            |
| `reaction`     | string  | The emoji; empty or absent when the reaction was removed                                     |
| `senderId`     | string  | Who reacted                                                                                  |
| `timestamp`    | integer | Unix seconds                                                                                 |
| `read`         | boolean | WhatsApp's read flag of the reaction                                                         |
| `ack`          | integer | Ack of the reaction message, same levels as below                                            |
| `orphan`       | integer | WhatsApp's own flag: not `0` when the reaction has no original message in the client         |
| `orphanReason` | string  | WhatsApp's reason for the orphan state, when there is one                                    |

`orphan` and `orphanReason` are passed through as `whatsapp-web.js` reads them from WhatsApp Web;
the gateway does not interpret them. A consumer that must not act on a reaction whose message it
cannot find should check `orphan` first. The exact shape of each field is in
[events](events.md#reactiondto).

## The `message_reaction` event

`message_reaction` fires when a reaction is sent, received, changed or removed, and its `data` is a
`Reaction`. It goes through the same pipeline as the other events of a message
([ordering](ordering.md)):

- It is **deduplicated** on the message, the reaction and a hash of the emoji (the emoji itself never
  goes into a Redis key), so a reconnect that makes `whatsapp-web.js` emit it again does not publish
  it twice. A change of emoji is a new event.
- When the message it is about is still **held by the order buffer**, the reaction waits behind it
  and is published right after the message, never before.
- It carries a per-session `seq` like every event, over [webhooks](webhooks.md) and
  [websocket](websocket.md).

The gateway does not store reactions: to know the current state of a message, call
`GET …/reactions`.

## Ack levels and the `message_ack` event

The `ack` of a message tells how far it got:

| `ack` | Name    | Meaning                                    |
| ----- | ------- | ------------------------------------------ |
| `-1`  | error   | The message could not be sent              |
| `0`   | pending | Not yet accepted by the WhatsApp server    |
| `1`   | server  | Accepted by the WhatsApp server            |
| `2`   | device  | Delivered to a device of the recipient     |
| `3`   | read    | Read by the recipient                      |
| `4`   | played  | Played (voice notes and video)             |

The `message_ack` event carries `{ message, ack }` each time the level changes. It is deduplicated
on the message and the level, so the same level is published once, and the gateway stores the new
level in the stored copy of the message (`GET …/stored-messages`). A consumer
that needs to know whether a send arrived listens for `message_ack` of the `id` it got back in
`message` of the `message_sent` event ([send-queue](send-queue.md)).

## Receipts: who received, played and read

`GET …/info` answers, for a message **the account sent**, the people that got each level:

```bash
curl "http://localhost:3000/v1/sessions/main/messages/$MESSAGE_ID/info" \
  -H "X-API-Key: $API_KEY"
```

```json
{
  "delivery": [{ "id": "5215500000001@c.us", "t": 1731600000 }],
  "deliveryRemaining": 0,
  "played": [],
  "playedRemaining": 0,
  "read": [{ "id": "5215500000001@c.us", "t": 1731600030 }],
  "readRemaining": 1
}
```

- `delivery`, `played` and `read` list the ids that reached that level and the time (`t`, unix
  seconds). The `…Remaining` counters are how many participants have not reached it yet; they matter
  in groups, where the lists grow one member at a time.
- A message that is not the account's own, or that WhatsApp holds no receipts for, answers
  `404 NOT_FOUND`: *"has no delivery info (only messages sent by the account have it)"*.
- The lists are what WhatsApp Web reports; the gateway adds nothing to them.
