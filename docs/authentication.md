# Authentication

Every route needs an API key unless it is marked public (`/health`, `/ready`, and `/metrics`, which
checks its own credentials; see [system.md](system.md)). Send the key as `X-API-Key: <key>` or `Authorization: Bearer <key>`; `X-API-Key`
wins when both are present. Any other `Authorization` scheme is not a key.

## Kinds of key

| Key | Where it lives | Reaches |
| --- | --- | --- |
| Bootstrap admin | `ADMIN_API_KEY` (32+ characters), compared in constant time, no row, no address list | everything |
| Admin | a database key with no session | everything |
| Session | a database key with a `sessionId` | `/v1/sessions/{thatId}/…` and its own webhooks, only for its scopes |

A database key with no session is an admin key whatever its stored scopes say: scopes only limit
session keys. Creating a key without a session therefore needs an admin key, and the create
endpoint (step 4.5) rejects a session-less key that carries `scopes` with `400 VALIDATION_ERROR`
instead of silently promoting it.

Database keys look like `wgk_<43 url-safe characters>`. Only the sha256 of the key is stored; the
raw key is shown once when it is created.

## Permission scopes

| Scope | Allows |
| --- | --- |
| `read` | every GET operation |
| `send` | sending messages, reactions, typing and state, mark seen, inbound-hook sends |
| `manage` | session lifecycle, chat, group, channel, profile and settings changes, send policy, suppressions |
| `webhooks` | webhook and inbound-hook CRUD |
| `events` | Socket.IO `subscribe`, `replay` and `command` (a command also needs the scope of the operation it runs) |
| `admin` | operations not tied to one session; **no key can hold it**, only admin keys pass |

A new key gets `read`, `send`, `events`. Admin keys have every scope. A scope stored outside the
list above is ignored, so a row edited by hand cannot grant `admin`. A route that declares no scope
is treated as `admin`, so a forgotten declaration closes the route instead of opening it.

## Errors

