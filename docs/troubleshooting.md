# Troubleshooting

Symptom, cause, fix. Every error of the API has a stable `code` and carries the `requestId` of the
request (it is also the `x-request-id` header), so quote it when you look in the logs
([errors](errors.md)). For a problem that is about a session, read its row first:

```bash
curl http://localhost:3000/v1/sessions/main -H "X-API-Key: $API_KEY"
```

`status` and `lastError` say most of what you need ([sessions](sessions.md)).

## The gateway and its dependencies

| Symptom | Cause | Fix |
| --- | --- | --- |
| The process exits at start with the reason on stderr | The environment is invalid (a missing or too short `ADMIN_API_KEY`, a placeholder in production, `ENABLE_DOCS=true` or `CORS_ORIGINS=*` in production), or Postgres or Redis cannot be reached | Read the message: it names the variable or the dependency. Every variable is in [config-reference](config-reference.md) |
| `GET /ready` answers `503` | Postgres, Redis or the folder of the saved logins (`WWEBJS_DATA_PATH`) failed its check, or the gateway is shutting down | The body lists the checks and which one is `down` ([system](system.md)). `/health` stays `200` on purpose: it only says the process is alive |
| `GET /metrics` answers `401` | The bearer is not `METRICS_TOKEN` and the key is not an admin key | Send `Authorization: Bearer $METRICS_TOKEN` ([system](system.md)) |
| `401 UNAUTHORIZED` | The key is missing, unknown or revoked | Send it as `X-API-Key` or `Authorization: Bearer`. A rotated key keeps working only for `API_KEY_ROTATION_GRACE_MINUTES` ([authentication](authentication.md)) |
| `401 API_KEY_EXPIRED` | The `expiresAt` of the key passed | Create or rotate a key |
| `403 IP_NOT_ALLOWED` | The client address is outside `allowedCidrs` of the key. Behind a proxy the gateway sees the proxy's address unless `TRUST_PROXY_HOPS` says how many proxies are in front | Fix the list or the setting ([authentication](authentication.md)) |
| `403 INSUFFICIENT_SCOPE` or `FORBIDDEN` | The key lacks the scope of the operation, or it is a session key asking for another session | Check the scope in [operations-list](operations-list.md) and the session of the key |
| `403 OPERATION_DISABLED` | The operation is off by configuration. The group writes need `ENABLE_GROUP_WRITES=true` | Read the message: it names the setting. Read [groups](groups.md) before you turn it on |
| `429 RATE_LIMITED` | More than `RATE_LIMIT_MAX` requests a minute for the key or for the address | Wait the seconds of the `Retry-After` header |
| `413 PAYLOAD_TOO_LARGE` | A body over 1 MiB, or over 40 MiB on the send, reply and channel send routes | Send media as a `url` instead of base64 ([messages](messages.md), [limits](limits.md)) |
| `400 VALIDATION_ERROR` | The request does not match the schema | `error.details` holds the issues; the schema of each route is in `docs/openapi.json` |

## Sessions

