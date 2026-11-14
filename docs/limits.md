# Limits

What the gateway cannot do, what it limits on purpose, and what has and has not been checked with a
real account. Each limit says where it comes from, so you can tell a rule of the gateway (a variable
moves it) from a limit of WhatsApp or of `whatsapp-web.js` (nothing in this repository moves it).
The numbers are the defaults; every variable is in [config-reference](config-reference.md).

## What comes from WhatsApp and `whatsapp-web.js`

- **No incoming typing indicator.** The library has no event for "the contact is typing", so the
  gateway has none either (see [events](events.md) for the real list). What it does offer is the
  outgoing side: `POST …/chats/:chatId/state` ([chats](chats.md)) and the typing that a send with
  `humanize` shows ([messages](messages.md)).
- **Timestamps have one-second resolution.** Two messages written in the same second can only be put in
  the order WhatsApp Web shows them; the gateway cannot tell which was written first
  ([ordering](ordering.md)).
- **It automates WhatsApp Web, not an official API.** There are no templates, no delivery guarantee from
  WhatsApp and no support channel. WhatsApp can change its web client at any time (the gateway watches
  for it, see [sessions](sessions.md) and [troubleshooting](troubleshooting.md)) and can restrict an
  account that it sees automated: the use is at your own risk, and for anything critical the official
  WhatsApp Business Platform is the right tool ([operations](operations.md)).
- **A session is a linked device.** It exists while the phone keeps the link; a logout done from the
  phone ends the session ([sessions](sessions.md)).
- **Buttons and lists are not supported.** WhatsApp stopped rendering them; polls replace them.
- **Some symbols of the library are deliberately not exposed.** Raw Puppeteer access, the custom
  authentication strategies, the `extra` option of a send, reading a file of the host and a few more,
  each one with its reason in [parity-matrix](parity-matrix.md).
- **Group writes are off by default.** Creating a group, adding, removing, promoting or demoting
  participants, revoking an invite link and joining a group answer `403 OPERATION_DISABLED` until
  `ENABLE_GROUP_WRITES=true`; see [groups](groups.md) for the reason.

## One process, one instance

- The gateway runs **exactly one replica**: a session's Chromium belongs to one Node process, and
  there is no Redis adapter for Socket.IO and no remote authentication store.
- `MAX_SESSIONS` (10) is the number of sessions the gateway accepts to create. Every started session
  is its own browser, so size the host for the sessions you start, not only for the limit.
- `SESSION_START_STAGGER_MS` spaces the starts of a restore, so a restart brings the sessions back
  one after another and not all at once ([sessions](sessions.md)).

## Sizes and counts

| Limit                                | Value                       | Where                                                  |
| ------------------------------------ | --------------------------- | ------------------------------------------------------ |
| Body of the send, reply and channel send routes | 40 MiB | `413 PAYLOAD_TOO_LARGE` over it                        |
| Body of every other route            | 1 MiB                       | `413 PAYLOAD_TOO_LARGE` over it                        |
| One media file (`MAX_MEDIA_BYTES`)   | 32 MiB (33554432 bytes)     | After decoding a base64 source, or while downloading   |
| Media downloads at once              | 4 (`MEDIA_FETCH_CONCURRENCY`) | Shared by all the sessions                           |
| Wait to download a media URL         | 30 s (`MEDIA_FETCH_TIMEOUT_MS`) |                                                    |
| Sends waiting or running per session | 500 (`SEND_QUEUE_MAX_PER_SESSION`) | `429 SEND_QUEUE_FULL`, with `Retry-After`       |
| Sends waiting or running in total    | 2000 (`SEND_QUEUE_MAX_TOTAL`) | `429 SEND_QUEUE_FULL`, with `Retry-After`            |
| Wait of a synchronous send           | 60 s (`SEND_SYNC_TIMEOUT_MS`) | Then `202` with the job, the result comes as an event |
| Wait for a session that is not ready | 5 min (`SEND_MAX_WAIT_MS`)  | Then the send fails (`message_failed`)                 |
| Longest answer awaited from WhatsApp | 185 s                       | `504 WHATSAPP_TIMEOUT`                                 |
| Requests per minute                  | 300 (`RATE_LIMIT_MAX`)      | Per API key and, separately, per client address        |
| Messages held per chat while ordering | 200 (`INBOUND_ORDER_MAX_MESSAGES`) | The buffer flushes when it fills                |
| Longest a message is held to order it | 5 s (`INBOUND_ORDER_MAX_HOLD_MS`) | Whatever keeps arriving                         |
| Recent calls kept to reject them     | 50 (`CALL_CACHE_SIZE`)      | In memory ([calls](calls.md))                          |
| Media inline in a webhook            | 5 MiB (`WEBHOOK_INLINE_MEDIA_MAX_BYTES`) | Larger media goes by URL ([webhooks](webhooks.md)) |
| Delivery attempts of a webhook       | 10 (`WEBHOOK_MAX_ATTEMPTS`) | Then the delivery is a dead letter (`failed`)                     |
| Events replayed to a socket          | 5000 events or 300 s        | `EVENT_REPLAY_MAX_EVENTS`, `EVENT_REPLAY_WINDOW_SECONDS` ([websocket](websocket.md)) |
| Packets queued for a slow socket     | 1000 (`SOCKET_MAX_QUEUED_EVENTS`) | Past it the socket is disconnected               |

