# Inbound message ordering

A contact with no connectivity writes several messages; when WhatsApp reconnects it delivers them in one burst, in any arrival order. The gateway holds such a burst briefly and publishes it sorted by the time the sender wrote each message, so `seq` order equals conversation order.

Ordering applies to the `message` and `message_create` events only (and to every message, own ones included). Every other event passes straight through, except the events about a message that is currently held (see [Events about a held message](#events-about-a-held-message)).

## The pipeline

Every event of a session goes through the same steps, one event at a time, in the order the client emitted them:

1. **Dedupe.** Events that carry a message are claimed in Redis (`SET dedupe:<session>:<event>:<message id>[:<ack or hash>] NX EX 600`); a repeat inside ten minutes is dropped. `message_ack` is keyed by message and ack, `message_edit` and `message_reaction` by a hash of the new text or emoji (never the text itself). If Redis is not connected the check is skipped at once, and if it does not answer within a second it is abandoned: the event is processed anyway.
2. **Store.** `message` and `message_create` are upserted into `messages` with `emittedAt` null; `message_ack` moves the stored ack forward (an older ack never lowers a newer one; `-1`, an error, always applies). A failure is logged, counted in `gw_pipeline_errors_total{stage="store"}` and never blocks the stream.
3. **Order.** The order buffer below decides whether the message is published now or held.
4. **Stamp and publish.** `seq` comes from a Redis `INCR seq:<session>` when the event is published, so `seq` order equals the corrected order. All the events of a session, those of the client and the ones the gateway makes up (`session_status`, `message_sent`, ...), are stamped and delivered through one queue, so `seq` order is also delivery order. A batch is published without any other event in the middle.
5. **Mark.** The stored rows get `emittedAt`.

`seq` keeps growing across restarts because it lives in Redis, which runs with AOF (TDD §6.14). If Redis loses its data, the counter starts again from 1.

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

`message_ack`, `message_edit`, `message_reaction` and `message_revoke_*` for a message that is still held wait behind it and are published right after it. Once the message is out they pass through as usual. The twin event of a held message (wwebjs emits `message` and `message_create` for the same incoming message) waits behind it too, so both are published, in the order they arrived.

## Crash safety

Held messages are stored with `emittedAt` null. The buffer keeps nothing durable: when the process stops, whatever it held is dropped. On every `ready` (first start, reconnect, restart) the pipeline feeds the stored incoming rows with `emittedAt` null back through the buffer, oldest first, and they are published sorted like any burst. A message already held in memory is not fed twice. Nothing is lost: a stored message is published later, in order, from the database. A recovered message is published as `message` (the `message_create` twin is not stored), and without text when `STORE_MESSAGE_BODIES=false`.

The same holds when publishing fails (Redis cannot assign a `seq`, or is not connected). The buffer never retries a batch: it cannot tell which messages were already published, and a retry would duplicate them. The pipeline stops the batch at the first failure, marks the messages that did go out, and replays the chat from the rows still unpublished, in order, after 5 seconds. Each new failure of the chat doubles the wait, up to 60 seconds, and a successful publish resets it. The replayed messages form a burst of their own; its `message_batch` also lists the messages of the original burst that had already gone out, so a bot that reads only batches sees the whole burst (this context lives in memory: after a restart the batch holds the recovered messages only). A batch whose summary alone fails is not replayed. Events about a held message (acks, edits, reactions, revokes) are not stored for replay: if publishing them fails, they are dropped and counted, and the message itself is not affected. Until the replay, newer messages of the chat can be published before the ones that failed, so consumers must sort by `sentAt`.

A recovery on `ready` does not wait for the messages being published at that moment; it skips them, and it skips the ones that were marked as published while it was reading the table. When a session stops, the batch being published finishes its current message and no more: the rest stays stored for the next start. The events about a message of a failed batch (acks, edits, reactions, revokes) wait for the replay and go out right behind it, under the same event name it arrived with. A stored row that no longer fits the DTO (written by another version) is counted once and marked as published, since it can never be sent. If a message cannot be stored, its dedupe claim in Redis is released, so the repeat of the event is processed. A crash between the claim and the store still loses that one event (the repeat is dropped as a duplicate for ten minutes); the reconciler can recover it from WhatsApp on a later `ready`, once the claim has expired. An event about a message (ack, edit, reaction, revoke) that arrives after its batch failed and before the replay is published at once, ahead of the message: sort by `sentAt` and treat an event about a message you have not seen as early. An outgoing message whose publish fails is not replayed (only incoming messages are stored for replay).

If the process dies after publishing a message and before marking it, the message is published again on the next `ready`, with a new event `id`. Delivery is at-least-once: **drop duplicates of a message by `data.id`**, not only by the `id` of the event.

Every failure of the pipeline is counted in `gw_pipeline_errors_total` by stage (`dedupe`, `store`, `publish`, `replay`, `event`), and logged with the error class only, never the message. A stage that keeps failing logs once every 10 seconds; the counter still counts every failure.

## Configuration

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `INBOUND_ORDERING_ENABLED` | `true` | Turns the buffer off for every session (a session can also turn it off with `settings.ordering.enabled`) |
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

React to `message_batch` and answer once. As a safety net, sort the messages you process by `sentAt` and drop duplicates by message `id` (`data.id`).