| Symptom | Cause | Fix |
| --- | --- | --- |
| A session never leaves `starting`, or goes to `failed` with `the browser did not start N times in a row` | The browser did not start: `PUPPETEER_EXECUTABLE_PATH` is not set or points to nothing, the data folder cannot be used, or a saved login is bad | Set the path of a Chromium in the environment and restart. The `lastError` and the logs name the kind of failure. After fixing it, `POST …/start` ([sessions](sessions.md)) |
| `status` stays `qr` | Nobody scanned the code. The code is replaced every few seconds | `GET …/qr.png` and scan it from the phone: **Settings → Linked devices → Link a device**. After `QR_MAX_RETRIES` (6) renewals the session gives up pairing: read `status` and `lastError`, then `POST …/start` for a new code. Pairing by code is the alternative ([sessions](sessions.md)) |
| `GET …/qr` answers `404` | The session shows no QR code (it is not in `qr`, or it is already linked) | Check `status` first |
| A session that worked asks for a QR again, or loops through `initialize failed` | The phone unlinked the device. The gateway deletes the dead login on a `LOGOUT`; when it only finds out at the next start it moves it to `.quarantine` | Scan the QR code again. If the account was not unlinked, restore the login by hand following "A browser that does not start" in [sessions](sessions.md) |
| `status: failed`, `lastError: WhatsApp Web state DEPRECATED_VERSION` (or `UNPAIRED`, `TOS_BLOCK`, `PROXYBLOCK`) | The watchdog read a blocking state twice in a row. The gateway does not retry while it runs | `DEPRECATED_VERSION` is solved by a new build of the library or of WhatsApp Web, on a restart. The other states are what WhatsApp Web reports about the account or the connection; the gateway only shows them (see [safety](safety.md) for how to lower the risk to an account) |
| `status: disconnected` for a while | The connection dropped; the manager retries with a growing wait, 5 s to 5 min | Wait. `SESSION_RECONNECT_MAX_ATTEMPTS` (0, unlimited) limits it; past the limit it ends `failed` and needs a `start` |
| `409 SESSION_NOT_READY` | The session is not `ready` | Wait for `ready`; a queued send waits for it up to `SEND_MAX_WAIT_MS` |
| `409 MAX_SESSIONS_REACHED` | The running sessions reached `MAX_SESSIONS` | Stop one or raise the limit, with the memory of the host in mind ([limits](limits.md)) |
| A session is logged out right after an action on a group | WhatsApp ended the session; the cause is not proven | This is why the group writes are off by default. See "WhatsApp Web builds, reloads and the reason of a logout" in [sessions](sessions.md) |
| `502 WHATSAPP_ERROR` whose cause starts with `[signature]` | WhatsApp Web changed under the patch of the library: a function the call needs is not there | Not a problem of your request. The text names the module, the function and the build. See "WhatsApp Web builds" in [sessions](sessions.md) |
| `504 WHATSAPP_TIMEOUT` | WhatsApp Web did not answer within `WA_CALL_TIMEOUT_MS`, or a call took longer than the 185 s the gateway awaits | Retry later; if it repeats for every call, look at the state of the session |

## Sending

| Symptom | Cause | Fix |
| --- | --- | --- |
| `422 POLICY_BLOCKED`, `details.rule: cold_sends_disabled` | The recipient has not written to the account in the last `CONVERSATION_WINDOW_HOURS` (24) and cold sends are off by default | Reply only in open conversations, or turn `ALLOW_COLD_SENDS` on knowingly ([safety](safety.md)) |
| `422 RECIPIENT_SUPPRESSED` | The chat is on the suppression list, by hand or because it sent an opt-out keyword | Remove it from the list only if the person asked to be contacted again ([safety](safety.md)) |
| `422 DUPLICATE_CONTENT` | The same text went to too many different chats in a short time (cold sends) | Do not send identical text to many people |
| `422 RECIPIENT_UNREACHABLE` | The last messages to that chat were never delivered and the contact is silent. Only cold sends are rejected | It clears by itself when the contact writes or a message is delivered |
| `422 NUMBER_NOT_ON_WHATSAPP` | WhatsApp said the number has no account. The answer is remembered for five minutes | Check the number. WhatsApp can answer "no" wrongly while it is busy: ask again later ([lookup](lookup.md)) |
| `202 { status: "queued" }` and no result yet | The send is waiting: for the pacing of the policy, for the session, or behind other sends | Not an error. The result arrives as `message_sent` or `message_failed` and at `GET …/send-jobs/:jobId` ([send-queue](send-queue.md)) |
| `POLICY_DELAY_EXCEEDED` in `message_failed` | The policy held the message longer than `SEND_POLICY_MAX_WAIT_MS` (30 minutes) | Lower your volume; the budgets and the warm-up of a young account are in [safety](safety.md) |
| `429 SEND_QUEUE_FULL` | `SEND_QUEUE_MAX_PER_SESSION` or `SEND_QUEUE_MAX_TOTAL` sends are waiting | Wait the `Retry-After` seconds. Nothing was queued, and repeating with the same `Idempotency-Key` is safe |
| `503 QUEUE_UNAVAILABLE` | Redis cannot be reached | If `details.queued` is `false` nothing was queued. If it is `unknown`, repeat with the same `Idempotency-Key` |
| `502 UNKNOWN_OUTCOME` | The send timed out after it was dispatched: it may or may not have reached WhatsApp | It is never retried by the gateway. Look at the chat; if the message is not there, send again with **a new** `Idempotency-Key` |
| `422 IDEMPOTENCY_KEY_REUSED` | The key was used with a different request | Use a new key for a new request |
| `422 MEDIA_FETCH_FAILED` | The media URL failed, redirected, was too slow, or the file is over `MAX_MEDIA_BYTES`. A URL whose host resolves to a private address is refused | Serve the file from a public host, within the limit; redirects are not followed |
| A send repeats the old failure | A key that failed is final for 24 hours, even when nothing was sent | Use a new `Idempotency-Key` ([send-queue](send-queue.md)) |