A file between roughly 30 and 32 MiB sent as base64 is larger than 40 MiB once encoded and is
refused by the body limit: send it as a `url` instead ([messages](messages.md)).

## What is kept, and for how long

| Data                          | Kept                                    |
| ----------------------------- | --------------------------------------- |
| Messages the gateway stored   | `MESSAGE_RETENTION_DAYS` (30)           |
| Webhook deliveries            | `DELIVERY_RETENTION_DAYS` (14)          |
| Idempotency keys              | 24 hours                                |
| Events for the replay         | 5000 events or 300 seconds, in Redis    |
| QR codes and pairing codes    | In memory only, never stored or logged  |

The message store is a convenience for the gateway (ordering, the send policy, `…/stored-messages`),
not an archive of the account: a consumer that needs to keep a conversation keeps it itself.
`STORE_MESSAGE_BODIES=false` keeps the rows without their text.

## Delivery guarantees, and what is not guaranteed

- Events are delivered **at least once**, with a per-session `seq` that only goes up and can skip
  ([events](events.md), [webhooks](webhooks.md)): a consumer deduplicates and does not read a gap as
  a lost event.
- Sends are **idempotent** with an `Idempotency-Key` and are **never retried blindly** after an
  unknown outcome: a send whose result cannot be known ends as `UNKNOWN_OUTCOME` and the consumer
  decides ([send-queue](send-queue.md)).
- An event that WhatsApp never delivers to the gateway cannot be published. After a downtime the
  reconciler recovers the **incoming** messages of the busiest chats (`RECONCILE_MAX_CHATS` chats,
  `RECONCILE_FETCH_LIMIT` messages each, `RECONCILE_LOOKBACK_HOURS` back), and nothing else: not
  acks, not reactions, not messages the account sent ([ordering](ordering.md)).
- The gateway does not guarantee that a message **arrives**: `ack` shows how far it got
  ([reactions-and-receipts](reactions-and-receipts.md)).

## What has been checked with a real account

The automated suites run against a fake client; WhatsApp itself can only be checked by hand, and not
everything has been.

- **Checked live, one-to-one chats:** sending and receiving every message type, idempotency, media,
  signed webhooks and a restart with recovery.
- **Not checked live:** long use and real volume, calls, channels, statuses, labels, broadcasts, the
  profile and groups on the current WhatsApp Web build.
- **A patch on top of one WhatsApp Web build.** The gateway patches `whatsapp-web.js` and depends on
  the build it was checked against; a new build can break a call, and the failure then names the function that is gone with a
  `[signature]` prefix in its message ([troubleshooting](troubleshooting.md)). The pin of a verified
  build is not solved yet.

The plan tracks each open point under step 10.4 in
[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md).
