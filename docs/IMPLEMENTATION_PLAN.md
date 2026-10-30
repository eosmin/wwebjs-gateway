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
- [x] **0.10** Claude Code hooks, settings, MCP config, skills and the `code-reviewer` subagent. The same PR carries ADRs 0001–0004. *Done when:* `.claude/settings.json` is valid, `code-review-graph status` runs, the agent file exists and the four ADRs follow the template.

## Milestone 1 — Foundation (`feat/foundation`) — TDD §6.1, §5.4, §6.8

- [x] **1.1** Full `env.schema.ts`, `AppConfig`, `.env.example`, `config-reference.md`. *Done when:* `validate:env` and `validate:docs` pass.
- [x] **1.2** `common/errors.ts` + `docs/errors.md` generator. *Done when:* every error code is in `errors.md`.
- [x] **1.3** `types/{events,dto}.ts`. *Done when:* every event of §2.5 and §5.4 has a payload schema.
- [x] **1.4** `common/lib/*` (crypto, wa-id, timeout, retry, throttle, token-bucket, humanize, ssrf). *Done when:* unit tests pass, SSRF cases included.
- [x] **1.5** `infra/*` (Redis factory, logger with redaction, metrics + `metrics.md` generator). *Done when:* redaction is unit-tested and every metric is in `metrics.md`.

## Milestone 2 — Database (`feat/database`) — TDD §5.3

- [x] **2.1** `prisma/schema.prisma` with every model. *Done when:* `prisma validate` and `pnpm db:generate` pass.
- [x] **2.2** First migration and its rollback script. *Done when:* `validate:rollbacks` passes and the migration applies to an empty database.
- [x] **2.3** `prisma.service.ts`. *Done when:* an integration test connects and disconnects cleanly.
- [x] **2.4** Repositories (api-keys, sessions, webhooks, deliveries, inbound-hooks, messages, idempotency, suppressions). *Done when:* integration tests pass against Postgres.

## Milestone 3 — WhatsApp core (`feat/whatsapp-core`) — TDD §6.3–§6.6

- [x] **3.1** `whatsapp-client.port.ts`. *Done when:* the port compiles and covers the inventory of §6.12.
- [x] **3.2** `mappers.ts` (+ `extractOrigin`, `sanitizeRaw`). *Done when:* fixture tests pass.
- [x] **3.3** `event-bus.service.ts`. *Done when:* typed publish/subscribe is unit-tested.
- [x] **3.4** `tests/helpers/fake-whatsapp-client.ts`. *Done when:* it implements the whole port.
- [x] **3.5** `inbound-order-buffer.ts`. *Done when:* all ordering cases of §6.4 pass.
- [x] **3.6** `event-pipeline.service.ts`. *Done when:* dedupe, order, monotonic `seq` and crash recovery tests pass.
- [x] **3.7** `session-manager.service.ts`. *Done when:* status machine, reconnect backoff, restore stagger and `MAX_SESSIONS` tests pass.
- [x] **3.8** `watchdog.service.ts`. *Done when:* stuck-start and blocking-state tests pass.
- [x] **3.9** `reconciler.service.ts`. *Done when:* recovery, no-duplicates and lookback tests pass.
- [x] **3.10** `wwebjs-adapter.ts` (last), the `whatsapp-web.js` pin and `.github/workflows/wwebjs-watch.yml`. *Done when:* it compiles against the real library, covers every event, wraps calls in timeouts, and the lint boundary rule allows only this file to import `whatsapp-web.js`.

## Milestone 4 — API core (`feat/api-core`) — TDD §6.2, §6.7, §6.10, §6.11

