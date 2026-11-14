# ADR 0017: no admin UI in this repository, and Bull Board for the queues

Status: Accepted (2026-10-27)

## Context

An operator wants to see and manage sessions, keys, webhooks and queues. The gateway is an API product
whose value is the REST, Socket.IO and webhook surface, and it is single-instance, with its own release and
hosting concerns. A user interface has a different audience, a different release rhythm and its own
dependencies and security surface.

## Decision

- **No frontend or admin UI is built in this repository.** The REST surface, the Socket.IO surface and
  `docs/openapi.json` (generated from the registry, ADR 0010) exist so a separate project can consume them.
- **Queue inspection is Bull Board,** mounted at `/admin/queues` only when `BULL_BOARD_ENABLED=true`
  (off by default, and then the route answers `404`). A browser cannot send `X-API-Key`, so this one route
  uses HTTP Basic with user `admin` and the value of `ADMIN_API_KEY` as the password. Because it bypasses
  the API guards it counts failures itself (ten wrong attempts a minute from one address answer `429`),
  and only its responses carry a relaxed `Content-Security-Policy` and `Cache-Control: no-store`.
- Swagger UI is off in production (`ENABLE_DOCS=false`, enforced at start, ADR 0007).

## Consequences

- An operator works with the API, the generated reference and the metrics; a dashboard is another project.
- Bull Board can retry, clean and delete jobs and shows message text, so it is an admin tool to be kept off
  in production unless someone is looking at something.
- The OpenAPI document is therefore a contract that has to stay complete, which tests enforce.

## Alternatives considered

- **Build an admin UI here:** doubles the surface to secure and release, in a repository meant to be a
  gateway.
- **A custom queue page:** would reimplement Bull Board for one use.
- **Expose Bull Board with the normal key header:** not possible from a browser; a query-string key would
  put a credential in URLs and logs.
