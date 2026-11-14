# Architecture

How the gateway is built and how data moves through it. It is one NestJS application on the Fastify
adapter, in strict TypeScript, that keeps several WhatsApp sessions in one Node process. State lives
in PostgreSQL (through Prisma and the `pg` driver adapter) and Redis (through `ioredis` and BullMQ).
The design decisions have their own records in [`docs/adr/`](adr/README.md); this guide is the map.

## The shape of it

```text
                 REST (/v1/...)            Socket.IO (/socket.io)         Webhooks (out)
                       |                           |                            ^
                       v                           v                            |
            +----------------------------------------------+      +----------------------------+
            |  ApiKeyGuard, rate limit, Zod validation     |      |  WebhookDispatcher         |
            |  controllers  <-- one @WaOperation each -->  |      |  -> delivery queue (BullMQ)|
            |  socket gateway + operation dispatcher       |      |  -> delivery processor     |
            +----------------------+-----------------------+      +-------------^--------------+
                                   |                                            |
                  services (send, chats, groups, ...)                    EventBus (in process)
                                   |                                            ^
                +------------------+-------------------+                        |
                |                                      |            event pipeline per session
         send queue (BullMQ)                           |      dedupe -> store -> order buffer
         + send policy                                 |            -> seq -> publish
                |                                      |                        ^
                v                                      v                        |
        +-------------------------------------------------------------------------------+
        |   WhatsAppClientPort  <-  WwebjsAdapter  (the only importer of whatsapp-web.js) |
        |   SessionManager: one client, one Chromium and one saved login per session      |
        +-------------------------------------------------------------------------------+
                                   |
                                   v
                         WhatsApp Web (Chromium)

        PostgreSQL: sessions, api keys, webhooks and deliveries, stored messages, idempotency, suppressions
        Redis: queues, dedupe keys, seq counters, event replay streams, caches, rate limits
```

## Module map

The code is under `src/`.

| Folder           | What it holds                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `api/`           | The HTTP side: the `@WaOperation` decorator and the operation registry, OpenAPI, the rate limit, Bull Board |
| `api/controllers/` | One controller per area (messages, chats, groups, sessions, webhooks, ...). Thin: they validate and call a service |
| `services/`      | The business logic: sending and its queue, the send policy, idempotency, webhooks and their delivery, retention, API keys |
| `whatsapp/`      | Everything that touches WhatsApp: the adapter, the session manager, the event pipeline, the order buffer, the reconciler, the watchdog |
| `realtime/`      | The Socket.IO gateway, the command dispatcher, the replay of events                                        |
| `types/`         | The Zod schemas of every DTO, request and event, with `.describe()` on each field                          |
| `database/`      | The Prisma service and the repositories                                                                    |
| `infra/`         | Logging (pino, with redaction), metrics, Redis, the HTTP setup, the process guards and the hard exit       |
| `config/`        | `env.schema.ts`: every environment variable, validated at boot                                             |
| `common/`        | Errors and their codes, guards, interceptors, the principal of a request                                   |
| `parity/`        | What maps every `whatsapp-web.js` symbol to an operation, a field or a reason it is not exposed            |

`scripts/` holds the generators and validators that CI runs, and `docs/` the documentation that
they check.

## Two rules that shape everything

**One boundary with the library.** Only `src/whatsapp/wwebjs-adapter.ts` imports `whatsapp-web.js`.
The rest of the code depends on the `WhatsAppClientPort` interface and on the gateway's own DTOs, so
a wwebjs object never leaves the adapter and is never serialized as it is. Every call goes through the
adapter's timeout and error translation: a Puppeteer failure becomes an error of the gateway
(`WHATSAPP_ERROR`, `WHATSAPP_TIMEOUT`, see [errors](errors.md)) and an unhandled rejection of the
browser is attributed to the session that caused it instead of ending the process.

**One definition per capability.** Every capability is a controller method decorated with
`@WaOperation`, which carries its scope, summary, examples, errors and the wwebjs symbols it covers.
The operation registry (`OperationRegistryService`) reads those decorators, and from them come the REST
route, the guard that enforces the scope, the OpenAPI document, the socket command and the generated
docs ([operations-list](operations-list.md), [websocket-commands](websocket-commands.md),
[parity-matrix](parity-matrix.md)). Nothing is written twice, so the surfaces cannot disagree.