| Status | Code | When |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` | the key is missing, unknown or revoked |
| 401 | `API_KEY_EXPIRED` | the key's `expiresAt` has passed |
| 403 | `IP_NOT_ALLOWED` | the client address is outside the key's `allowedCidrs` |
| 403 | `INSUFFICIENT_SCOPE` | the key lacks the scope of the operation |
| 403 | `FORBIDDEN` | a session key asks for another session |
| 429 | `RATE_LIMITED` | the key or the client address went over `RATE_LIMIT_MAX` requests in a minute |

The checks run in that order: key, revocation, expiry, address, scope, session.

## Address allowlist

`allowedCidrs` is a list of addresses or CIDRs (`203.0.113.7`, `10.0.0.0/8`, `2001:db8::/32`);
empty means any address. An entry that does not parse matches nothing, so a corrupt list only
denies. The environment key has no list.

The client address is the socket peer. Behind reverse proxies set `TRUST_PROXY_HOPS` to the number of
proxies in front of the gateway: the gateway then counts that many entries back from the end of
`X-Forwarded-For`, which are the ones the proxies wrote, and ignores what the caller put before
them. With `0` the header is ignored. When the header has fewer entries than `TRUST_PROXY_HOPS`
the request skipped a proxy, so the header is ignored and the socket peer is used. The gateway port
must be reachable only through the proxy; a client that reaches it directly appears with the
proxy-less address of its own connection.

The environment key (`ADMIN_API_KEY`) has no address list, so keep the admin endpoints behind a
network restriction of their own.

## Rate limit

Every HTTP route is limited, the public ones (`/health`, `/ready`, `/metrics`) and the failed
authentications included, because an unknown key costs a database lookup and `/ready` pings Postgres
and Redis. Two buckets of `RATE_LIMIT_MAX` requests per minute apply to a request, both shared by all
the routes:

- **Per client address** (`TRUST_PROXY_HOPS` decides which address that is). It is checked first and
  is what bounds a caller who invents a new key for every request.
- **Per API key**, for a request that carries one (`X-API-Key` or `Authorization: Bearer`), whatever
  the address, keyed by the hash of the key.

The limit runs before the guard of the API key, so a refused request never reaches the key lookup. The
answer is 429 `RATE_LIMITED` in the error contract, with a `Retry-After` header in seconds. The counters
live in the memory of the process (the gateway runs as a single instance), so a restart resets them.

## Revocation and the cache

A database key is read once and kept for at most 30 seconds, so a revoke or a rotation takes effect
on a running gateway within that time, and at once when the operation calls `AuthService.invalidate`.
An unknown key is never cached, so each request with a wrong key costs one indexed lookup (keys have
256 bits, so guessing is not feasible; the cost is load only). A row read while a revoke is running
is not cached either. Throttling of failed authentication belongs to the rate limiter and is
not part of this step. `lastUsedAt` is written at most once a minute per key and never
delays or fails a request.

## One enforcement point per question

- Scope: `assertScope(principal, scope)`, called by `ApiKeyGuard`.
- Session: `assertSessionAccess(principal, sessionId)`, the only place that decides whether a key may
  reach a session (REST, sockets and inbound hooks).

Keys, secrets and QR strings are never logged.

## Managing keys

Only admin keys reach these operations (their scope is `admin`).

| Operation | What it does |
| --- | --- |
| `POST /v1/api-keys` | Creates a key. Body: `name`, optional `sessionId`, `scopes`, `allowedCidrs`, `expiresAt`. The raw key is in the `201` answer and nowhere else. |
| `GET /v1/api-keys` | Lists every key, revoked and expired included. Never returns a raw key or a hash. |
| `POST /v1/api-keys/{id}/rotate` | Issues a new key with the same name, session, scopes and addresses (returned once) and ends the old key after `API_KEY_ROTATION_GRACE_MINUTES` (10 by default); the answer's `previousKeyExpiresAt` says when. |
| `DELETE /v1/api-keys/{id}` | Revokes the key. Revoking a revoked key keeps the first date. |

```bash
curl -X POST http://localhost:3000/v1/api-keys \
  -H "X-API-Key: $ADMIN_API_KEY" -H 'Content-Type: application/json' \
  -d '{"name":"chatbot","sessionId":"main","scopes":["read","send","events"]}'
```

- A key without `sessionId` is an admin key. A `sessionId` that does not exist answers `404 NOT_FOUND`.
- `allowedCidrs` entries must be addresses or CIDR ranges, `scopes` can only hold `read`, `send`,
  `manage`, `webhooks` and `events`, and `expiresAt` must be in the future: anything else is
  `400 VALIDATION_ERROR`.
- `API_KEY_MAX_TTL_DAYS` caps the lifetime. A key created without `expiresAt` gets the longest one
  allowed, and an `expiresAt` beyond the cap is refused, not shortened. `0` means no cap.
- A rotation carries over an expiry that is still ahead. A key with none, or one that already
  lapsed, gets the cap (or none when there is no cap). If the old key expires before the grace
  period ends it keeps that earlier date.
- Rotating or revoking a key that is missing (or, for a rotation, already revoked) is
  `404 NOT_FOUND`.
- Revoking the new key of a rotation does not touch the old one, which keeps working until the end
  of its grace period. To cut a leaked key at once, revoke that key itself (`DELETE` works during the
  grace period too), not its replacement.
- `METRICS_TOKEN`, like `ADMIN_API_KEY`, must have 32 characters or more.
- Both operations call `AuthService.invalidate`, so they take effect at once on this instance.

## Current status

Built: the guard, `AuthService`, the scopes, the address allowlist, the session helper and the key
management operations above. `AuthModule` is imported by the modules that have controllers
(`SystemModule`, `ApiKeysModule`) and registers the guard globally. `RateLimitModule` is imported
before them in `AppModule`, which is what puts the limit ahead of the guard.

Not built yet:

- The guard handles HTTP contexts only. A Socket.IO handler never goes through it; the gateway
  authenticates the handshake itself.
- Socket.IO authentication (`auth: { apiKey }`) arrives with the gateway and reuses
  `AuthService.authenticate`.