## Webhooks

| Symptom | Cause | Fix |
| --- | --- | --- |
| The webhook is refused with `The URL is not allowed: the host does not resolve to a public address` | The host does not resolve, or resolves to a private or reserved address | Use a public host. A private network (`http://bot:3000`) needs `WEBHOOK_PRIVATE_HOST_ALLOWLIST`; `ALLOW_PRIVATE_WEBHOOK_TARGETS` is for development only ([webhooks](webhooks.md)) |
| Nothing arrives | The webhook is disabled, its `events` do not include the event (`*` never carries `qr` or `code`), or it belongs to another session | `GET /v1/webhooks/:id`, then `POST /v1/webhooks/:id/test`, which sends a `ping` |
| Deliveries are `failed` | Every attempt failed: the receiver did not answer `2xx` within `WEBHOOK_TIMEOUT_MS`, or was unreachable. `lastStatusCode` and `lastError` say which | Fix the receiver, then `POST …/deliveries/:deliveryId/retry` or `POST …/deliveries/retry-failed` ([webhooks](webhooks.md)) |
| The signature never matches | It is computed over `${X-Gateway-Timestamp}.${rawBody}`: the exact bytes of the body, not the parsed JSON, and the secret the webhook has now | Verify before parsing and compare in constant time; after `rotate-secret` use the new secret ([webhooks](webhooks.md)) |
| The same event arrives twice | Delivery is at least once. `X-Gateway-Delivery` is the same on every attempt | Drop repeats by that id, or by `seq` |
| Events arrive out of order | Deliveries are queued as the events arrive but each one retries on its own, so a late retry can come after a newer event | Order by `seq` within a session ([webhooks](webhooks.md)) |

## Sockets

| Symptom | Cause | Fix |
| --- | --- | --- |
| `connect_error` with a `data.code` | The handshake failed: `UNAUTHORIZED`, `INSUFFICIENT_SCOPE` (the key needs `events`) or the limit of failed handshakes | The key goes in `auth: { apiKey }`, never in the query string ([websocket](websocket.md)) |
| `subscribe` is refused | `INSUFFICIENT_SCOPE`: the `qr` and `code` events need `manage` | Do not name them, or use a key with `manage` |
| A socket is disconnected while it works | A slow consumer: `SOCKET_MAX_QUEUED_EVENTS` packets were waiting for it | Read faster, or follow fewer events. After reconnecting, ask for the replay from the last `seq` you handled |
| A replay answers `truncated: true` | There are more events than the limit, or the window (`EVENT_REPLAY_WINDOW_SECONDS`, 300) no longer holds the start | Ask again from the `to` of the answer; what the window dropped is gone ([websocket](websocket.md)) |

## Ordering and missing messages

| Symptom | Cause | Fix |
| --- | --- | --- |
| Two messages of the same second arrive in a surprising order | WhatsApp timestamps have one-second resolution | Nothing can be done; see [ordering](ordering.md) |
| A message arrives up to a few seconds late | The order buffer holds a burst to sort it: at most `INBOUND_ORDER_WINDOW_MS`, and never longer than `INBOUND_ORDER_MAX_HOLD_MS` | Expected. `INBOUND_ORDERING_ENABLED=false`, or `ordering.enabled: false` in the session settings, turns the holding off |
| `message_batch` still arrives with `MESSAGE_BATCH_ENABLED=false` | The variable is declared and read by nothing | Ignore the event. This is known and written in [ordering](ordering.md) |
| `seq` jumps by up to 100 | A crash leaves a reserved block of numbers | Not a lost event ([sessions](sessions.md)) |
| Messages that arrived during a downtime are missing | The reconciler recovers the incoming messages of the most recent chats only, within its limits | See "Catch-up reconciliation" in [ordering](ordering.md) for `RECONCILE_MAX_CHATS`, `RECONCILE_FETCH_LIMIT` and `RECONCILE_LOOKBACK_HOURS` |
| `origin` is missing on a message from an ad | The message carries no `ctwaContext`, or WhatsApp Web moved it | See [origin](origin.md) |