## Data flow: an inbound message

1. WhatsApp Web delivers the message to the Chromium of the session; the adapter turns the wwebjs object
   into a `MessageDto` (`origin` and `raw` included, see [origin](origin.md)).
2. The session's event pipeline **dedupes** the event (a Redis key with a ten minute lifetime, plus a
   durable record on the stored message), **stores** it in Postgres, and offers it to the per-chat
   **order buffer**, which holds a burst for a moment and releases it sorted by the sender's timestamp
   ([ordering](ordering.md)).
3. Only after the ordering does each event get its per-session **`seq`**, a Redis counter that never goes
   back ([sessions](sessions.md)), and it is **published** on the in-process `EventBus` and appended to the
   replay stream of the session in Redis.
4. The Socket.IO gateway and the webhook dispatcher subscribe to the bus. The gateway pushes the event to
   the sockets that follow the session ([websocket](websocket.md)); the replay service also appends it to
   a Redis stream of the session so a client that reconnects can ask for what it missed. The dispatcher stores one delivery
   per matching webhook and queues a job; the delivery processor posts it, signed, with retries and a
   dead-letter state ([webhooks](webhooks.md)).

Delivery is at least once, so a consumer deduplicates by `seq`.

## Data flow: an outbound send

1. `POST /v1/sessions/:sessionId/messages` passes the key guard and the schema validation.
2. The idempotency layer claims the `Idempotency-Key` in Postgres. The recipient is resolved and the send
   policy runs its cheap checks (suppression list, cold sends, limits), so an impossible send fails at
   once ([safety](safety.md)); only then is the media downloaded, behind the SSRF guard.
3. The send is added to a BullMQ queue in Redis, which is what makes it survive a restart. A worker takes
   it, asks the policy again for pacing, and calls the adapter.
4. The caller either gets the result (`201`) or a job id (`202`) and the result as the `message_sent` or
   `message_failed` event ([send-queue](send-queue.md)). After an unknown outcome the send is never
   retried blindly.

## Sessions

`SessionManager` owns one WhatsApp client per session, each with its own Chromium and its own saved
login under `WWEBJS_DATA_PATH`. It follows the status machine of [sessions](sessions.md): QR or
pairing code, `ready`, reconnection with backoff, restore at boot (staggered, so the browsers do not
start together), and a clean shutdown that destroys the clients **without logging out**. The watchdog
checks every running session and reconnects one that is stuck in `starting` or whose state check keeps
failing, or marks it `failed` when WhatsApp Web reports a blocking state.
The reconciler fetches the messages missed during a downtime when a session becomes `ready`.

## Authentication and tenancy

Every route needs an API key ([authentication](authentication.md)). The key is a scope set plus,
optionally, one session: a session key reaches only that session, and the guard checks it for every
route that has a `sessionId` in the path. Keys are stored as a sha256 hash and shown once.

## Boot and shutdown

At boot the environment is validated first, and an invalid one, or an unreachable Postgres or Redis,
stops the process with the reason on stderr and a non-zero exit code. Once the server listens the
sessions are restored in the background, without holding `/ready` ([sessions](sessions.md)). If Postgres or Redis
go away later, `/ready` answers `503` while `/health` stays `200`, and the workers resume by
themselves when they return ([system](system.md)).

On `SIGTERM` or `SIGINT` the gateway closes the send queue first (a call in flight finishes within a
bounded time, a send that only waits goes back to the queue), then destroys the clients **without
logging out** and closes Postgres and Redis; a hard exit timer ends a shutdown that hangs
([send-queue](send-queue.md), [sessions](sessions.md)).

## Single instance, on purpose

The gateway runs as **one replica**. A session's Chromium and its saved login belong to a single Node
process, the order buffers and some counters live in its memory, and Socket.IO has no Redis adapter.
Never scale it horizontally ([limits](limits.md)).

## Observability

Structured JSON logs (pino) with redaction of keys, tokens and QR strings, Prometheus metrics at
`/metrics` ([metrics](metrics.md)), the system report at `GET /v1/system/info`, and, when
`BULL_BOARD_ENABLED=true`, the queues at `/admin/queues` ([operations](operations.md)).
