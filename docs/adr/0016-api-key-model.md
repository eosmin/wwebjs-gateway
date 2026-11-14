# ADR 0016: API keys with scopes, one optional session, expiry, rotation and an address list

Status: Accepted (2026-10-29)

## Context

The gateway is reached by consuming applications, usually one per site or workspace, and each should reach
only its own WhatsApp session and only the capabilities it needs. A key that leaks must be cheap to cut,
and a forgotten declaration must not open a route. The consumers are the owner's own applications, not
third parties.

## Decision

- **Two kinds of key.** The bootstrap admin key (`ADMIN_API_KEY`, 32+ characters, compared in constant time,
  no row, no address list) and database keys (`wgk_` plus 43 url-safe characters). A database key with no
  `sessionId` is an admin key whatever its stored scopes say, so scopes only limit session keys, and
  creating a session-less key that carries `scopes` is refused instead of silently promoted.
- **Scopes:** `read`, `send`, `manage`, `webhooks`, `events` and `admin`. A new key gets `read`, `send`,
  `events`. No key can hold `admin`; only admin keys pass it. A scope stored outside the list is ignored, and
  a route that declares no scope is treated as `admin`, so a mistake closes the route.
- **Storage:** only the sha256 of the key is stored; the raw key is shown once, in the `201` answer. Keys,
  secrets and QR strings are never logged.
- **Expiry, rotation, address list.** `expiresAt` with an optional cap (`API_KEY_MAX_TTL_DAYS`);
  rotation issues a new key and ends the old one after `API_KEY_ROTATION_GRACE_MINUTES`; `allowedCidrs`
  limits the client address, behind proxies resolved from `TRUST_PROXY_HOPS`. An entry that does not parse
  matches nothing, so a corrupt list only denies.
- **One enforcement point per question:** `assertScope` for the scope and `assertSessionAccess` for the
  session, used by REST, sockets and inbound hooks alike. Revocations take effect within 30 seconds, and at
  once on this instance through `AuthService.invalidate`.

## Consequences

- A leaked session key reaches one session and only the scopes it holds; revoking it is one call.
- The environment key is the root of trust and has no address list, so the network must restrict the admin
  endpoints.
- Per-key and per-address rate limits sit in front of the guard, so a caller who invents keys costs a
  counter and not a database lookup.

## Alternatives considered

- **OAuth2 client credentials:** pays off with third-party consumers that need a token endpoint, scopes
  negotiated per client and short-lived tokens. With a few first-party consumers it adds a token service to
  run and secure.
- **mTLS:** strong, but needs a certificate authority and certificate handling in every consumer and proxy.
- **Per-request signed JWTs:** the gateway would need to know every consumer's verification key and
  clock, for the same threat that a revocable key already covers.
- **Store keys in clear to show them again:** a database leak would be a key leak. Hash and show once.

The three rejected options can be built later without breaking the key model, if third parties ever
consume the gateway.
