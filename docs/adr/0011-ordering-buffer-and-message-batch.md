# ADR 0011: inbound messages are ordered by the sender's time, before `seq`

Status: Accepted (2026-10-28)

## Context

When a contact has no connectivity and writes several messages, WhatsApp delivers them in one burst, in
any arrival order. A consumer that answers in arrival order answers the wrong message first. Two
properties are wanted at once: `seq` (a per-session, ever-growing number) must be the order a consumer
reads the conversation in, and a normal chat must not pay a delay for a feature it does not need.

## Decision

- **The event pipeline is fixed:** dedupe, store, per-chat order buffer, `seq`, publish. `seq` is
  assigned **after** ordering, from a Redis counter, so `seq` order is the corrected order and also the
  delivery order.
- **Order by the sender's `sentAt`** (one-second resolution). Ties are broken by the order WhatsApp Web shows
  in that chat (one `fetchMessages` per flush), then by `receivedAt`, then by arrival.
- **Hold only what can be out of order.** A message is late when `receivedAt - sentAt` exceeds
  `INBOUND_LATE_THRESHOLD_S`. A message that is not late, in a chat with nothing held, is published at
  once. A late one opens (or joins) the buffer of its chat, which flushes on a debounce
  (`INBOUND_ORDER_WINDOW_MS`), a maximum hold (`INBOUND_ORDER_MAX_HOLD_MS`) or a size
  (`INBOUND_ORDER_MAX_MESSAGES`).
- **Held messages are crash-safe through the database, not through the buffer.** They are stored with
  `emittedAt` null; the buffer itself keeps nothing durable. On every `ready` the stored rows with
  `emittedAt` null go back through the buffer. A crash between publishing and marking publishes a message
  twice, with a new event `id`, so delivery is at-least-once and consumers drop duplicates by `data.id`.
- **`message_batch` is a synthesized event.** When a flushed buffer holds two or more messages from the
  contact, one `message_batch` follows them, with the whole burst in order, so a consumer can react once.
  Catch-up reconciliation after a downtime feeds recovered messages through the same path.

`message_batch` is always emitted today. The variable `MESSAGE_BATCH_ENABLED` is declared in the
environment schema and nothing reads it; this is a known defect, tracked in the plan (step 10.4), and
`docs/ordering.md` says so.

## Consequences

- Normal chats see no added latency; a late burst waits at most `INBOUND_ORDER_MAX_HOLD_MS`.
- The ordering cannot beat the one-second resolution of WhatsApp timestamps; messages written in the same
  second are ordered as WhatsApp Web shows them.
- Lateness compares the gateway clock with WhatsApp's, so the host clock must be synchronized.
- Because the buffer is in memory and per process, this is part of why the gateway is single-instance
  (ADR 0009).

## Alternatives considered

- **Publish in arrival order and leave sorting to the consumer:** every consumer would need its own
  buffer and its own timing.
- **Assign `seq` before ordering:** `seq` would no longer mean conversation order, and a replay by `seq`
  would replay the wrong order.
- **Always delay every message by a fixed window:** a cost paid by every chat to fix a rare burst.
- **Keep the held messages durably in Redis or in the buffer:** a second store to keep consistent with the
  message table; the `emittedAt` column gives the same recovery with the data that is stored anyway.
