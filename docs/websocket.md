# Socket.IO

The realtime side of the gateway: the same events as the webhooks, pushed over one connection, and the same operations as REST, runnable as commands on that connection (a typing indicator, a mark-as-seen, a send). The code is `src/realtime/`; the events are in [`events.md`](events.md), the keys and scopes in [`authentication.md`](authentication.md), the settings in [`config-reference.md`](config-reference.md), the metrics in [`metrics.md`](metrics.md).

It is **Socket.IO 4**, on the same port as the REST API, path `/socket.io`. Single instance by design: there is no Redis adapter and no rooms, and the gateway must never run with more than one replica.

## Connecting

```ts
import { io } from 'socket.io-client'

const socket = io('https://gateway.example.com', {
  auth: { apiKey: process.env.GATEWAY_API_KEY },
  transports: ['websocket']
})

socket.on('connect_error', error => console.error(error.data?.code)) // UNAUTHORIZED, INSUFFICIENT_SCOPE, ...
socket.on('wa:event', envelope => handle(envelope)) // every event arrives here
```

- **The key goes in `auth.apiKey`, never in the URL** (a query string is written to logs). A key in the query string is ignored, so the handshake fails as if there were none.
- The key is checked like the key of a REST call: unknown, revoked or expired is `UNAUTHORIZED` (`API_KEY_EXPIRED` for an expired one), an address outside its allowlist is `IP_NOT_ALLOWED`. The failure reaches the client as `connect_error`, with `error.data = { code, message }`.
- **The key needs the `events` scope.** Without it the handshake is refused with `INSUFFICIENT_SCOPE`: a socket that can neither follow nor command anything has no use.
- **Failed handshakes are limited per address** (`RATE_LIMIT_MAX` a minute, as for REST). Past it the handshake is refused with `RATE_LIMITED` before the key is looked up. Handshakes that succeed are not counted.
- **The key is checked again every 30 seconds** while the socket lives. The lookup is one per key and address, not per socket. A key that was revoked, rotated out, expired or lost its address allowlist has its sockets disconnected (`gw_socket_disconnects_total{reason="unauthorized"}`); the client sees `io server disconnect` and a reconnect fails at the handshake. A database that is down does not disconnect anyone.
- `CORS_ORIGINS` applies to the browser handshake exactly as to REST. A client packet is at most 1 MiB, like a REST body.

## What a socket may reach

A session key reaches **its own session only**. An admin key (a key with no session) reaches every session. This is checked three times: when a socket subscribes (`FORBIDDEN`), when it replays, and again for every single event before it is sent, so a socket never receives the event of a session its key cannot reach.

| Message | Needs |
| --- | --- |
| `subscribe`, `unsubscribe`, `replay` | the `events` scope and a session the key reaches (`*` only for an admin key) |
| `command` | the `events` scope **and** the scope of the operation it runs, exactly as the REST route |

The `qr` and `code` events carry a credential that links a device to the account, so they follow the rule of the webhooks: **a key needs the `manage` scope AND must name the event**. A key without `manage` that names `qr` or `code` in `subscribe` is refused with `INSUFFICIENT_SCOPE`. `*`, or no `events` list, never carries them, even for a key with `manage`; neither does `replay` (they are not kept). The `qr` of the snapshot (below) follows the same rule: `manage` and named.

## Client to server

Every message is acknowledged: give `emit` a callback, or use `emitWithAck`. The ack is always one of `{ ok: true, ... }` or `{ ok: false, error: { code, message, details? } }`, with the same codes as REST (see [`errors.md`](errors.md)). An invalid message (an unknown field, a wrong type) is `VALIDATION_ERROR`.

### `subscribe { sessionId, events? }`

Starts sending the events of a session (`sessionId` is `*` for an admin key: every session). `events` is a list of event names, or `*`; omitted means every event except `qr` and `code`. Subscribing again to the same session replaces the list. A socket may follow at most 64 sessions.

```json
{ "ok": true, "snapshot": { "status": "ready", "seq": 1042 } }
```

`snapshot` is the state at the moment of subscribing: `status` is the session status, `seq` is the last `seq` the session handed out, and `qr` is present only for a key with `manage` that named `qr` in `events`, while the session waits for a scan (the same rule as the event). For `*` the snapshot is `null`. The subscription is registered **before** the snapshot is read, so an event that lands in between is delivered; compare its `seq` with the one of the snapshot and drop what the snapshot already covers.

### `unsubscribe { sessionId }`

Stops sending that session. Answers `{ "ok": true }`, also when the socket did not follow it.

### `command { op, sessionId?, params?, idempotencyKey? }`

Runs an operation. `op` is the **socket command name** of an operation (`chat.state` for `chats.setState`); the list of commands is generated into `websocket-commands.md` with the documentation step of the plan. The command runs **the same controller method as the REST route**, through the same operation registry: the same scope check, the same session check, the same validation, the same response schema and the same timeout. Nothing is written twice.

