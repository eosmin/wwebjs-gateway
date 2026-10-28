# Authentication

Every route needs an API key unless it is marked public (`/health`, and the routes that say so in
later steps). Send the key as `X-API-Key: <key>` or `Authorization: Bearer <key>`; `X-API-Key`
wins when both are present. Any other `Authorization` scheme is not a key.

## Kinds of key

| Key | Where it lives | Reaches |
| --- | --- | --- |
| Bootstrap admin | `ADMIN_API_KEY` (32+ characters), compared in constant time, no row, no address list | everything |
| Admin | a database key with no session | everything |
| Session | a database key with a `sessionId` | `/v1/sessions/{thatId}/…` and its own webhooks, only for its scopes |

A database key with no session is an admin key whatever its stored scopes say: scopes only limit
session keys. Creating a key without a session therefore needs an admin key, and the create
endpoint (step 4.5) rejects a session-less key that carries restricted scopes instead of silently
promoting it.

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

## Current status

Built: the guard, `AuthService`, the scopes, the address allowlist and the session helper.

Not wired yet, on purpose:

- `AuthModule` is not imported by `AppModule`, because it needs the database module and the
  application has no controller that uses it yet. It is wired when the first controllers arrive
  (steps 4.5 and 4.6); until then `/health` is the only route and it is public.
- `@WaOperation` (step 4.3) sets the scope of every operation through `@RequireScope`.
- Creating, listing, revoking and rotating keys (`/v1/api-keys`, grace period of
  `API_KEY_ROTATION_GRACE_MINUTES`, cap `API_KEY_MAX_TTL_DAYS`) arrives in step 4.5; revoke and
  rotate call `AuthService.invalidate`.
- `GET /metrics` accepts an admin key or the `METRICS_TOKEN` bearer (step 4.5).
- The guard handles HTTP contexts only. A Socket.IO handler never goes through it; the gateway
  authenticates the handshake itself.
- Socket.IO authentication (`auth: { apiKey }`) arrives with the gateway and reuses
  `AuthService.authenticate`.