- [x] **4.1** `auth.service.ts` + `api-key.guard.ts` (session scope, permission scopes `read|send|manage|webhooks|events`, expiry, CIDR allowlist). *Done when:* tests pass for `INSUFFICIENT_SCOPE`, `API_KEY_EXPIRED`, `IP_NOT_ALLOWED` and revocation.
- [x] **4.2** Filters and interceptors (error contract, request id, metrics, timeout). *Done when:* the error body matches §6.11.
- [x] **4.3** `@WaOperation` + `operation-registry.service.ts`. *Done when:* the registry lists operations and rejects incomplete metadata.
- [x] **4.4** Swagger and nestjs-zod wiring. *Done when:* `/docs/json` is valid OpenAPI.
- [x] **4.5** System, health (`/ready`, `/metrics`) and api-keys controllers (incl. `rotate` with grace period; every operation declares its `scope`). *Done when:* `/ready` pings Postgres and Redis and fails without them. *Carried over from 4.4 (reviews):* (a) a test through `AppModule` where a bad body on a route with a Zod DTO answers 400 `VALIDATION_ERROR` via the global pipe; (b) a `@ZodResponse` route whose extra output field is stripped by `ZodSerializerInterceptor`; (c) `buildOpenApiDocument` sets `security: []` on routes marked `@Public()` (`IS_PUBLIC_KEY`), so `/ready` and `/metrics` do not ask for the API key.
- [x] **4.6** Sessions and QR controllers. *Done when:* the server boots, creates a session and serves a QR (fake client).
- [x] **4.7** `main.ts` finalized; `smoke-http` and CI checks move to `/ready`, `/metrics` and the error contract. *Done when:* the CI boot and image checks pass with the new probes. *Carried over from 4.4:* `smoke-http` must request `/docs/json` with `ENABLE_DOCS=true` (nothing else tests that `main.ts` calls `setupDocs`) and get 404 with `ENABLE_DOCS=false`.
- [x] **4.8** `tests/parity/` skeleton. *Done when:* the expected-failures list exists and the test runs.

## Milestone 5 — Messaging (`feat/messaging`) — TDD §6.8, §6.8.1

- [x] **5.1** `send-policy.service.ts`. *Done when:* every rule of §6.8.1 has a passing test, including the offline-recipient case.
- [x] **5.2** `send-queue.service.ts` and the Bull Board mount (`/admin/queues`, admin-only, flag `BULL_BOARD_ENABLED`). *Done when:* ordering, idempotency, restart durability and `UNKNOWN_OUTCOME` tests pass.
- [x] **5.3** `message-store.service.ts`. *Done when:* storage and retention are tested.
- [ ] **5.4** Idempotency flow. *Done when:* replay and conflict tests pass.
- [ ] **5.5** Messages controller. *Done when:* every message type sends through the fake client. *Carried over from 4.7:* the adapter takes 1 MiB bodies; the send routes must raise their own `bodyLimit` to 40 MiB (TDD §6.11 cross-cutting) and a test must show a body over it is refused with 413.
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