`params` is the flat union of what REST takes in the path, the query and the body: the names of the route (`chatId` of `/chats/:chatId/state`) are the path, and everything else is the body of a write or the query of a read. `sessionId` is the session of the path; a `params.sessionId` that says another one is refused. `idempotencyKey` is the `Idempotency-Key` header of REST (1 to 128 characters). A key that is not `admin` cannot run an `admin` operation, and `inboundHooks.send` is REST only (its credential is the token in the URL).

```ts
const ack = await socket.emitWithAck('command', {
  op: 'chat.state',
  sessionId: 'sales',
  params: { chatId: '5215512345678@c.us', state: 'typing', durationMs: 5000 }
})
// { ok: true, data: null }   data is the body REST would answer, null for a 204
```

An error is the error REST would answer: `{ ok: false, error: { code: 'SESSION_NOT_READY', message, details? } }`. A socket may have **32 commands running** at once, and a key may send `RATE_LIMIT_MAX` commands a minute across all its sockets (the allowance of a REST key); past either the answer is `RATE_LIMITED`. A command that contains a NUL (U+0000) is `VALIDATION_ERROR`, as on the HTTP routes. A send over the socket is as safe as over REST: give it an `idempotencyKey` and, after an answer you did not receive, repeat it with the same key; never blindly resend without one.

### `replay { sessionId, afterSeq, limit? }`

Re-emits the events kept after `afterSeq`, in order, as `wa:event`, so a client that reconnected closes the gap:

```json
{ "ok": true, "from": 1043, "to": 1050, "truncated": false }
```

`limit` is 1 to 1000 (default 500). `from` and `to` are the first and last `seq` read (`null` when nothing is kept after `afterSeq`); to read on, call again with `afterSeq = to`. The events are filtered by the subscription of that session when there is one.

**`truncated: true` means the answer may not hold everything after `afterSeq`**: there are more events than `limit`, or the replay stopped early because the socket's own queue was nearly full (it never disconnects you for a replay you asked for: ask again from `to`), or an event is missing from the start or the inside of what was read (older than `EVENT_REPLAY_WINDOW_SECONDS`, pushed out by `EVENT_REPLAY_MAX_EVENTS`, never written because Redis failed, or a `qr`/`code` event, which is never kept), or nothing is kept although the session went on. What came after the last event read is not checked: it reaches the client live. Keep asking while it is `true`; when the gap is real (the window is gone) it stays `true`, so after one answer that starts later than `afterSeq + 1` fill the gap from REST (the stored messages and the chat routes) and carry on from the live stream.

## Server to client

One event, `wa:event`, carrying the envelope of [`events.md`](events.md):

```json
{ "id": "evt_…", "event": "message", "sessionId": "sales", "seq": 1042, "timestamp": "…", "data": {} }
```

- **At least once.** The same event can arrive twice (a live event and the replay of it, a reconnect). Deduplicate by `id` or by `seq` per session. `seq` is strictly increasing per session and assigned after the ordering of inbound messages, so `seq` order is conversation order.
- **Nothing is sent that nobody asked for.** A socket gets events only from a `subscribe`, and only the ones its key may have.
- **The replay buffer** is one Redis stream per session (`events:<sessionId>`), kept for `EVENT_REPLAY_WINDOW_SECONDS` (default 300; `0` turns the replay off) and at most `EVENT_REPLAY_MAX_EVENTS` events (default 5000). Events older than the window are not served even before the sweep removes them. It is best effort: an event that could not be written (Redis down, or an event over 256 KiB) is still delivered live, counted in `gw_replay_write_failures_total`, and simply missing from a replay; `truncated` tells the client. If a session is deleted and created again with the same id its counter starts over, and the old stream is dropped.

## Slow consumers

The gateway never holds the backlog of a client that does not read. Before every event it looks at how many packets are queued for the socket; at `SOCKET_MAX_QUEUED_EVENTS` (default 1000) it **disconnects** that socket (`gw_socket_disconnects_total{reason="slow_consumer"}` and a warning in the log, which names the key id and never the key). The client sees `io server disconnect`, and should reconnect, subscribe and `replay` from the last `seq` it processed. Other clients are not affected. The bound is a count of packets, so size the limit with the largest events (a message with a `raw` copy) in mind.

## Metrics

| Metric | Meaning |
| --- | --- |
| `gw_socket_connections` | clients connected and authenticated |
| `gw_socket_disconnects_total{reason}` | disconnects done by the gateway: `slow_consumer`, `unauthorized` |
| `gw_replay_write_failures_total` | events that could not be kept for replay |

## Reconnecting, step by step

1. Connect with `auth.apiKey`; on `connect_error` read `error.data.code` and do not retry a `UNAUTHORIZED` or `INSUFFICIENT_SCOPE` in a loop.
2. `subscribe` to the session. Keep the `snapshot.seq`.
3. Process `wa:event`, remembering the highest `seq` handled per session.
4. After a disconnect: reconnect, `subscribe`, then `replay { afterSeq: lastSeq }` and repeat until `truncated` is `false` (or fall back to REST when the window is gone).
