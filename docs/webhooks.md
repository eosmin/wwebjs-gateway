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
- `url`: `http` or `https` on a public host. The address check runs when the webhook is created or changed, and again before every delivery, so a name that later resolves to a private address stops working. Targets on a private network (such as `http://bot:3000`) need `WEBHOOK_PRIVATE_HOST_ALLOWLIST`; `ALLOW_PRIVATE_WEBHOOK_TARGETS` turns the check off for development ([config](config-reference.md)).
- `events`: the event names delivered ([events](events.md)), or `["*"]` for every event. It defaults to `["*"]`; a `*` among other names replaces them.
- `enabled`: a disabled webhook receives nothing. It defaults to `true`.
- `mediaMode`: `none` (metadata only), `reference` (a download URL, the default) or `inline` (base64, up to `WEBHOOK_INLINE_MEDIA_MAX_BYTES`).
- `includeRaw`: whether message events carry the sanitized raw data. `null`, the default, follows `INCLUDE_RAW`.

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
  - `raw` stays on a message only when `includeRaw` is `true`, or `null` and `INCLUDE_RAW` is on. A webhook cannot ask for more than the event has: with `INCLUDE_RAW` off the gateway attaches no `raw` at all, and `includeRaw: true` adds nothing.
  - `mediaMode: none` removes `media`; `reference` keeps `media` without `base64`; `inline` keeps `base64` only when it decodes to at most `WEBHOOK_INLINE_MEDIA_MAX_BYTES`. The dispatcher only keeps or reduces: it never downloads media.
  - These apply to the messages of `message`, `message_create`, `message_ack`, `message_edit`, `message_revoke_everyone`, `message_revoke_me`, `message_ciphertext`, `message_ciphertext_failed`, `media_uploaded`, `message_sent`, `contact_changed`, the `lastMessage` of the chat in `unread_count`, `chat_removed` and `chat_archived`, and every message of a `message_batch`.
- **What is stored.** The job in Redis carries the event as the receiver gets it. The row in `webhook_deliveries` (what a manual retry sends again) carries a redacted copy: the text of a `qr` and the pairing `code` become `[Redacted]`, and inline `base64` is dropped. A retried `qr` or `code` therefore reaches the receiver redacted; both expire within a minute anyway.
- **Failures never lose an event silently, and never stop another webhook.**
  - If the row cannot be stored (the database is down), the job is queued all the same: a receiver must not miss an event because the log is down. That delivery has no row, so it is not in the list and nothing records its attempts. It is counted as `gw_webhook_deliveries_total{result="unlogged"}`.
  - If the job cannot be queued (Redis is down), the row goes to `failed` with `lastError: "The delivery could not be queued"`, so it shows among the dead letters and `retry` / `retry-failed` send it from the stored copy. It is counted as `result="not_queued"`. If neither the row nor the job could be made, the event is lost for that webhook and only the error log (event, session and `seq`, never the payload) says so.
- **A crash between the row and the job** (the process stops after the row is stored and before the job is queued) leaves a `pending` row with nothing to run it. Until the reconciliation of those rows lands (7.5) it stays pending; `retry` only takes `failed` deliveries.
- **Order.** Deliveries are stored and queued as the events arrive, but each retries on its own, so the receiver orders by `seq` (see above).

## Deliveries and dead letters

Every event sent to a webhook is a delivery: `{ id, webhookId, sessionId, event, seq, status, attempts, lastStatusCode, lastError, createdAt, deliveredAt }`. The event itself stays in the gateway and is not returned, because it can be a message.

| `status` | Meaning |
| --- | --- |
| `pending` | Waiting for an attempt or for the next retry. |
| `success` | The receiver answered with a `2xx`. Final. |
| `failed` | Every attempt failed. A dead letter. |

`GET /v1/webhooks/:id/deliveries` lists newest first. `?status=failed` lists the dead letters. It pages with `limit` (1 to 200, default 50) and `cursor`: pass the `nextCursor` of a page to get the next one; `nextCursor` is `null` on the last page. A cursor the gateway did not issue is `400 VALIDATION_ERROR`.

### Retrying

- `POST …/deliveries/:deliveryId/retry` puts one dead letter back in the queue and answers it as `pending`. **Only a `failed` delivery can be retried**: one that succeeded is never sent twice, and one that is still pending is already on its way. Both, and a delivery of another webhook, are `404 NOT_FOUND`. The attempts already made stay counted.
- `POST …/deliveries/retry-failed` does it for the dead letters of the webhook, at most 500 per call. `retried` is how many went back and `more` tells there are others; call again to take them. A dead letter whose stored event cannot be read is skipped and logged. Two calls at the same time queue each delivery once.
- A retry sends the stored copy of the event, with the current URL and secret. Retries reach the receiver in no particular order, so a late retry can arrive after a newer event: **the receiver orders by `seq`** (per session).
- When the queue (Redis) cannot take the job, the call fails and the delivery goes to `failed` again, with `lastError` saying so, instead of staying `pending` with nothing to run it.

## What a delivery looks like

The envelope of [events](events.md) is the body of the POST. Per TDD §6.9 the request carries `Content-Type: application/json`, `User-Agent: wwebjs-gateway/<version>`, `X-Gateway-Event`, `X-Gateway-Delivery`, `X-Gateway-Seq`, `X-Gateway-Timestamp` (unix seconds) and `X-Gateway-Signature: sha256=<hex>`, the HMAC-SHA256 of `${timestamp}.${rawBody}` with the secret. A `2xx` is success; anything else is retried with exponential backoff (`WEBHOOK_BACKOFF_MS`) up to `WEBHOOK_MAX_ATTEMPTS`, and then the delivery is `failed`. Redirects are not followed.

> **Status.** The routes, the queue and the dispatcher (above) are in place. The processor that sends the jobs (7.4) comes next, so until it lands the jobs wait in the queue (`webhook-deliveries`), which keeps them across restarts, and nothing sends them yet.
