# Architecture Decision Records

One file per decision, named `NNNN-short-title.md`, numbered in the order they were taken. A
decision that is replaced is not edited away: its status becomes `Superseded by ADR NNNN` and the
new record explains why.

Every record has the same shape, and `tests/parity/docs.spec.ts` fails CI when one does not:

```markdown
# ADR NNNN: Title

Status: Accepted (YYYY-MM-DD)

## Context

What forces led to the decision: the requirement, the constraint, what was known at the time.

## Decision

What was decided, in the active voice.

## Consequences

What becomes easier, what becomes harder, and what the project now has to live with.

## Alternatives considered

The other options and why each was not chosen.
```

| ADR | Decision |
| --- | --- |
| [0001](0001-nestjs-on-the-fastify-adapter.md) | NestJS on the Fastify adapter |
| [0002](0002-toolchain-mirrored-from-omnichannel.md) | Toolchain mirrored from `omnichannel-platform` |
| [0003](0003-public-repository-and-protect-main.md) | Public repository and the `protect-main` ruleset |
| [0004](0004-whatsapp-web-js-over-baileys.md) | `whatsapp-web.js` over Baileys |
| [0005](0005-prisma-7-with-the-pg-driver-adapter.md) | Prisma 7 with the `pg` driver adapter and the `cjs` generator format |
| [0006](0006-response-dtos-follow-what-wwebjs-delivers.md) | Response DTOs follow what `whatsapp-web.js` really delivers |
| [0007](0007-production-is-the-default-and-fails-fast.md) | Production is the default mode, and a bad production setup stops the start |
| [0008](0008-dedupe-survives-redis-and-migrations-are-atomic.md) | The event dedupe survives a Redis that loses its keys, and every migration is atomic |
| [0009](0009-single-instance-by-design.md) | One instance, by design |
| [0010](0010-one-operation-registry.md) | One `@WaOperation` registry drives every surface |
| [0011](0011-ordering-buffer-and-message-batch.md) | Inbound messages are ordered by the sender's time, before `seq` |
| [0012](0012-persistent-send-queue-and-idempotency.md) | A persistent send queue, an idempotency key, and no blind retry |
| [0013](0013-send-policy-and-cold-sends-off.md) | A send policy that behaves like a person, with cold sends off by default |
| [0014](0014-whatsapp-web-version-pinning.md) | The WhatsApp Web build and the library are pinned, and a pinned build that cannot load stops the start |
| [0015](0015-raw-and-origin-are-delivered-not-interpreted.md) | `raw` and `origin` are delivered, not interpreted |
| [0016](0016-api-key-model.md) | API keys with scopes, one optional session, expiry, rotation and an address list |
| [0017](0017-no-admin-ui-bull-board-for-queues.md) | No admin UI in this repository, and Bull Board for the queues |
| [0018](0018-single-package-with-a-monorepo-path.md) | A single package now, with a path to a pnpm workspace |
| [0019](0019-esm-module-format.md) | The code is ESM |
| [0020](0020-credentials-need-manage-and-are-never-replayed.md) | The QR and pairing code need `manage`, and a redacted credential is never replayed |
| [0021](0021-private-webhook-targets-need-an-allowlist.md) | Private webhook targets are refused, and production reaches them only through an allowlist |
| [0022](0022-watchdog-debounces-blocking-states.md) | The watchdog needs two reads before it fails a session |
