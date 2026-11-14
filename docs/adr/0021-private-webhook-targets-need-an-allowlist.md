# ADR 0021: private webhook targets are refused, and production reaches them only through an allowlist

Status: Accepted (2026-11-06)

## Context

Webhook and media URLs are fetched by the gateway on behalf of whoever configures them. Without a guard, a
configured URL can point at the private network, the neighbours of the gateway and the cloud metadata
service (a server-side request forgery). Some deployments do need a private target, for example a consumer
on the same compose network.

## Decision

- Every webhook and media URL goes through the guard (`assertPublicHttpUrl`): `http` or `https` on a public
  host, checked when the webhook is created or changed and again before every delivery, so a name that
  later resolves to a private address stops working. A host that does not resolve, or resolves to a
  private, reserved, metadata, link-local or unspecified address, is refused with one message.
- A private target is allowed by naming it in `WEBHOOK_PRIVATE_HOST_ALLOWLIST`, one entry per host or
  range, never by turning the guard off. Production refuses a `/0` prefix in that list (ADR 0007).
- `ALLOW_PRIVATE_WEBHOOK_TARGETS` (a broad switch for development) is **refused at start when `NODE_ENV` is
  `production`**. Outside production it logs a warning at start and still blocks the metadata and
  link-local ranges.

## Consequences

- A production deployment names each private target it needs; adding one is a configuration change.
- A webhook that worked and later resolves to a private address starts failing, which is the point.
- The guard is a check at the gateway, not a network control: a deployment that can also be reached from
  its private network should still restrict egress.

## Alternatives considered

- **Warn and allow the broad switch in production:** every webhook and media fetch of a production gateway
  could reach its private network.
- **Check only at creation:** a DNS name could be pointed at a private address afterwards.
- **A deny list of private ranges without an allowlist:** has no way to say which private host is wanted.