- [ ] **10.1** `tests/helpers/chaos.ts`. *Carried over from 4.7:* `pnpm test` ends with Jest's "A worker process has failed to exit gracefully" (it also does on `main` before 4.7; `--detectOpenHandles` and per-folder runs do not reproduce it). Find the spec that leaks a timer or connection (suspects: the specs that point at `127.0.0.1:1`: `redis.service.spec.ts`, `redis.factory.spec.ts`, `prisma.service.spec.ts`), fix its teardown, and make the warning fail the build once it is gone.
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
- [ ] **11.3** `docker-compose.yml` (dev: api + postgres + redis). *Carried over from 4.7:* every compose file and deploy doc sets `stop_grace_period` above the 30 s hard-exit timer (Docker's default is 10 s, so SIGKILL would arrive before the graceful shutdown ends). *Done when:* `docker compose up` brings the whole project up healthy.
- [ ] **11.4** `docker-compose.prod.yml`.
- [ ] **11.5** `deploy/` files and the VPS/Railway/backup guides verified end to end. *Needs the hosting decision (TDD §11).*
- [ ] **11.6** `publish` job (GHCR on `main`) and optional deploy job.

## Milestone 12 — Real-number E2E (`feat/real-e2e`) — TDD §7 Phase 12 — needs two real phones (TDD §11)

- [ ] **12.1** Real E2E suite and script (QR/pairing → send → receive → webhook → socket → typing → groups → logout).
- [ ] **12.2** Offline burst ordering on real phones.
- [ ] **12.3** Capture a real Click-to-WhatsApp message, finalize `extractOrigin`, commit the REDACTED fixture.
- [ ] **12.4** Record the Buttons/List decision; finalize the README.
---

## Follow-ups carried to later steps

Found in the security reviews of steps 1.4 and 1.5 and deliberately left for the step that owns them. Tick each one in that step's PR; the two that need an owner decision are also in the PENDING table of TDD §11.

- [x] **4.2** The request-id interceptor writes the `x-request-id` RESPONSE header with the id Fastify already chose (`createFastifyAdapter`, step 1.5). Today the id reaches the logs but not the response.
- [x] **4.6** `GET /v1/system/info` adds the WhatsApp Web version and the live status of each session once `SessionManager` is registered (TDD §6.11 lists it; step 4.5 reports versions, uptime and counts by status only).
- [x] **4.7** Rate limit (`@nestjs/throttler` 6.7.1, TDD §2 and §6.14, `RATE_LIMIT_MAX`) keyed by API key or IP, including the public routes `/ready`, `/metrics` and the failed-authentication path (each unknown key costs one database lookup, and `/ready` pings Postgres and Redis per call). No step owned it before; found in the security review of 4.5.
- [x] **5.1** Cap the delay a `TokenBucket` may book (`POLICY_DELAY_EXCEEDED`); the bucket itself never refuses.
- [x] **5.2** Import `RedisModule` into `AppModule` with its first consumer. Queues and workers must close before `RedisService.onApplicationShutdown` runs (it quits and disconnects every connection).
- [ ] **5.5 and 7.4** Every outbound HTTP call to a user URL (media fetch, webhook delivery) runs `assertPublicHttpUrl` before each attempt, connects only to the returned `addresses` (Host and SNI from `url.hostname`) and uses `redirect: 'error'`. Add a test where the name resolves public at the check and private at the connection.
- [ ] **7.4** Decide and implement the production guard for `ALLOW_PRIVATE_WEBHOOK_TARGETS` (see TDD §11 PENDING).
- [ ] **3.x, the first step that logs message data** Decide which keys count as message content beyond `body`, `text` and `caption` (see TDD §11 PENDING), and never pass a secret as a `child()` logger binding: bindings bypass redaction.
- [ ] **10.2** The Redis restart test also checks the log: ioredis reports one error per retry (about every 2 s) and each becomes a log line; throttle it if it floods.
- [ ] **5.4** An idempotency key whose process died between `claim` and `complete`/`fail` stays `pending` until the 24 h purge (step 2.4 repository). The service must treat a stale `pending` key as an unknown outcome (conflict, never resend) and may need a "mark stale" method.
- [ ] **3.x, the order buffer** `listUnemitted` has no limit: batch it if a long outage can leave thousands of held rows (the recovery of step 3.6 reads them all on every `ready`). The ack of `upsert` still overwrites on a re-emitted message (`updateAck`, used by `message_ack`, is monotonic since 3.6).
- [x] **3.7** `seq` is a Redis `INCR`, and Redis runs with AOF `everysec`: a Redis crash can lose about a second of increments, so `seq` could repeat numbers already delivered, which breaks "strictly increasing". When a session starts, raise `seq:<id>` to at least the last `seq` known to have been delivered (keep a high-water mark in Postgres, written every N events and on session stop), or document the limit in the operations guide if that is judged too costly.
- [x] **3.7** The session manager must `await` `EventPipelineService.open(sessionId, client, { orderingEnabled: settings.ordering.enabled })` BEFORE it initializes the client (a new one on every start; events emitted earlier are not seen) and `close(sessionId)` when it stops it, and publish its own events (`session_status`, ...) with `EventPipelineService.publish` so they share the `seq` counter. Deleting a session must also delete its Redis keys `seq:<id>` and `dedupe:<id>:*`.
- [x] **3.8** `SessionManager` keeps no `startedAt` and has no public way into its reconnect path yet: the watchdog needs both (stuck startup restarts the session; a blocking state sets `failed` + `lastError` instead of looping, a failed health check goes through the reconnect). Add them there, with `WATCHDOG_*` documented in `docs/sessions.md`.
- [x] **5.2** The memory guard of the watchdog (TDD §6.5: process RSS above `MEMORY_RESTART_THRESHOLD_MB` restarts the largest idle session, never mid-send) was left out of 3.8: it needs the send queue to know a session is idle, and a way to tell which session is the largest (the port has no per-session memory). Add both here, with tests, and remove the "not part of this pass yet" note from `docs/sessions.md`.
- [x] **4.6** Register `SessionManager` and `WatchdogService` in a module (none exists yet) and import it into `AppModule`: until then neither runs. The boot test of 4.6 must cover the watchdog timer starting and stopping with the app.
- [x] **5.x, the sessions API** The `Session` rows that `SessionManager` returns carry `seqHighWater` (a `bigint`, which `JSON.stringify` rejects). The mapper to the session DTO must leave it out; add a test that a DTO serializes.
- [x] **3.9** The manager does not call the reconciler (it comes later in the dependency order): subscribe to `session_status` with `status: 'ready'` on the `EventBusService`.
- [x] **3.9** The reconciler feeds recovered messages with `InboundOrderBuffer.offer(message, 'reconcile')` through the same pipeline path (it needs a public entry point on `EventPipelineService`); the batch `reason` stays `reconcile` only for a buffer it opened.
- [x] **4.6** Register `ReconcilerService` in the same module as `SessionManager` and `WatchdogService`; the boot test must cover it subscribing to `session_status` and unsubscribing at shutdown.
- [x] **4.6** In the same module provide `WHATSAPP_CLIENT_FACTORY` with `createWwebjsClientFactory(config)` (`APP_CONFIG`); until then no session can start. The boot test must show the token resolves to the real factory and that building a client does not open a browser.
- [x] **4.7** The process guard for unhandled rejections: `isPuppeteerFailure` (exported by `wwebjs-adapter.ts`, defined in `wa-call.ts`) says whether a rejection is a Puppeteer death. A rejection raised inside wwebjs itself (its `framenavigated` handler, its `exposeFunction` callbacks) comes from no call of ours and names no session, so decide how it is attributed (for example, reconnect every session that is not `ready`) and test it; the adapter already reports a dead browser or page of its own session as `session_error`.
- [ ] **6.7, pairing code** `POST` and `DELETE /v1/sessions/:sessionId/pairing-code` (`Client.requestPairingCode`, `cancelPairingCode`) and the battery in `GET …/info` (`Client.getBatteryStatus`) were left out of 4.6: `SessionManager` only hands out the client of a ready session (`requireReady`), and a pairing code is requested while the session is in `qr`. Add a manager method that reaches a started client, with tests, then the two routes; `POST …/start` takes no body until then. 6.7 owns it because its "Done when" (parity expected-failures empty of Phase 5–6 items) cannot pass while `Client.requestPairingCode`, `cancelPairingCode` and `getBatteryStatus` are unmapped; step 12.1 (real E2E with pairing) needs it too.
- [ ] **12.3** With a real account, check what 3.10 could only read in the source of wwebjs 1.34.7: a wid in `groupMentions[].groupJid`, `mentionedIds`, `PollVote.voter` and `Call.from`; `{ name, localId }` options in `pollOptions` and `selectedOptions`; the `event*` fields of `Message` (the typings declare them, `Message.js` never sets them: an event's data is only in `raw`); and the `disconnected` reason `Max qrcode retries reached` when `QR_MAX_RETRIES` runs out (the manager reconnects on it). Redacted fixtures go in `tests/fixtures/`.
- [ ] **5.x, the send route** `SendOptions.extra` (and `EditOptions.extra`, `ChannelSendOptions.extra`) reaches wwebjs untouched, and wwebjs merges it into the message built inside the WhatsApp Web page. The request schema must be a `strictObject`, bound `extra` (key count, depth, size) and the docs must say it is a power-user escape hatch behind the `send` scope; decide with the owner whether to allow-list its keys.
- [ ] **9.5** Write `docs/upgrading.md`: `dependabot.yml`, `wwebjs-watch.yml` and TDD §6.14 point to it and it does not exist yet. Include the three levels, the typings-vs-runtime check of TDD §2.5, and re-enabling the release watch after GitHub pauses an idle repository's schedules.
- [ ] **11.1** The image must install Chromium and the deployment must set `PUPPETEER_EXECUTABLE_PATH` (the install runs no puppeteer build script, so no browser is downloaded). `--no-sandbox` is always on (TDD §6.3): the image runs as a non-root user, and the threat model (ADR) must say that the container is the boundary, so no extra privileges, a read-only root where possible and a restricted network egress. The first `security-scan` run after 3.10 may report the puppeteer tree: judge each finding and add a justified `.trivyignore` entry only for a real false positive.
- [ ] **12.3** Promote `getInviteInfo` to a named DTO once its shape is seen on a real invite (the adapter answers a sanitized `Record<string, unknown>`).
- [ ] **7.x, the webhook retry endpoints** `POST …/deliveries/retry-failed` needs a bulk reset (the repository only has `resetForRetry` per delivery).

## Progress tracking

| Step | Status | PR | Date |
| ---- | ------ | -- | ---- |
| 0.1 | done | local commit on `main`, pushed once as the initial `main` | 2026-10-27 |
| 0.2 | done | #1 (PR of Phase 0) | 2026-10-27 |
| 0.3 | done | #1 (PR of Phase 0) | 2026-10-27 |
| 0.4 | done | #1 (PR of Phase 0) | 2026-10-27 |
| 0.5 | done | #1 (PR of Phase 0) | 2026-10-27 |
| 0.6 | done | #1 (PR of Phase 0) | 2026-10-27 |
| 0.7 | done | #1 (PR of Phase 0) | 2026-10-27 |
| 0.8 | done | #1 (PR of Phase 0) | 2026-10-27 |
| 0.9 | done | #1 (PR of Phase 0); the four CI jobs green | 2026-10-27 |
| 0.10 | done | #1 (PR of Phase 0) | 2026-10-27 |
| 1.1 | done | `feat/1-1-config-schema` | 2026-10-27 |
| 1.2 | done | `feat/1-2-errors` | 2026-10-27 |
| 1.3 | done | `feat/1-3-types` | 2026-10-27 |
| 1.4 | done | `feat/1-4-common-lib` | 2026-10-27 |
| 1.5 | done | `feat/1-5-infra` | 2026-10-27 |
| 2.1 | done | `feat/2-1-prisma-schema` | 2026-10-27 |
| 2.2 | done | `feat/2-2-first-migration` | 2026-10-27 |
| 2.3 | done | `feat/2-3-prisma-service` | 2026-10-27 |
| 2.4 | done | `feat/2-4-repositories` | 2026-10-27 |
| 3.1 | done | `feat/3-1-client-port` | 2026-10-27 |
| 3.2 | done | `feat/3-2-mappers` | 2026-10-27 |
| 3.3 | done | `feat/3-3-event-bus` | 2026-10-27 |
| 3.4 | done | `feat/3-4-fake-client` | 2026-10-27 |
| 3.5 | done | `feat/3-5-order-buffer` | 2026-10-27 |
| 3.6 | done | `feat/3-6-event-pipeline` | 2026-10-27 |
| 3.7 | done | `feat/3-7-session-manager` | 2026-10-28 |
| 3.8 | done | #21 | 2026-10-28 |
| 3.9 | done | #22 | 2026-10-28 |
| 3.10 | done | #23 | 2026-10-28 |
| 4.1 | done | `feat/4-1-auth` | 2026-10-28 |
| 4.2 | done | `feat/4-2-filters-interceptors` | 2026-10-28 |
| 4.3 | done | `feat/4-3-operation-registry` | 2026-10-28 |
| 4.4 | done | `feat/4-4-swagger-zod` | 2026-10-28 |
| 4.5 | done | `feat/4-5-system-health-keys` | 2026-10-28 |
| 4.6 | done | `feat/4-6-sessions-qr` | 2026-10-28 |
| 4.7 | done | `feat/4-7-main-ratelimit-guard` | 2026-10-29 |
| 4.8 | done | `feat/4-8-parity-skeleton` | 2026-10-29 |
| 5.1 | done | `feat/5-1-send-policy` | 2026-10-29 |
| 5.2 | done | `feat/5-2-send-queue` | 2026-10-29 |
| 5.3 | done | `feat/5-3-message-store` | 2026-10-29 |
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
