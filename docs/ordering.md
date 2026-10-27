# Inbound message ordering

A contact with no connectivity writes several messages; when WhatsApp reconnects it delivers them in one burst, in any arrival order. The gateway holds such a burst briefly and publishes it sorted by the time the sender wrote each message, so `seq` order equals conversation order.

Ordering applies to the `message` and `message_create` events only. Every other event passes straight through, except the events about a message that is currently held (see [Events about a held message](#events-about-a-held-message)).

## The algorithm

1. A message is **late** when `receivedAt − sentAt` is greater than `INBOUND_LATE_THRESHOLD_S` (3 s by default). `sentAt` is the timestamp WhatsApp gives the message; `receivedAt` is when the gateway got it.
2. A message that is not late, in a chat with nothing held, is published at once: normal chats pay no delay.
3. Otherwise the message joins the buffer of its chat. A real-time message that arrives while the chat has a buffer open joins it too, so it cannot overtake the older ones.
4. Every arrival restarts a debounce timer of `INBOUND_ORDER_WINDOW_MS`. The buffer is flushed early when it has been open `INBOUND_ORDER_MAX_HOLD_MS`, or holds `INBOUND_ORDER_MAX_MESSAGES` messages.
5. On flush the messages are sorted by `sentAt`. Ties in the same second are broken by the order WhatsApp Web shows in that chat (one `fetchMessages` per flush, matched by message id), then by `receivedAt`, then by arrival. A message WhatsApp Web does not list sorts after the ones it lists. If the fetch fails, the last two tiebreaks still apply.
6. Each message is published with `data.ordering = { held: true, reordered, heldMs }`. `reordered` is true when its position changed against the order it arrived in (a late message that moves to the front also shifts the ones behind it, and those are flagged too); `heldMs` is how long it waited.
7. `seq` is assigned when the message is published, after sorting.

A chat whose buffer is being released keeps queueing new messages behind it, so a later message never overtakes a batch that is still being published.

## `message_batch`

When a flushed buffer holds two or more messages **from the contact** (`fromMe=false`), one `message_batch` event follows them. It carries every message of the burst in order, including the ones the session or the phone sent, so a bot sees what was already answered: `messages`, `firstSentAt`, `lastSentAt`, `count`, the first `origin` found, and `reason` (`burst`, or `reconcile` when the reconciler offered any of them; a message already held keeps the reason it was first offered with). Check `fromMe` on each message. A burst of only your own messages makes no batch. Chatbots should answer once per `message_batch` instead of once per `message`.

## Events about a held message

`message_ack`, `message_edit`, `message_reaction` and `message_revoke_*` for a message that is still held wait behind it and are published right after it. Once the message is out they pass through as usual.

## Crash safety

Held messages are stored with `emittedAt` null. The buffer keeps nothing durable: when the process stops, whatever it held is dropped, and the pipeline feeds the stored rows with `emittedAt` null back through the buffer on the next `ready`. Nothing is lost: a stored message is published later, in order, from the database.

The same holds when publishing fails. The buffer never retries: it cannot tell which messages of a batch were already published, and a retry would duplicate them. It logs the failure and carries on, the rows keep `emittedAt` null, and the pipeline replays them in order, per chat. Events about a held message (acks, edits, reactions, revokes) are not stored for replay: if publishing them fails, they are dropped, and the message itself is not affected. Until that replay, newer messages of the chat can be published before the ones that failed, so consumers must sort by `sentAt` and drop duplicates by `id`.

## Configuration

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `INBOUND_ORDERING_ENABLED` | `true` | Turns the buffer off for every session |
| `INBOUND_LATE_THRESHOLD_S` | `3` | Seconds of `receivedAt − sentAt` after which a message is late |
| `INBOUND_ORDER_WINDOW_MS` | `1500` | Debounce: how long the buffer waits for earlier messages after the last arrival |
| `INBOUND_ORDER_MAX_HOLD_MS` | `5000` | Longest a buffer stays open, whatever keeps arriving |
| `INBOUND_ORDER_MAX_MESSAGES` | `200` | Messages that force a flush |

See [config-reference.md](config-reference.md) for the validation rules.

## Limits

- WhatsApp timestamps have **1-second resolution**. Messages written in the same second can only be ordered the way WhatsApp Web shows them; the gateway cannot do better.
- Ordering is best effort for messages the contact wrote while offline: a message that reaches the gateway after its buffer was flushed is published after it, on its own or in a later buffer.
- Lateness compares the gateway clock with the WhatsApp timestamp. Keep the host clock synchronized (NTP): a clock more than `INBOUND_LATE_THRESHOLD_S` ahead makes every message late, and every chat then pays the debounce; a clock behind disables the hold.
- Delivery to consumers is at-least-once.

## Recommended consumer pattern

React to `message_batch` and answer once. As a safety net, sort the messages you process by `sentAt` and drop duplicates by message `id`.
