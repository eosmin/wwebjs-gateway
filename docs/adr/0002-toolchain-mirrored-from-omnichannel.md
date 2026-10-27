# ADR 0002: Toolchain mirrored from `omnichannel-platform`

Status: Accepted (2026-10-27)

## Context

This repository and `omnichannel-platform` have the same owner, the same quality standards (strict
typing, Conventional Commits, tests above a coverage gate, CI before merge, no secrets in history)
and the same kind of change: one person, short-lived branches, squash merges. Two different
toolchains would cost double to maintain and would make every habit, hook and CI failure behave
differently in each repository.

## Decision

Use the same tools, at the same versions, wherever the project does not differ: Node 24.20.0 and
pnpm 11 through corepack (`packageManager`), TypeScript 5.9, ESLint 10 with a flat config and
typescript-eslint, Prettier, Jest 30 with ts-jest, Husky 9 with lint-staged, commitlint and
gitleaks, Prisma 7 with BullMQ, pino, and the same PostgreSQL and Redis images.

Every version is pinned exactly in `package.json` (no `^`, no `~`) and the lockfile is committed.
TypeScript stays on 5.9 until typescript-eslint, ts-jest and NestJS certify the next major.
Dependabot's version updates only propose major bumps for npm and Docker, so a routine upgrade is
the owner's decision, read and done one area per pull request. Security updates are not affected by
that rule: GitHub's Dependabot alerts still open a pull request for a vulnerable pin, and the image
scan in CI fails on what they miss.

## Consequences

- A change in the shared toolchain is made in both repositories, or the difference is written
  down.
- The differences that exist are deliberate and recorded in the TDD: one package instead of an Nx
  monorepo, Fastify instead of Express, a Debian runtime image because Chromium needs glibc, ESM
  because NestJS 12 is ESM only, and Jest run with `--experimental-vm-modules` for the same reason.
- Pinning means a security fix does not arrive on its own. The image scan in CI is what catches it:
  run locally with the parameters of CI before the first push, it found high advisories in pinned
  packages (the case of ADR 0001) and in the base image.
- The Git hooks need `gitleaks`, which is a binary and not an npm package; `pnpm bootstrap` checks
  for it.

## Alternatives considered

- **A toolchain chosen only for this repository (Vitest, Biome, npm or yarn).** Each may be fine in
  isolation. None earns the cost of a second set of conventions for one owner.
- **Caret ranges and letting Dependabot bump minors and patches.** Less manual work, but a gateway
  that drives real conversations should change on purpose, with the changelog read.
- **Latest TypeScript.** The type-aware lint rules, ts-jest and NestJS had not certified the next
  major, so the project would carry unsupported combinations.
