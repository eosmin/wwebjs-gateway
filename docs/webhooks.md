# Webhooks

The routes under `/v1/webhooks` (TDD §6.9 and §6.11). A webhook is a URL the gateway POSTs events to. All the operations need the `webhooks` scope and are the gateway's own: no wwebjs symbol maps to them.

| Operation | Route | Answer |
| --- | --- | --- |
| `webhooks.create` | `POST /v1/webhooks` | `201` with the webhook and its `secret` |
| `webhooks.list` | `GET /v1/webhooks` | `200` with `{ webhooks }` |
| `webhooks.get` | `GET /v1/webhooks/:id` | `200` with the webhook |
| `webhooks.update` | `PATCH /v1/webhooks/:id` | `200` with the webhook |
| `webhooks.delete` | `DELETE /v1/webhooks/:id` | `204`, no body |
| `webhooks.rotateSecret` | `POST /v1/webhooks/:id/rotate-secret` | `200` with the webhook and the new `secret` |
| `webhooks.test` | `POST /v1/webhooks/:id/test` | `202` with the pending delivery of a `ping` |
| `webhooks.listDeliveries` | `GET /v1/webhooks/:id/deliveries` | `200` with `{ items, nextCursor }` |
| `webhooks.retryDelivery` | `POST /v1/webhooks/:id/deliveries/:deliveryId/retry` | `202` with the delivery |
| `webhooks.retryFailed` | `POST /v1/webhooks/:id/deliveries/retry-failed` | `200` with `{ retried, more }` |

## Who reaches what

An admin key (the bootstrap key, or a database key without a session) reaches every webhook. A session key reaches the webhooks of its own session and nothing else: it cannot create one for another session or for every session, it does not see them in the list, and the ones it asks for by id answer `403 FORBIDDEN`. Everything under a webhook (its secret, its deliveries) follows the webhook. A webhook that does not exist is `404 NOT_FOUND`.

## A webhook

`{ id, sessionId, url, events, enabled, mediaMode, includeRaw, createdAt }`.

