# Implementation Plan — wwebjs-gateway

13 milestones (Phase 0 to Phase 12), 89 numbered steps. The specification is `docs/TDD.md`; this file is the checklist and the progress record. Work strictly in order; re-read the TDD sections cited in each step before implementing it.

Rules that apply to every step (details in `CLAUDE.md`): documentation ships in the same PR as the behavior; `pnpm validate:all` green before anything is proposed; the agent never runs `git commit`, `git push` or `gh pr create` without an explicit request from the owner; tick the step's box and update its row in "Progress tracking" as the last change of the step's PR.

---

## PR grouping (57 PRs)

One push + PR per step, grouping only tiny, tightly coupled steps. Branch name `<type>/<phase>-<n>-<slug>` (for a group, the first step: e.g. `feat/5-6-polls-chats-presence-lookup`). One PR open at a time unless the owner asks for stacked branches. Commits inside a PR: one per logical unit; one `chore(deps): add <package>` per dependency.

| Phase | PRs (steps) | Count |
| ----- | ----------- | ----- |
| 0 | [0.2–0.10] on `chore/tooling-foundation` (0.1 is a local commit on `main`, before it) | 1 |
| 1 | [1.1] [1.2] [1.3] [1.4] [1.5] | 5 |
| 2 | [2.1–2.2] [2.3–2.4] | 2 |
| 3 | [3.1] [3.2] [3.3–3.4] [3.5] [3.6] [3.7] [3.8] [3.9] [3.10] | 9 |
| 4 | [4.1] [4.2] [4.3–4.4] [4.5] [4.6] [4.7–4.8] | 6 |
| 5 | [5.1] [5.2] [5.3–5.4] [5.5] [5.6–5.9] [5.10] | 6 |
| 6 | [6.1] [6.2] [6.3] [6.4–6.5] [6.6–6.7] | 5 |
| 7 | [7.1–7.2] [7.3] [7.4] [7.5–7.6] | 4 |
| 8 | [8.1–8.2] [8.3] | 2 |
| 9 | [9.1] [9.2–9.3] [9.4] [9.5] [9.6] | 5 |
| 10 | [10.1–10.3] [10.4–10.5] [10.6–10.7] [10.8–10.10] | 4 |
| 11 | [11.1–11.2] [11.3–11.4] [11.5] [11.6] | 4 |
| 12 | [12.1] [12.2] [12.3] [12.4] | 4 |
| **Total** | | **57** |

Owner phrases (each valid for that step or group only): "commitea" = make the commits; "sube y abre PR" = push + `gh pr create`. A step's review (code-reviewer subagent) happens after its gates are green and before the commit is proposed.

---

## Milestone 0 — Setup and toolchain (branch `chore/tooling-foundation`, one PR) — TDD §2.6, §7

