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

| ADR                                                 | Decision                                                |
| --------------------------------------------------- | ------------------------------------------------------- |
| [0001](0001-nestjs-on-the-fastify-adapter.md)       | NestJS on the Fastify adapter                           |
| [0002](0002-toolchain-mirrored-from-omnichannel.md) | Toolchain mirrored from `omnichannel-platform`          |
| [0003](0003-public-repository-and-protect-main.md)  | Public repository and the `protect-main` ruleset        |
| [0004](0004-whatsapp-web-js-over-baileys.md)        | `whatsapp-web.js` over Baileys                          |
| [0005](0005-prisma-7-with-the-pg-driver-adapter.md) | Prisma 7 with the `pg` driver adapter, `cjs` generator |