- `sessionId`: the session whose events are delivered. `null` is the events of every session, which only an admin key can create. The session of a webhook never changes: delete it and create another.
- `url`: `http` or `https` on a public host. The address check runs when the webhook is created or changed, and again before every delivery, so a name that later resolves to a private address stops working. Targets on a private network (such as `http://bot:3000`) need `WEBHOOK_PRIVATE_HOST_ALLOWLIST`. `ALLOW_PRIVATE_WEBHOOK_TARGETS` lets private and loopback targets through for development; the gateway refuses to start with it on when `NODE_ENV=production`, and the cloud metadata and link-local addresses (`169.254.0.0/16`, `fe80::/10`, Alibaba's `100.100.100.200`) stay blocked even when it is on; the name of the URL must still resolve ([config](config-reference.md)).
- `events`: the event names delivered ([events](events.md)), or `["*"]` for every event. It defaults to `["*"]`; a `*` among other names replaces them.
- `enabled`: a disabled webhook receives nothing. It defaults to `true`.
- `mediaMode`: `none` (no `media` block), `reference` (the type, name, size and a download URL, the default) or `inline` (the same plus the bytes in base64, up to `WEBHOOK_INLINE_MEDIA_MAX_BYTES`). See *Media* below.
- `includeRaw`: whether message events carry the sanitized raw data. `null`, the default, follows `INCLUDE_RAW`. `true` is refused with `400 VALIDATION_ERROR` while `INCLUDE_RAW` is off, because the gateway then attaches no raw data to any message and the webhook would never get it; `false` and `null` are always accepted. If `INCLUDE_RAW` is turned off later, a webhook that already has `true` simply receives no `raw`.

Every change takes effect on the next event. The gateway keeps the list of enabled webhooks per session in memory and drops it on every write.

## The secret

The secret (`whsec_…`) signs the deliveries. It is in the answer of `webhooks.create` and `webhooks.rotateSecret` and nowhere else: the gateway returns it once and no read gives it back, so keep it when you get it.

**Rotating the secret takes effect at once, also for the deliveries that are waiting for a retry.** The signature of a delivery is made with the secret the webhook has at each attempt, not the one it had when the event happened. After a rotation a receiver that still checks with the old secret rejects the next attempt of everything that was queued, and those attempts count against `WEBHOOK_MAX_ATTEMPTS`. Rotate when the receiver can accept the new secret straight away, or be ready to run `retry-failed` once it does. The same holds for the URL: a change of `url` applies to the queued deliveries on their next attempt.

## Testing a webhook

`POST /v1/webhooks/:id/test` queues a `ping` event to the webhook through the same path as the real events (signature, address check, retries) and answers the pending delivery. Follow it with `GET …/deliveries`. A ping is a delivery like any other: it shows in the list, and when it fails it can be retried.

- A webhook of one session sends the ping as that session. A webhook of every session needs `{ "sessionId": "…" }` in the body to say which one, and the session must exist.
- The ping has `data: {}` and `seq: 0`. Real events start at `seq` 1, so a ping is never taken for one, and a receiver that drops what it has already seen does not drop a real event because of it. It is not part of the sequence of the session: do not use it to detect gaps.
- A disabled webhook can be tested, so a receiver can be checked before it is turned on. The ping reaches the receiver only through the processor, as any delivery; the address check runs on it too.

## From event to delivery

Every event of every session goes through the dispatcher. For each **enabled** webhook of that session (or of every session) whose `events` has the event name or `*`, it stores one delivery (`pending`) and queues one job. A webhook that does not want the event costs nothing, and the `ping` of a test never passes here: it is created by the route.

- **What each webhook receives.** The event is shaped per webhook, on a copy, so the Socket.IO stream and the other webhooks see their own:
  - `raw` stays on a message only when `includeRaw` is `true`, or `null` and `INCLUDE_RAW` is on. A webhook cannot ask for more than the event has: with `INCLUDE_RAW` off the gateway attaches no `raw` at all (which is why `includeRaw: true` is refused then).
  - `mediaMode: none` removes `media`; `reference` keeps `media` without `base64`; `inline` adds the bytes (see *Media*).
  - These apply to the messages of `message`, `message_create`, `message_ack`, `message_edit`, `message_revoke_everyone`, `message_revoke_me`, `message_ciphertext`, `message_ciphertext_failed`, `media_uploaded`, `message_sent`, `contact_changed`, the `lastMessage` of the chat in `unread_count`, `chat_removed` and `chat_archived`, and every message of a `message_batch`.
- **What is stored.** The job in Redis carries the event as the receiver gets it. The row in `webhook_deliveries` (what a manual retry sends again) carries a redacted copy: the text of a `qr` and the pairing `code` become `[Redacted]`, and inline `base64` is dropped. Because of that, **a delivery of a `qr` or a `code` cannot be retried by hand**: the stored copy has no credential left to send, and both expire within a minute anyway. `retry` answers `400 VALIDATION_ERROR` for them and `retry-failed` leaves them where they are. The automatic retries of a fresh delivery are not affected: the job carries the real value.
- **Failures never lose an event silently, and never stop another webhook.**
  - If the row cannot be stored (the database is down), the job is queued all the same: a receiver must not miss an event because the log is down. That delivery has no row, so it is not in the list and nothing records its attempts. It is counted as `gw_webhook_deliveries_total{result="unlogged"}`.
  - If the job cannot be queued (Redis is down), the row goes to `failed` with `lastError: "The delivery could not be queued"`, so it shows among the dead letters and `retry` / `retry-failed` send it from the stored copy. It is counted as `result="not_queued"`. If neither the row nor the job could be made, the event is lost for that webhook and only the error log (event, session and `seq`, never the payload) says so.
- **A crash between the row and the job** (the process stops after the row is stored and before the job is queued) leaves a `pending` row with nothing to run it. The sweep described under *Retention and stale deliveries* sends it to `failed` within about 40 minutes, where `retry` can pick it up; `retry` only takes `failed` deliveries.
- **Order.** Deliveries are stored and queued as the events arrive, but each retries on its own, so the receiver orders by `seq` (see above).

## Media

A message that carries a file has `data.media = { mimetype, filename?, size?, downloadUrl }`, taken from what WhatsApp Web holds of it, without downloading anything. `filename` and `size` are left out when WhatsApp Web does not know them. `downloadUrl` is the `messages.media` route of the gateway on `PUBLIC_BASE_URL`; it needs an API key with the `read` scope, as every route does. A message whose raw data names no type has no `media` block (its `hasMedia` still says there is a file). The block is on the message of every event that carries messages, and in the Socket.IO stream too.

`mediaMode: inline` adds `media.base64` on the events that bring a **new** message (`message`, and every message of a `message_batch`). The gateway downloads the file once for the event, however many webhooks take it, and only when:

- some webhook of the event is in `inline` mode;
- the `size` on the message is known and at most `WEBHOOK_INLINE_MEDIA_MAX_BYTES`. A file of unknown size is not downloaded to find out, and a file that turns out larger than it said is not inlined either.

Every other case, a download that fails, a file WhatsApp no longer has, a session that is no longer ready, is not an error: the event is delivered with the `downloadUrl` and no `base64`. Acks, edits, revocations and the other events that repeat an old message never download anything.

**A retry by hand of an `inline` delivery sends the stored copy, which has no `base64`** (the table never keeps the bytes). The receiver gets the `downloadUrl` and fetches the file from it. The automatic retries of a fresh delivery are not affected: the job carries the bytes. The gateway does not download the file again for a retry because the session may be gone, the file may no longer be there, and a retry made days later would then send a different answer than the event had.

## Deliveries and dead letters

Every event sent to a webhook is a delivery: `{ id, webhookId, sessionId, event, seq, status, attempts, lastStatusCode, lastError, createdAt, deliveredAt }`. The event itself stays in the gateway and is not returned, because it can be a message.

| `status` | Meaning |
| --- | --- |
| `pending` | Waiting for an attempt or for the next retry. |
| `success` | The receiver answered with a `2xx`. Final. |
| `failed` | Every attempt failed. A dead letter. |

`GET /v1/webhooks/:id/deliveries` lists newest first. `?status=failed` lists the dead letters. It pages with `limit` (1 to 200, default 50) and `cursor`: pass the `nextCursor` of a page to get the next one; `nextCursor` is `null` on the last page. A cursor the gateway did not issue is `400 VALIDATION_ERROR`.

### Retrying

- `POST …/deliveries/:deliveryId/retry` puts one dead letter back in the queue and answers it as `pending`. **Only a `failed` delivery can be retried**: one that succeeded is never sent twice, and one that is still pending is already on its way. Both, and a delivery of another webhook, are `404 NOT_FOUND`; a `qr` or `code` is `400` (see above). The attempts already made stay counted.
- `POST …/deliveries/retry-failed` does it for the dead letters of the webhook, at most 500 per call. `retried` is how many went back and `more` tells there are others; call again to take them. A dead letter whose stored event cannot be read is skipped and logged. Two calls at the same time queue each delivery once.
- A retry sends the stored copy of the event, with the current URL and secret. Retries reach the receiver in no particular order, so a late retry can arrive after a newer event: **the receiver orders by `seq`** (per session).
- When the queue (Redis) cannot take the job, the call fails and the delivery goes to `failed` again, with `lastError` saying so, instead of staying `pending` with nothing to run it.

## What a delivery looks like

The envelope of [events](events.md) is the body of the POST, as JSON. The request carries:

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` |
| `User-Agent` | `wwebjs-gateway/<version>` |
| `X-Gateway-Event` | The event name, such as `message` or `ping`. |
| `X-Gateway-Delivery` | The id of the delivery. **The same on every attempt**, so it is the key to drop a repeat. |
| `X-Gateway-Seq` | The `seq` of the event in its session (`0` for a `ping`). |
| `X-Gateway-Timestamp` | Unix seconds when **this attempt** was made. |
| `X-Gateway-Signature` | `sha256=<hex>`: the HMAC-SHA256, with the secret of the webhook, of `${timestamp}.${rawBody}`. |

`rawBody` is the exact text of the request body, byte for byte. Verify before parsing, over the raw bytes, and compare in constant time:

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

function verify(secret, headers, rawBody, toleranceSeconds = 300) {
  const timestamp = Number(headers['x-gateway-timestamp'])
  if (!Number.isInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest()
  const given = Buffer.from((headers['x-gateway-signature'] ?? '').replace(/^sha256=/, ''), 'hex')
  return given.length === expected.length && timingSafeEqual(given, expected)
}
```

Reference vector: secret `whsec_vector`, timestamp `1767225600` and body `{"id":"evt_1","seq":7}` give `sha256=4e7cd92215110c8a5c9eaefa53663c809c974cb2a6ebebc753d9acc29a849b32`.

### What counts as delivered, and what is tried again

- A **`2xx`** answer is a success and the delivery is final (`success`); the body of the answer is never read.
- **Anything else is a failed attempt and is tried again**: another status (a `4xx` too, since a receiver that answers `404` while it is being deployed recovers by itself), a redirect (it is **not followed**: its status is the result), a timeout (`WEBHOOK_TIMEOUT_MS`, counted from the connection; resolving the name has its own limit of 5 s), a connection that fails, or an address the check refuses.
- Attempts back off exponentially from `WEBHOOK_BACKOFF_MS`, up to `WEBHOOK_MAX_ATTEMPTS`. The last failure makes the delivery `failed`, a dead letter that `retry` / `retry-failed` can send again. Each attempt updates `attempts`, `lastStatusCode` (`null` when nothing answered) and `lastError`, which says only what kind of failure it was (`The receiver answered 503`, `The receiver did not answer in 10000 ms`, `The connection failed (ECONNREFUSED)`, `The URL is not allowed: …`), never the URL.
- **The address check runs again on every attempt**, and the socket connects only to the addresses it approved: a name that resolves to a private address after the check (DNS rebinding) leads nowhere. The same goes for a `url` that was changed while the delivery waited.

### Before each attempt

Every attempt reads the webhook again, so what it finds is what applies:

- **Deleted webhook**: the job is dropped as done (the deliveries go with the webhook).
- **Disabled webhook**: an event is not sent. Its delivery goes to `failed` with `lastError: "The webhook is disabled"`, so `retry-failed` sends it after the webhook is enabled again. A `ping` is the exception, so a receiver can be checked before it is turned on.
- **Delivery already `success`**: not sent a second time.
- **Delivery without a row** (it could not be stored, see above): sent all the same, and nothing records its attempts.
- **Rotated secret / changed URL**: used as they are now (see *The secret*).

### A reference receiver

`tests/helpers/webhook-receiver.ts` is a receiver written from this page, not from the code of the gateway; the integration suite (`tests/integration/webhooks.integration.spec.ts`) proves that what the gateway sends is accepted by it. It does three things, and a receiver of your own should too:

1. **Verify before trusting**: the signature over the raw bytes, compared in constant time, and a timestamp within 5 minutes of the clock (a captured request cannot be replayed later). Answer `401` otherwise.
2. **Tolerate repeats**: remember the `X-Gateway-Delivery` of what it handled; a repeat is answered `200` again and not handled twice (answering an error would only make the gateway send it once more).
3. **Order by `seq`, per session**, holding an event until the ones before it have arrived, because retries reach the receiver in no particular order:

```js
// `held`: Map<seq, event> of the session; `next`: the seq it waits for
function accept(session, event) {
  if (event.seq === 0) return [event]            // a ping is not part of the sequence
  if (event.seq < session.next) return []        // already handed over
  session.held.set(event.seq, event)
  const ready = []
  while (session.held.has(session.next)) {
    ready.push(session.held.get(session.next))
    session.held.delete(session.next)
    session.next += 1
  }
  return ready
}
```

Waiting for the event before only works when the webhook receives **every** event (`events: ["*"]`). With a filter the `seq` of the events it did not ask for never arrive, and a receiver that waited for them would wait for ever: such a receiver drops repeats and orders by `seq` over a short window of its own instead. The first `seq` of a receiver that is created while the session is running is the first one it receives.

### Repeats

Delivery is **at least once**. If the gateway stops after your receiver answered and before it wrote the result, the delivery is sent again. Keep the `X-Gateway-Delivery` of what you already handled and ignore a repeat; order by `seq` as said above.

## Retention and stale deliveries

The gateway deletes on a schedule (`RetentionService`, a BullMQ job scheduler, so a restart does not skip or double a run):

| What | Deleted when | Schedule |
| --- | --- | --- |
| Webhook deliveries (the rows, not the receivers' copies) | older than `DELIVERY_RETENTION_DAYS` (14) | daily at 03:00, server time |
| Stored messages | older than `MESSAGE_RETENTION_DAYS` (30); an incoming message never published is kept | same run |
| Idempotency keys of sends | older than 24 hours | same run |

Each purge runs even when another fails, and a failed run is tried again (3 attempts, a minute apart, growing).

**Stale `pending` deliveries.** A delivery is `pending` while a job will still try it. A second job, every 10 minutes, looks at the `pending` rows older than 30 minutes and asks the queue about each one. Age alone never decides: a row whose job is waiting for its next retry is left alone however old it is.

| What the queue holds for the row | What the sweep does |
| --- | --- |
| a job that will still run (waiting, active, delayed) | nothing |
| no job at all | `failed`, `lastError: "The delivery has no job in the queue, so nothing will send it (it may never have been queued)"` |
| a job that finished without an error | `failed`, `lastError: "The delivery job finished but its outcome was not recorded; the receiver may already have the event"` |
| a job the queue gave up on | `failed`, `lastError: "The queue gave up on the delivery job and its outcome was not recorded; the receiver may already have the event"` |

The first row is a crash between storing the row and queueing the job: the receiver never got the event. The second is what a crash looks like too, but also what is left when the receiver answered `2xx` and the row could not be written (the database was down): the job is kept for an hour after it finishes, which is how the sweep tells them apart. Once that hour has passed the two can no longer be told apart.

Each row the sweep sends to the dead letters counts as `gw_webhook_deliveries_total{result="swept"}` and is logged as one warning per run, so an alert on that counter tells that deliveries are losing their jobs.

**The sweep never marks a delivery as delivered**, because it cannot be sure. It sends the row to the dead letters with the reason above, so `retry` and `retry-failed` can send it. **Sending one of those again by hand can repeat an event the receiver already has**; drop the repeat by `X-Gateway-Delivery`, which is the id of the delivery and does not change. If the job was only hidden from the sweep while it moved between states, nothing is lost: when it runs it records its result over the `failed` row.

> **Status.** Milestone 7 is complete: the routes, the queue, the dispatcher, the processor, the retention job, the media block and the integration suite are in place.