- [x] **0.1** `git init -b main`, `.gitignore`, `.nvmrc`, TDD moved to `docs/TDD.md`, this plan created. *Done when:* `git status` shows only those files and the plan lists 89 steps. The root `LICENSE` ("all rights reserved") is part of this step. *Publishing (only when the owner asks):* create the public repo `eosmin/wwebjs-gateway` and push the initial `main` once — the only direct push to `main`, needed so PRs have a base.
- [x] **0.2** pnpm workspace and `package.json` (scripts of §2.6.2). *Done when:* `pnpm install` works with pnpm 11.25.0 and generates the lockfile.
- [x] **0.3** One `chore(deps): add <package>` per dependency, then the Nest scaffold on the Fastify adapter with `GET /health`. *Done when:* `pnpm build` passes and `/health` answers 200 (verified in 0.3 by booting the built app with Fastify `inject`; Jest does not exist yet, so the committed health spec lands in 0.6 as TDD §7 says).
- [x] **0.4** Prettier and editor settings. *Done when:* `pnpm format:check` passes.
- [x] **0.5** ESLint flat config. *Done when:* `pnpm lint` passes with zero warnings on the scaffold.
- [x] **0.6** Jest with coverage gates (unit and integration configs). *Done when:* `pnpm test` and `pnpm test:cov` pass.
- [x] **0.7** Husky, lint-staged, commitlint, gitleaks. *Done when:* `commitlint` rejects a bad message and accepts a good one, and `gitleaks dir` flags a fake secret in a temporary directory (no commit is made to test this; the owner's first requested commit exercises `pre-commit` and `commit-msg` end to end).
- [x] **0.8** Validators (`validate-deprecations`, `validate-env-example`, `check-rollbacks`, `validate-affected`, `smoke-http`, `bootstrap.sh`), minimal env schema and `gen-docs`, `pre-push` wired. *Done when:* `pnpm validate:all` is green and `pre-push` runs `validate:affected`.
- [x] **0.9** CI pipeline, Dependabot, PR template, `deploy/github-ruleset.json`, `README.md` skeleton, `SECURITY.md`, minimal Prisma schema (+ `prisma`, `@prisma/client`), minimal Docker files (api + postgres + redis). *Done when:* the four CI jobs are green on the PR.
- [ ] **0.10** Claude Code hooks, settings, MCP config, skills and the `code-reviewer` subagent. The same PR carries ADRs 0001–0004. *Done when:* `.claude/settings.json` is valid, `code-review-graph status` runs, the agent file exists and the four ADRs follow the template.

## Milestone 1 — Foundation (`feat/foundation`) — TDD §6.1, §5.4, §6.8

- [ ] **1.1** Full `env.schema.ts`, `AppConfig`, `.env.example`, `config-reference.md`. *Done when:* `validate:env` and `validate:docs` pass.
- [ ] **1.2** `common/errors.ts` + `docs/errors.md` generator. *Done when:* every error code is in `errors.md`.
- [ ] **1.3** `types/{events,dto}.ts`. *Done when:* every event of §2.5 and §5.4 has a payload schema.
- [ ] **1.4** `common/lib/*` (crypto, wa-id, timeout, retry, throttle, token-bucket, humanize, ssrf). *Done when:* unit tests pass, SSRF cases included.
- [ ] **1.5** `infra/*` (Redis factory, logger with redaction, metrics + `metrics.md` generator). *Done when:* redaction is unit-tested and every metric is in `metrics.md`.

## Milestone 2 — Database (`feat/database`) — TDD §5.3

- [ ] **2.1** `prisma/schema.prisma` with every model. *Done when:* `prisma validate` and `pnpm db:generate` pass.
- [ ] **2.2** First migration and its rollback script. *Done when:* `validate:rollbacks` passes and the migration applies to an empty database.
- [ ] **2.3** `prisma.service.ts`. *Done when:* an integration test connects and disconnects cleanly.
- [ ] **2.4** Repositories (api-keys, sessions, webhooks, deliveries, inbound-hooks, messages, idempotency, suppressions). *Done when:* integration tests pass against Postgres.

## Milestone 3 — WhatsApp core (`feat/whatsapp-core`) — TDD §6.3–§6.6

- [ ] **3.1** `whatsapp-client.port.ts`. *Done when:* the port compiles and covers the inventory of §6.12.
- [ ] **3.2** `mappers.ts` (+ `extractOrigin`, `sanitizeRaw`). *Done when:* fixture tests pass.
- [ ] **3.3** `event-bus.service.ts`. *Done when:* typed publish/subscribe is unit-tested.
- [ ] **3.4** `tests/helpers/fake-whatsapp-client.ts`. *Done when:* it implements the whole port.
- [ ] **3.5** `inbound-order-buffer.ts`. *Done when:* all ordering cases of §6.4 pass.
- [ ] **3.6** `event-pipeline.service.ts`. *Done when:* dedupe, order, monotonic `seq` and crash recovery tests pass.
- [ ] **3.7** `session-manager.service.ts`. *Done when:* status machine, reconnect backoff, restore stagger and `MAX_SESSIONS` tests pass.
- [ ] **3.8** `watchdog.service.ts`. *Done when:* stuck-start and blocking-state tests pass.
- [ ] **3.9** `reconciler.service.ts`. *Done when:* recovery, no-duplicates and lookback tests pass.
- [ ] **3.10** `wwebjs-adapter.ts` (last), the `whatsapp-web.js` pin and `.github/workflows/wwebjs-watch.yml`. *Done when:* it compiles against the real library, covers every event, wraps calls in timeouts, and the lint boundary rule allows only this file to import `whatsapp-web.js`.

## Milestone 4 — API core (`feat/api-core`) — TDD §6.2, §6.7, §6.10, §6.11

- [ ] **4.1** `auth.service.ts` + `api-key.guard.ts` (session scope, permission scopes `read|send|manage|webhooks|events`, expiry, CIDR allowlist). *Done when:* tests pass for `INSUFFICIENT_SCOPE`, `API_KEY_EXPIRED`, `IP_NOT_ALLOWED` and revocation.
- [ ] **4.2** Filters and interceptors (error contract, request id, metrics, timeout). *Done when:* the error body matches §6.11.
- [ ] **4.3** `@WaOperation` + `operation-registry.service.ts`. *Done when:* the registry lists operations and rejects incomplete metadata.
- [ ] **4.4** Swagger and nestjs-zod wiring. *Done when:* `/docs/json` is valid OpenAPI.
- [ ] **4.5** System, health (`/ready`, `/metrics`) and api-keys controllers (incl. `rotate` with grace period; every operation declares its `scope`). *Done when:* `/ready` pings Postgres and Redis and fails without them.
- [ ] **4.6** Sessions and QR controllers. *Done when:* the server boots, creates a session and serves a QR (fake client).
- [ ] **4.7** `main.ts` finalized; `smoke-http` and CI checks move to `/ready`, `/metrics` and the error contract. *Done when:* the CI boot and image checks pass with the new probes.
- [ ] **4.8** `tests/parity/` skeleton. *Done when:* the expected-failures list exists and the test runs.

## Milestone 5 — Messaging (`feat/messaging`) — TDD §6.8, §6.8.1

- [ ] **5.1** `send-policy.service.ts`. *Done when:* every rule of §6.8.1 has a passing test, including the offline-recipient case.
- [ ] **5.2** `send-queue.service.ts` and the Bull Board mount (`/admin/queues`, admin-only, flag `BULL_BOARD_ENABLED`). *Done when:* ordering, idempotency, restart durability and `UNKNOWN_OUTCOME` tests pass.
- [ ] **5.3** `message-store.service.ts`. *Done when:* storage and retention are tested.
- [ ] **5.4** Idempotency flow. *Done when:* replay and conflict tests pass.
- [ ] **5.5** Messages controller. *Done when:* every message type sends through the fake client.
- [ ] **5.6** Polls and events controller.
- [ ] **5.7** Chats controller (incl. typing/recording state). *Done when:* the `chat.state` operation is covered over REST.
- [ ] **5.8** Presence, profile and settings controller.
- [ ] **5.9** Lookup controller.
- [ ] **5.10** Send-policy and suppressions controllers. *Done when:* usage and suppression endpoints are integration-tested.

## Milestone 6 — Contacts, groups, channels (`feat/contacts-groups-channels`) — TDD §6.11, §6.12

- [ ] **6.1** Contacts (incl. business profile, block/unblock, addressbook).
- [ ] **6.2** Groups.
- [ ] **6.3** Channels.
- [ ] **6.4** Labels.
- [ ] **6.5** Broadcasts and status.
- [ ] **6.6** Calls (ring buffer, link, reject).
- [ ] **6.7** Customer notes and remaining Client-level operations. *Done when:* the parity expected-failures list only holds Phase 7–9 items.

## Milestone 7 — Outbound webhooks (`feat/outbound-webhooks`) — TDD §6.9

- [ ] **7.1** `webhook.service.ts`.
- [ ] **7.2** Webhooks controller (CRUD, rotate-secret, test, deliveries, retry, retry-failed).
- [ ] **7.3** `webhook-dispatcher.service.ts`.
- [ ] **7.4** `delivery.processor.ts`. *Done when:* signature, retry and SSRF tests pass.
- [ ] **7.5** `retention.service.ts`.
- [ ] **7.6** `webhook-receiver.ts` helper and the integration suite. *Done when:* every scenario listed in §7 Phase 7 passes.

## Milestone 8 — Inbound hooks and realtime (`feat/inbound-and-realtime`) — TDD §6.10

- [ ] **8.1** `inbound-hook.service.ts`.
- [ ] **8.2** Inbound controller.
- [ ] **8.3** `socket.gateway.ts`. *Done when:* auth, scope, snapshot, fan-out, command round-trip (typing), replay and slow-consumer tests pass.

## Milestone 9 — Parity and documentation (`feat/parity-and-docs`) — TDD §6.12, §6.13

- [ ] **9.1** Complete `parity/overrides.ts`. *Done when:* the parity test passes with an empty expected-failures list.
- [ ] **9.2** `gen-docs.ts` generates every GENERATED file.
- [ ] **9.3** OpenAPI completeness test.
- [ ] **9.4** Strict docs tests (required-guide manifest complete).
- [ ] **9.5** Close every hand-written guide.
- [ ] **9.6** Close the ADR set. *Done when:* `pnpm validate:docs` is green and the README links every guide.

## Milestone 10 — Resilience (`feat/resilience-tests`) — TDD §7 Phase 10

- [ ] **10.1** `tests/helpers/chaos.ts`.
- [ ] **10.2** Redis restart mid-queue.
- [ ] **10.3** Postgres outage.
- [ ] **10.4** Webhook consumer 500/timeout storm.
- [ ] **10.5** Client crash during send.
- [ ] **10.6** Duplicate events after reconnect.
- [ ] **10.7** Shuffled burst emitted in `sentAt` order with correct `seq`.
- [ ] **10.8** Crash while a buffer is held, then restart.
- [ ] **10.9** Graceful shutdown flushes buffers and drains.
- [ ] **10.10** Boot with half-dead dependencies.

## Milestone 11 — Docker and deployment (`feat/docker-deploy`) — TDD §6.14

- [ ] **11.1** Hardened `Dockerfile` (Debian, Chromium, non-root). *Done when:* the `security-scan` job builds, runs and scans it clean.
- [ ] **11.2** `docker-entrypoint.sh`.
- [ ] **11.3** `docker-compose.yml` (dev: api + postgres + redis). *Done when:* `docker compose up` brings the whole project up healthy.
- [ ] **11.4** `docker-compose.prod.yml`.
- [ ] **11.5** `deploy/` files and the VPS/Railway/backup guides verified end to end. *Needs the hosting decision (TDD §11).*
- [ ] **11.6** `publish` job (GHCR on `main`) and optional deploy job.

## Milestone 12 — Real-number E2E (`feat/real-e2e`) — TDD §7 Phase 12 — needs two real phones (TDD §11)

- [ ] **12.1** Real E2E suite and script (QR/pairing → send → receive → webhook → socket → typing → groups → logout).
- [ ] **12.2** Offline burst ordering on real phones.
- [ ] **12.3** Capture a real Click-to-WhatsApp message, finalize `extractOrigin`, commit the REDACTED fixture.
- [ ] **12.4** Record the Buttons/List decision; finalize the README.
---

## Progress tracking

| Step | Status | PR | Date |
| ---- | ------ | -- | ---- |
| 0.1 | done | local commit on `main` (not pushed yet) | 2026-10-27 |
| 0.2 | done | `chore/tooling-foundation` (PR of Phase 0) | 2026-10-27 |
| 0.3 | done | `chore/tooling-foundation` (PR of Phase 0) | 2026-10-27 |
| 0.4 | done | `chore/tooling-foundation` (PR of Phase 0) | 2026-10-27 |
| 0.5 | done | `chore/tooling-foundation` (PR of Phase 0) | 2026-10-27 |
| 0.6 | done | `chore/tooling-foundation` (PR of Phase 0) | 2026-10-27 |
| 0.7 | done | `chore/tooling-foundation` (PR of Phase 0) | 2026-10-27 |
| 0.8 | done | `chore/tooling-foundation` (PR of Phase 0) | 2026-10-27 |
| 0.9 | done locally | `chore/tooling-foundation` (PR of Phase 0); the four CI jobs run when the PR opens | 2026-10-27 |
| 0.10 | todo | - | - |
| 1.1 | todo | - | - |
| 1.2 | todo | - | - |
| 1.3 | todo | - | - |
| 1.4 | todo | - | - |
| 1.5 | todo | - | - |
| 2.1 | todo | - | - |
| 2.2 | todo | - | - |
| 2.3 | todo | - | - |
| 2.4 | todo | - | - |
| 3.1 | todo | - | - |
| 3.2 | todo | - | - |
| 3.3 | todo | - | - |
| 3.4 | todo | - | - |
| 3.5 | todo | - | - |
| 3.6 | todo | - | - |
| 3.7 | todo | - | - |
| 3.8 | todo | - | - |
| 3.9 | todo | - | - |
| 3.10 | todo | - | - |
| 4.1 | todo | - | - |
| 4.2 | todo | - | - |
| 4.3 | todo | - | - |
| 4.4 | todo | - | - |
| 4.5 | todo | - | - |
| 4.6 | todo | - | - |
| 4.7 | todo | - | - |
| 4.8 | todo | - | - |
| 5.1 | todo | - | - |
| 5.2 | todo | - | - |
| 5.3 | todo | - | - |
| 5.4 | todo | - | - |
| 5.5 | todo | - | - |
| 5.6 | todo | - | - |
| 5.7 | todo | - | - |
| 5.8 | todo | - | - |
| 5.9 | todo | - | - |
| 5.10 | todo | - | - |
| 6.1 | todo | - | - |
| 6.2 | todo | - | - |
| 6.3 | todo | - | - |
| 6.4 | todo | - | - |
| 6.5 | todo | - | - |
| 6.6 | todo | - | - |
| 6.7 | todo | - | - |
| 7.1 | todo | - | - |
| 7.2 | todo | - | - |
| 7.3 | todo | - | - |
| 7.4 | todo | - | - |
| 7.5 | todo | - | - |
| 7.6 | todo | - | - |
| 8.1 | todo | - | - |
| 8.2 | todo | - | - |
| 8.3 | todo | - | - |
| 9.1 | todo | - | - |
| 9.2 | todo | - | - |
| 9.3 | todo | - | - |
| 9.4 | todo | - | - |
| 9.5 | todo | - | - |
| 9.6 | todo | - | - |
| 10.1 | todo | - | - |
| 10.2 | todo | - | - |
| 10.3 | todo | - | - |
| 10.4 | todo | - | - |
| 10.5 | todo | - | - |
| 10.6 | todo | - | - |
| 10.7 | todo | - | - |
| 10.8 | todo | - | - |
| 10.9 | todo | - | - |
| 10.10 | todo | - | - |
| 11.1 | todo | - | - |
| 11.2 | todo | - | - |
| 11.3 | todo | - | - |
| 11.4 | todo | - | - |
| 11.5 | todo | - | - |
| 11.6 | todo | - | - |
| 12.1 | todo | - | - |
| 12.2 | todo | - | - |
| 12.3 | todo | - | - |
| 12.4 | todo | - | - |
