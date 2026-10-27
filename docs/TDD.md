# TDD — wwebjs-gateway: Production-Grade REST + Webhook + Socket Gateway for whatsapp-web.js (100% API parity)

> **Audience:** an AI coding agent with ZERO prior context. This document is self-contained. Read it fully before writing any code.
> **Stage:** build stage. The repository lives in `whatsapp/` (`git init` was run INSIDE it, never at the `portafolio/` root) and this file is `docs/TDD.md`. The step-by-step checklist and progress record is `docs/IMPLEMENTATION_PLAN.md`.
> **Revision:** v3, 2026-10-26 (NestJS + Prisma; ordered inbound delivery + `message_batch`; ad-origin metadata). **Package/repo name:** `wwebjs-gateway`.
> **IMPORTANT — this is a REAL production system, not a demo.** It will carry real customer conversations (chatbots and conversational apps). Every decision below prioritizes correctness, durability and recoverability over brevity.

---

## 1. Project Description & Goals

`wwebjs-gateway` is a self-hosted HTTP gateway that wraps [`whatsapp-web.js`](https://github.com/wwebjs/whatsapp-web.js) 1.34.7 (Puppeteer-driven WhatsApp Web) and exposes **100% of its public API** through four integration surfaces:

1. **REST API** (`/v1/...`) — every `Client`, `Chat`, `GroupChat`, `Channel`, `Message`, `Contact`, `Label`, `Broadcast`, `Poll`, `Call`… capability.
2. **Socket.IO** — realtime event stream AND bidirectional commands (an external app can emit `typing`, `send`, `seen`, … over the socket and the gateway applies it to the conversation).
3. **Outbound webhooks** — every WhatsApp event is POSTed (HMAC-signed, at-least-once, ordered by `seq`, retried, with a persisted delivery log and replay) to registered URLs.
4. **Inbound webhooks** — external systems POST to a secret per-session URL to make the gateway act (send a message).

### Primary use case
Own applications (no third-party tenants) running **normal conversations and chatbots** across several WhatsApp accounts. No mass messaging / campaigns. Think: customer support lines, bots that read incoming messages via webhook/socket and reply (with human-like typing), internal tools.

### Goals
- **100% parity** with the public surface of whatsapp-web.js 1.34.7, *proven by an automated parity test* (§6.12).
- **100% documented**: every route, event, socket command, env var and operational procedure, enforced by CI drift checks (§6.13).
- **Correct conversation order**: when a contact writes many messages while offline and WhatsApp delivers them in one burst, the gateway emits them in the order they were WRITTEN, and offers a single ordered `message_batch` event so a chatbot can answer once (§6.4).
- **Complete inbound context**: every message event carries the full WhatsApp Web raw data (`raw`) plus a derived `origin` (e.g. Meta Click-to-WhatsApp ad metadata) so consumers can tell where a conversation came from (§6.6.1).
- **Robust and failure-tolerant**: survives Chromium crashes, WhatsApp disconnects, Redis/Postgres restarts, webhook consumer outages, process restarts, duplicate events (§6.4–6.10).
- **Operable**: health/readiness, Prometheus metrics, structured logs, runbooks for deploy (VPS **and** Railway), backup/restore, upgrades.

### Non-goals (YAGNI — do NOT build)
- Official WhatsApp Business Cloud API support.
- Multi-tenant SaaS features (accounts, billing, quotas). API keys are for the owner's own apps.
- Horizontal scaling / multi-node. **Single instance by design**: a session's Chromium process is pinned to one Node process. Run exactly ONE replica (README and deploy guides state this loudly). Failover = fast automatic restart + session restore.
- `RemoteAuth`. Sessions persist via `LocalAuth` on a persistent volume plus the backup runbook (§6.14).
- A frontend/admin UI in this repository (the REST + Socket.IO surface and `docs/openapi.json` exist so a separate project can consume them; a possible future monorepo is described in an ADR). Queue inspection is covered by Bull Board, not by a custom UI.
- Mass-messaging features (campaign scheduler, bulk import, contact lists).
- Business logic of consumer applications (auto-replies, routing rules, lead matching). The gateway only DELIVERS data (`origin`, `message_batch`); consumers decide what to do with it. Nothing about any specific consumer appears in the code or docs.
- Raw Puppeteer access (`Client.pupPage` / `Client.pupBrowser`) and arbitrary `evaluate` — `unsupported` in the parity matrix for security.

### Hard limits of the underlying library (document them; do not pretend otherwise)
- **No incoming typing/presence events.** The library emits no event when a contact is typing/recording/online. The gateway can SET chat state outbound (typing/recording/clear, shown by WhatsApp for ~25 s) but cannot report the other party's. Documented in `docs/limits.md`.
- **Timestamp resolution is 1 second**, set by the SENDER's device. Messages written within the same second can tie; ties are broken by WhatsApp Web's own chat order (§6.4). Documented.
- Buttons / List messages: classes exist but WhatsApp stopped rendering them; marked `unsupported` UNLESS the real-number smoke test (§7, Phase 12) proves they work on the pinned version.
- The library is unofficial; automating accounts can violate WhatsApp's ToS and get numbers banned. README states: legitimate, consent-based conversational use only; no spam; use at your own risk.

---

## 2. Tech Stack (exact versions — pin exactly in `package.json`, commit the lockfile)

Versions verified against the npm registry on 2026-10-26.

| Concern | Choice | Version |
|---|---|---|
| Runtime | Node.js | **24.20.0** (`.nvmrc` = `24.20.0`; Docker `node:24.20.0-bookworm-slim`) |
| Package manager | `pnpm` through corepack (`packageManager` field of `package.json`) | 11.25.0 |
| Language | TypeScript (`strict`, `noImplicitAny`, `noUncheckedIndexedAccess`) | **5.9.3** (stay on 5.9 until typescript-eslint, ts-jest and Nest certify the next major — same policy as `omnichannel-platform`) |
| WhatsApp | `whatsapp-web.js` | 1.34.7 |
| Framework | NestJS: `@nestjs/core`, `@nestjs/common`, `@nestjs/platform-fastify` (Fastify 5 adapter), `@nestjs/cli`, `@nestjs/testing` | 12.0.2 / 12.0.2 / 12.0.2 / 12.0.10 / 12.0.2 (12.0.2 of the Fastify adapter fixes GHSA-9c5c-9qcx-q35q and brings `fastify` 5.12.4, which fixes four high advisories in 5.12.1; every other Nest package keeps the 12.0.1 pin that `omnichannel-platform` runs with, which is compatible because their peer ranges accept any 12.x core; bump deliberately, one area per PR) |
| HTTP engine | `fastify` (via adapter; use the version `@nestjs/platform-fastify` requires: `@nestjs/platform-fastify@12.0.2` pins fastify `5.12.4` exactly; 5.12.7 belongs to adapter 12.2.0. 5.12.1, the pin of adapter 12.0.1, has four high advisories: an authentication bypass through malformed URLs and three validation bypasses) | 5.12.4 |
| Validation | `zod` (v4, import from `"zod"`) + `nestjs-zod` | 4.6.7 / 5.5.0 |
| OpenAPI | `@nestjs/swagger` | 12.0.4 |
| Config / health / throttling | `@nestjs/config` 12.0.1, `@nestjs/terminus` 12.1.0, `@nestjs/throttler` 6.7.1 | — |
| Security | `@fastify/helmet` 13.2.0, `@fastify/cors` 11.3.1 | — |
| Realtime | `@nestjs/websockets` + `@nestjs/platform-socket.io` (both 12.0.1) over `socket.io` | 4.8.4 |
| Queue | `@nestjs/bullmq` + `bullmq` + `ioredis` | 12.0.0 / 6.3.4 / 6.0.0 |
| Queue dashboard | `@bull-board/api` + `@bull-board/fastify` + `@bull-board/ui` (flag `BULL_BOARD_ENABLED`, default false; the Fastify adapter exists at 9.10.5, verified) | 9.10.5 |
| Scheduling | `@nestjs/schedule` (watchdog, reconciliation timers) | 12.0.2 |
| Database | PostgreSQL (image `postgres:18.6-alpine`) via `prisma` (CLI; a RUNTIME dependency, because the image runs `prisma migrate deploy` before starting and `prisma.config.ts` imports `prisma/config`) + `@prisma/client` + `@prisma/adapter-pg` + `pg` | **7.10.1** for the three Prisma packages (do NOT use `prisma@8.0.0-rc.*`, release candidate); `pg` 8.16.3 |
| Cache/queue store | Redis (image `redis:8.10.1-alpine`, AOF enabled: `appendonly yes`) | 8.10.1 |
| Logging | `nestjs-pino` + `pino` + `pino-http` (dev: `pino-pretty`) | 5.1.0 / 10.3.1 / 11.0.0 / 13.1.3 |
| Metrics | `@prometheus-io/client` (`prom-client` is deprecated upstream: "replaced by @prometheus-io/client"; verify its API with Context7) | 0.16.1 |
| QR rendering | `qrcode` + `@types/qrcode` | 1.5.4 / 1.5.6 |
| Tests | `jest` + `ts-jest` + `@types/jest` + `jest-environment-node`; `supertest` + `@types/supertest`; `@nestjs/testing`; `socket.io-client` | 30.5.1 / 29.4.12 / 30.0.0 / 30.5.1; 7.2.2 / 7.2.1; 12.0.1; 4.8.4 |
| Lint | `eslint`, `@eslint/js`, `typescript-eslint`, `eslint-plugin-import-x`, `eslint-import-resolver-typescript` | 10.9.1 / 10.0.1 / 8.69.0 / 4.17.1 (4.16.x does not declare ESLint 10 as a peer) / 4.4.5 |
| Format | `prettier` | 3.9.6 |
| Git hooks / commits | `husky` 9.1.7, `lint-staged` 17.4.1, `@commitlint/cli` + `@commitlint/config-conventional` 21.2.2 | — |
| Secret scanning | `gitleaks` (Go binary, NOT an npm package: `brew install gitleaks`; CI downloads pinned release 8.28.0) | 8.28.0 |
| Script runner | `tsx` | 4.20.5 |
| Types | `@types/node` | 24.19.2 (follows the Node 24 runtime major) |
| Infra | Docker, docker compose, GitHub Actions, Caddy (VPS reverse proxy, in docs) | — |

**Notes:**
- **Toolchain alignment:** every tool and version above that is not specific to this gateway (pnpm, Node, TypeScript 5.9.3, ESLint 10, Prettier, Jest 30 + ts-jest, Husky, lint-staged, commitlint, gitleaks, Prisma 7.10.1, BullMQ, pino, Postgres/Redis images) mirrors `omnichannel-platform` on purpose, so both projects share tooling behavior. NestJS needs `experimentalDecorators` + `emitDecoratorMetadata`. §2.6 specifies the whole toolchain and automation, which is installed in Phase 0 BEFORE any feature code.
- **Module format (decided in step 0.3): ESM.** `"type": "module"`, `module`/`moduleResolution: nodenext`, relative imports carry the `.js` suffix. `@nestjs/core`, `@nestjs/common` and `@nestjs/platform-fastify` 12 are ESM-only (`type: module`), and `nest new` defaults to ESM; CommonJS only type-checks under `moduleResolution: node10` and runs through Node 24's `require(esm)`, which breaks on top-level await and is removed from TypeScript 7. Jest runs from `.cts` configs with `tsconfig.spec.json` set to `module: commonjs`/`moduleResolution: node10`/`verbatimModuleSyntax: false`, as in `omnichannel-platform`. whatever is chosen, only `src/whatsapp/wwebjs-adapter.ts` imports `whatsapp-web.js` (CommonJS; if named ESM imports fail use `import wwebjs from 'whatsapp-web.js'; const { Client, LocalAuth, MessageMedia, Poll, Location, ScheduledEvent } = wwebjs;`).
- **Logging:** `nestjs-pino` 5.1.0 + `pino` 10.3.1 are what `omnichannel-platform` runs with on Nest 12; reuse that setup (request-id correlation, redaction).
- **Do NOT add `puppeteer` as a direct dependency** (whatsapp-web.js depends on it). In Docker install system Chromium and set `PUPPETEER_SKIP_DOWNLOAD=true` + `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`.
- Before pinning any version re-run `npm view <pkg> version` and re-verify with Context7 (§8). If it differs from this table, update this TDD first.

### 2.5 Compatibility Matrix & Migration Notes (authoritative — read before touching each library)

**NestJS 12 + Fastify 5**
- Bootstrap with `NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ bodyLimit }))`. Register `@fastify/helmet`/`@fastify/cors` on the adapter. Enable shutdown hooks (`app.enableShutdownHooks()`); graceful-shutdown logic lives in `OnApplicationShutdown`/`BeforeApplicationShutdown` providers (§6.14).
- Fastify 5 requires full schemas; we validate with `nestjs-zod` (`ZodValidationPipe`, `createZodDto`, `ZodSerializerInterceptor`) so DTO classes are generated from Zod schemas and feed `@nestjs/swagger`. Use `patchNestJsSwagger()` as documented by `nestjs-zod`.
- Use Zod 4 only: `import { z } from 'zod'`; never `zod/v3`.
- Never use the Express-specific APIs (`@nestjs/platform-express`, `req.res`, Express middleware types).

**Zod 4 — banned (deprecated) forms → use:**
`z.string().email()`→`z.email()`; `z.string().uuid()`→`z.uuid()`; `z.string().url()`→`z.url()`; `z.nativeEnum(X)`→`z.enum(X)`; `.strict()`/`.passthrough()`→`z.strictObject()`/`z.looseObject()`; `error.format()`/`error.flatten()`→`z.treeifyError(error)`.

**Prisma 7**
- Use the driver-adapter setup (`@prisma/adapter-pg`) and the generator/config layout Prisma 7 requires (`prisma.config.ts`, generator output path) — **fetch the exact current setup from Context7 before writing `schema.prisma`**; do not rely on Prisma ≤6 snippets.
- `PrismaService` extends/wraps `PrismaClient`, connects in `onModuleInit`, disconnects in `onModuleDestroy`.
- Migrations: `prisma migrate dev` locally (commit the generated SQL in `prisma/migrations/`), `prisma migrate deploy` in the container entrypoint BEFORE starting Node. Never `prisma db push` outside throwaway local experiments.
- `BigInt` columns (e.g. `seq`) are not JSON-serializable: convert at the repository boundary to `number` (safe range) or `string`; never leak `bigint` into DTOs.
- Partial/functional indexes are not expressible in `schema.prisma`; add them as raw SQL inside a migration if needed and document it in the migration folder README.

**BullMQ (`@nestjs/bullmq`)**
- `QueueScheduler` is removed — never use it. Repeatable jobs use `queue.upsertJobScheduler(...)`, not `add(..., { repeat })`.
- Every `ioredis` instance given to a `Worker` MUST have `maxRetriesPerRequest: null`. One shared connection factory always sets it.
- Retries: `attempts` + `backoff: { type: 'exponential', delay }`. Always set `removeOnComplete`/`removeOnFail` with age/count limits.
- Per-session send queues are created dynamically (`Queue`/`Worker` instances managed by `SendQueueService`), not with static `@Processor` decorators; static `@Processor` is fine for the webhook delivery and retention queues.

**whatsapp-web.js 1.34.7**
- Session isolation: `LocalAuth({ clientId, dataPath })`; `clientId` must match `^[-_\w]+$` (library throws otherwise). `LocalAuth` throws if `puppeteer.userDataDir` is user-supplied — never set it.
- **Authoritative event names** (from `util/Constants`, verified): `qr`, `code`, `authenticated`, `auth_failure`, `ready`, `loading_screen`, `disconnected`, `change_state`, `change_battery`, `message` (incoming only), `message_create` (all created incl. own), `message_ack`, `message_edit`, `message_revoke_everyone`, `message_revoke_me`, `message_reaction`, `message_ciphertext`, `message_ciphertext_failed`, `media_uploaded`, `unread_count`, `chat_removed`, `chat_archived`, `contact_changed`, `group_join`, `group_leave`, `group_update`, `group_admin_changed`, `group_membership_request`, `vote_update`, `call`, `remote_session_saved`. (`incoming_call` and `code_received` are NOT event names.) Re-verify against the pinned version's `Constants.js` at build time.
- `ClientOptions.pairWithPhoneNumber` + `Client.requestPairingCode()`/`cancelPairingCode()` provide phone-number login; the `code` event delivers the code.
- `MessageAck`: -1 error, 0 pending, 1 server, 2 device, 3 read, 4 played. `WAState` includes `CONFLICT`, `CONNECTED`, `DEPRECATED_VERSION`, `OPENING`, `PAIRING`, `PROXYBLOCK`, `SMB_TOS_BLOCK`, `TIMEOUT`, `TOS_BLOCK`, `UNLAUNCHED`, `UNPAIRED`, `UNPAIRED_IDLE`.
- `Message.timestamp` is `data.t` — the sender-side send time in **seconds**. `Message.rawData` returns the full internal WhatsApp Web message object (`msg._data`); it is the only place ad/origin context lives (§6.6.1).
- `Chat.sendStateTyping()`/`sendStateRecording()` last ~25 s; `Chat.clearState()` stops immediately.
- `client.destroy()` closes Chromium WITHOUT logging out (session stays on disk). `client.logout()` unlinks the device and deletes the LocalAuth dir.
- wwebjs objects are class instances with circular refs — **never** `JSON.stringify` them; always map to DTOs (§6.6). `rawData` must be sanitized (drop binary/huge fields, cycle-safe) before leaving the adapter.
- wwebjs/Puppeteer can reject promises asynchronously (`Execution context was destroyed`, `Target closed`, `Protocol error`). These MUST be caught at the adapter boundary and converted to session-level failures (§6.5); a stray unhandled rejection must never crash the process.
- Every wwebjs call can hang (Puppeteer `evaluate`). The adapter wraps each call in a timeout (`WA_CALL_TIMEOUT_MS`).
- WhatsApp Web changes break the library periodically. The WA Web version is controlled by `ClientOptions.webVersion`/`webVersionCache`; expose via env and document the upgrade/rollback runbook.
- Each running session = one Chromium (~200–500 MB RAM). Enforce `MAX_SESSIONS`.

**Socket.IO 4 (Nest)** — implement as a `@WebSocketGateway()` with `IoAdapter`/`@nestjs/platform-socket.io`; attach to the Fastify server (the Nest Socket.IO adapter shares the HTTP server). Authentication in a handshake middleware (`afterInit` → `server.use(...)`).

**Deprecation scanner** `scripts/validate-deprecations.ts` (+ `scripts/lib/deprecations.ts`, §2.6 Appendix A): scans every tracked file and fails on removed/renamed APIs, each entry naming its replacement. `any`, `@ts-ignore`, `console` and `process.env` are enforced by ESLint, not by the scanner. Runs in the `lint-and-types` CI job and in the pre-push hook.

---

### 2.6 Toolchain, Git hooks, CI & Claude Code automation (mirror of `omnichannel-platform`)

Everything here is proven in `omnichannel-platform` and is reproduced on purpose, adapted only where this project differs (single package instead of an Nx monorepo; Fastify instead of Express; Debian runtime image because Chromium; no i18n/tenancy validators). It is installed in Phase 0 and enforced for the life of the project. **The hooks are for laptops; CI runs the same checks itself (`HUSKY=0` in CI).**

#### 2.6.1 How the layers fit
| Layer | When it runs | What it does |
|---|---|---|
| `pre-commit` (Husky) | every `git commit` | refuses to continue if `gitleaks` is missing; `lint-staged` fixes and re-stages staged files (ESLint `--fix --max-warnings=0`, Prettier, `prisma format`, rollback check for new migrations); then `gitleaks` scans the staged diff |
| `commit-msg` (Husky) | every `git commit` | `commitlint`: Conventional Commits, type enum, lowercase subject ≤ 72 chars, advisory scope list |
| `pre-push` (Husky) | every `git push` | `pnpm validate:affected`: lint, type-check, unit tests, format check and all validators; skipped for deletes and for refs that are not the checked-out commit; for docs-only pushes only the docs checks run |
| CI (GitHub Actions) | every PR and push to `main` | the same checks plus integration tests against real Postgres/Redis, a boot smoke test, commit-message and PR-title lint, full-history secret scan, Docker image build + run + Trivy scan |
| Repository ruleset (§2.6.8) | merge to `main` | PR required (squash only, linear history), the four CI checks green and up to date, conversations resolved; no force-push, no deletion, no bypass. Enforced by GitHub only on public repos or with Pro/Team |
| Claude Code hooks | during AI sessions | SessionStart/PostToolUse hooks keep the `code-review-graph` knowledge graph fresh; permission rules keep `.env` files and WhatsApp credentials unreadable (§2.6.9) |

#### 2.6.2 `package.json` scripts and dependency lists
```json
{
  "name": "wwebjs-gateway",
  "version": "0.0.0",
  "private": true,
  "license": "UNLICENSED",
  "packageManager": "pnpm@11.25.0",
  "engines": { "node": ">=24" },
  "scripts": {
    "bootstrap": "bash scripts/bootstrap.sh",
    "dev": "nest start --watch",
    "build": "nest build",
    "start": "node dist/main.js",
    "test": "jest",
    "test:watch": "jest --watch",
    "test:cov": "jest --coverage",
    "test:integration": "jest -c jest.integration.config.cts --runInBand --passWithNoTests",
    "lint": "eslint . --max-warnings=0",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "type-check": "tsc --noEmit -p tsconfig.json",
    "infra:up": "docker compose up -d --wait postgres redis",
    "infra:down": "docker compose down",
    "infra:logs": "docker compose logs -f",
    "db:generate": "prisma generate",
    "db:migrate": "prisma migrate deploy",
    "db:migrate:dev": "prisma migrate dev",
    "docs:gen": "tsx scripts/gen-docs.ts",
    "validate:env": "tsx scripts/validate-env-example.ts",
    "validate:deprecations": "tsx scripts/validate-deprecations.ts",
    "validate:rollbacks": "tsx scripts/check-rollbacks.ts",
    "validate:pins": "tsx scripts/validate-pins.ts",
    "validate:docs": "tsx scripts/gen-docs.ts --check",
    "validate:all": "pnpm lint && pnpm type-check && pnpm format:check && pnpm validate:env && pnpm validate:deprecations && pnpm validate:rollbacks && pnpm validate:pins && pnpm validate:docs && pnpm test",
    "validate:affected": "tsx scripts/validate-affected.ts",
    "prepare": "husky"
  },
  "lint-staged": {
    "*.{ts,tsx}": ["eslint --fix --max-warnings=0", "prettier --write"],
    "*.{js,cjs,mjs,cts,mts,json,md,yml,yaml}": "prettier --write --ignore-unknown",
    "prisma/schema.prisma": "prisma format",
    "prisma/migrations/**/migration.sql": "pnpm validate:rollbacks"
  }
}
```
Pinned `devDependencies` (tooling): `@commitlint/cli` 21.2.2, `@commitlint/config-conventional` 21.2.2, `@eslint/js` 10.0.1, `@nestjs/cli` 12.0.10, `@nestjs/testing` 12.0.2, `@types/jest` 30.0.0, `@types/node` 24.19.2, `@types/supertest` 7.2.1, `eslint` 10.9.1, `eslint-import-resolver-typescript` 4.4.5, `eslint-plugin-import-x` 4.17.1, `husky` 9.1.7, `jest` 30.5.1, `jest-environment-node` 30.5.1, `lint-staged` 17.4.1, `pino-pretty` 13.1.3, `prettier` 3.9.6, `supertest` 7.2.2, `ts-jest` 29.4.12, `tsx` 4.20.5, `typescript` 5.9.3, `typescript-eslint` 8.69.0. Runtime dependency versions are in the §2 table; pin ALL versions exactly (no `^`/`~`). `pnpm-workspace.yaml` holds the build-script allow-list that pnpm 11 requires (`allowBuilds`): `unrs-resolver: true` (needed by the TypeScript import resolver); `prisma`, `@prisma/engines`, `@nestjs/core`, `esbuild`, `@swc/core`, `puppeteer`: `false` (Chromium comes from the system, `PUPPETEER_SKIP_DOWNLOAD=true`). Verify the exact pnpm 11 syntax with Context7 before writing it; keep the list minimal.

#### 2.6.3 Config files
`.nvmrc`: `24.20.0`

`.prettierrc`:
```json
{ "semi": false, "singleQuote": true, "trailingComma": "none", "printWidth": 100, "tabWidth": 2, "arrowParens": "avoid" }
```
`.prettierignore`:
```
# Specifications and assistant instructions are maintained by hand (wide tables) or generated
docs/
CLAUDE.md
.claude/
.mcp.json

# Generated code and build output
dist/
coverage/
generated/

# Dependencies, lockfile and credentials of WhatsApp sessions
node_modules/
pnpm-lock.yaml
.wwebjs_auth/
.wwebjs_cache/
```
`.gitignore`:
```
# Environment and secrets (never commit; only .env.example files are allowed)
.env
.env.local
.env.*.local
secrets/
!.env.example

# WhatsApp session data = account credentials. NEVER commit.
.wwebjs_auth/
.wwebjs_cache/

# Claude Code: per-machine files
.claude/settings.local.json
.claude/scheduled_tasks.lock

# code-review-graph: generated database
.code-review-graph/

# Dependencies and build output
node_modules/
dist/
coverage/
*.tsbuildinfo
*.log
.DS_Store

# Prisma Client, generated by `pnpm db:generate`
src/generated/
```
`.vscode/settings.json`: `{ "js/ts.tsdk.path": "node_modules/typescript/lib" }`

`tsconfig.json` (type-check everything: src, tests, scripts, configs): `extends` nothing; options `target es2022`, `lib ["es2023"]`, `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `forceConsistentCasingInFileNames`, `experimentalDecorators`, `emitDecoratorMetadata`, `esModuleInterop`, `skipLibCheck`, `declaration`, `sourceMap`, `isolatedModules`, `resolveJsonModule`, `noEmit: true`, `types ["node","jest"]`, `include ["src","tests","scripts","jest.config.cts","jest.integration.config.cts","prisma.config.ts"]`; `module`/`moduleResolution` per the Context7 decision of §2 notes. `tsconfig.build.json` extends it with `noEmit: false`, `outDir: dist`, `include ["src"]`, `exclude ["tests","**/*.spec.ts"]` and `types ["node"]` (test globals must not type-check in shipped code). `tsconfig.spec.json` extends it with `module: commonjs`, `moduleResolution: node10`, `verbatimModuleSyntax: false`, `types ["jest","node"]`.

`jest.config.cts`:
```ts
module.exports = {
  testEnvironment: 'node',
  transform: { '^.+\\.[tj]sx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }] },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  // Sources import siblings with the ESM `.js` suffix; Jest resolves the `.ts` file behind it
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  // Globs instead of `roots`: a directory that does not exist yet (tests/) is simply empty, so a spec
  // placed there later is found without touching this file
  testMatch: [
    '<rootDir>/src/**/*.spec.ts',
    '<rootDir>/tests/**/*.spec.ts',
    '<rootDir>/scripts/**/*.spec.ts'
  ],
  // Needs Postgres/Redis (integration job) or a real WhatsApp account (opt-in)
  testPathIgnorePatterns: [
    '/node_modules/',
    '\\.integration\\.spec\\.ts$',
    '\\.e2e-real\\.spec\\.ts$'
  ],
  coverageDirectory: 'coverage',
  // Count every source file, not only the ones a test happens to load: a file nobody tests must
  // lower the number, or a threshold means nothing
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!**/*.spec.{ts,tsx}',
    '!**/*.d.ts',
    '!**/index.ts',
    '!src/generated/**',
    '!src/main.ts', // bootstrap: exercised by the boot smoke test in CI
    '!src/whatsapp/wwebjs-adapter.ts' // needs a real WhatsApp account: covered by the opt-in E2E_REAL suite
  ],
  coverageThreshold: { global: { lines: 80, functions: 80, statements: 80, branches: 75 } }
}
```
**Jest on an ESM-only Nest 12 (decided in step 0.6):** the specs compile to CommonJS (`tsconfig.spec.json`), but `@nestjs/*` 12 is ESM-only, so Jest must `require()` ESM natively: Node runs it with `--experimental-vm-modules`, set once for every pnpm script by `nodeOptions` in `pnpm-workspace.yaml` (plus `--disable-warning=ExperimentalWarning`). `moduleNameMapper` strips the `.js` suffix of relative imports so Jest finds the `.ts` file. `testMatch` globs cover `src/`, `tests/` and `scripts/` instead of `roots` (Jest refuses a root that does not exist, a glob over a missing directory is just empty). `.cts` files are plain CommonJS that Node loads as is: no `export =`, no type information in ESLint.

`jest.integration.config.cts` spreads the unit config and restates only the difference: `testMatch` for `*.integration.spec.ts` (it cannot use `testRegex` next to the inherited `testMatch`), `maxWorkers: 1`, coverage thresholds for the critical folders (`src/services/send-queue*` 90, `src/whatsapp/event-pipeline*` and `inbound-order-buffer*` 90).

#### 2.6.4 ESLint flat config (`eslint.config.js`) — adapted from `omnichannel-platform`
ESLint 10 supports flat config only. Never create `.eslintrc.*`.
```js
import path from 'node:path'

import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import importX from 'eslint-plugin-import-x'
import tseslint from 'typescript-eslint'

const processEnvBan = {
  selector: "MemberExpression[object.name='process'][property.name='env']",
  message: 'Read configuration through the validated AppConfig (src/config)'
}

// Numbers are not statuses: name them with Nest's HttpStatus
const STATUS_ARGUMENT = 'Literal[raw=/^[1-5][0-9]{2}$/]'
const httpStatusBans = [
  {
    selector: `NewExpression[callee.name=/^(HttpException|AppError)$/] > ${STATUS_ARGUMENT}`,
    message: 'Name the status: HttpStatus.NOT_FOUND, not 404'
  },
  {
    selector: `CallExpression[callee.name='HttpCode'] > ${STATUS_ARGUMENT}`,
    message: 'Name the status: @HttpCode(HttpStatus.CREATED), not 201'
  },
  {
    selector: `CallExpression[callee.property.name=/^(status|code)$/] > ${STATUS_ARGUMENT}`,
    message: 'Name the status: reply.status(HttpStatus.NOT_FOUND), not 404'
  }
]

const deepRelativeImport = {
  group: ['../../../*'],
  message: 'Use a path alias or restructure instead of deep relative imports'
}
// Boundaries of the architecture (SOLID: everything depends on the port / the repositories)
const restrictedPaths = [
  {
    name: 'whatsapp-web.js',
    message: 'Only src/whatsapp/wwebjs-adapter.ts may import whatsapp-web.js'
  },
  {
    name: '@prisma/client',
    message: 'Only src/database/** may use the Prisma client (use a repository)'
  },
  { name: '@nestjs/platform-express', message: 'This project runs on @nestjs/platform-fastify' },
  { name: 'prom-client', message: 'Use @prometheus-io/client' },
  { name: 'redis', message: 'Use ioredis' }
]

// The generator writes the Prisma client into src/generated/prisma, so the code imports it by a
// relative path and never as '@prisma/client': the package name alone would not catch it
const prismaClientImport = {
  group: ['**/generated/prisma', '**/generated/prisma/**'],
  message: 'Only src/database/** may use the Prisma client (use a repository)'
}

// Every block restates the whole option object, so the shared parts live in one place
const restrictImports = exceptName => [
  'error',
  {
    paths: restrictedPaths.filter(p => p.name !== exceptName),
    patterns:
      exceptName === '@prisma/client'
        ? [deepRelativeImport]
        : [deepRelativeImport, prismaClientImport]
  }
]

export default defineConfig([
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,

  {
    files: ['**/*.ts', '**/*.cts', '**/*.mts'],
    settings: {
      'import-x/resolver': {
        typescript: { project: path.join(import.meta.dirname, 'tsconfig.json') }
      }
    },
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_'
        }
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': 'allow-with-description', 'ts-ignore': true }
      ],

      'no-console': 'error',
      'no-restricted-imports': restrictImports(),
      'no-restricted-syntax': ['error', processEnvBan, ...httpStatusBans],

      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc' }
        }
      ]
    }
  },

  // The adapter is the only file that may import the library
  {
    files: ['src/whatsapp/wwebjs-adapter.ts'],
    rules: {
      'no-restricted-imports': restrictImports('whatsapp-web.js')
    }
  },
  // The database layer is the only code that may use the Prisma client
  {
    files: ['src/database/**/*.ts', 'prisma.config.ts', 'scripts/**/*.ts', 'tests/**/*.ts'],
    rules: {
      'no-restricted-imports': restrictImports('@prisma/client')
    }
  },
  // The single files allowed to read process.env
  {
    files: [
      'src/config/**/*.ts',
      'prisma.config.ts',
      'scripts/**/*.ts',
      'tests/helpers/env.ts',
      'jest*.cts'
    ],
    rules: { 'no-restricted-syntax': ['error', ...httpStatusBans] }
  },
  // Scripts print; everything else uses Pino
  { files: ['scripts/**/*.ts'], rules: { 'no-console': 'off' } },
  // Specs say the status number on purpose: they pin what the code answers
  {
    files: ['**/*.spec.ts', 'tests/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', processEnvBan] }
  },
  // The env helper of the tests sets process.env, and specs state statuses on purpose: no bans at all
  // (it must come after the block above, which would otherwise ban process.env again)
  { files: ['tests/helpers/env.ts'], rules: { 'no-restricted-syntax': 'off' } },
  // Plain JavaScript files (eslint.config.js itself) are outside tsconfig: no type information
  // The documented default-import style of the config packages trips two import-x heuristics
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: { 'import-x/no-named-as-default': 'off', 'import-x/no-named-as-default-member': 'off' }
  },
  // Plain CommonJS configs (every .cts file is a tool config that Node loads as is): no type information
  {
    files: ['**/*.cjs', '**/*.cts'],
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      sourceType: 'commonjs'
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  { ignores: ['**/dist/**', '**/generated/**', '**/coverage/**', 'docs/**'] }
])
```
**Nest decorator metadata:** `omnichannel-platform` runs this exact `consistent-type-imports` rule on Nest 12 with `experimentalDecorators` + `emitDecoratorMetadata` enabled in `tsconfig.json`; with both flags on, typescript-eslint does not turn constructor-injected classes into `import type`. Keep both flags in the tsconfig that ESLint's `projectService` resolves. If a fix ever breaks injection (a provider resolving to `undefined`), turn the rule off only for the decorated file kinds (`*.controller.ts`, `*.service.ts`, `*.module.ts`, `*.gateway.ts`, `*.processor.ts`) and say why in a comment. A Jest test that boots the root module (`Test.createTestingModule({ imports: [AppModule] })`) must exist so a broken injection fails CI instead of production.
Rules that are errors, not warnings, and why: `no-console` (use Pino); `no-restricted-syntax` on `process.env` (config only through `AppConfig`); `import-x/order` (stable diffs); `--max-warnings=0` (a warning is a failure).

#### 2.6.5 Git hooks (Husky 9) — `pnpm install` runs `husky` (the `prepare` script)
`commitlint.config.js` (ESM; the scopes are advice = warning, types and subject length are enforced):
```js
export default {
  extends: ['@commitlint/config-conventional'],
  // Dependabot writes its own titles and body lines, which can exceed the length rules
  ignores: [message => message.includes('Signed-off-by: dependabot[bot]')],
  rules: {
    'type-enum': [2, 'always', ['feat', 'fix', 'docs', 'style', 'refactor', 'test', 'chore', 'perf', 'ci', 'revert', 'build']],
    'scope-enum': [1, 'always', [
      'api', 'sessions', 'messages', 'chats', 'contacts', 'groups', 'channels', 'labels', 'calls',
      'webhooks', 'inbound', 'realtime', 'queue', 'ordering', 'origin', 'whatsapp', 'watchdog',
      'auth', 'config', 'db', 'database', 'infra', 'metrics', 'logger', 'parity', 'docs',
      'e2e', 'docker', 'ci', 'tooling', 'deps'
    ]],
    'subject-max-length': [2, 'always', 72],
    'body-max-line-length': [1, 'always', 100]
  }
}
```
`.husky/pre-commit`:
```sh
# Blocks committed secrets. gitleaks is a local binary, not an npm package. Checked first, so that
# a commit that cannot be checked is refused before anything is rewritten.
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks is not installed, and the commit cannot be checked for secrets without it."
  echo "Install it with: brew install gitleaks   (other systems: https://github.com/gitleaks/gitleaks)"
  exit 1
fi

# Fixes and re-stages what it can (ESLint, Prettier, prisma format), and runs the validators of the
# files that are staged
pnpm exec lint-staged

gitleaks git --pre-commit --staged --no-banner --redact
```
`.husky/commit-msg`: `pnpm exec commitlint --edit "$1"`

`.husky/pre-push`:
```sh
# What CI would fail on (lint, type-check, unit tests, format, validators), except the builds and the
# suites that need Docker or a database: seconds to a minute and a half. A push that only touches
# docs/ only runs the documentation checks.
#
# The repository is public, so a secret that leaves this machine in a pushed commit is already
# published. Before anything else, every ref that is pushed gets its new commits scanned by
# gitleaks, checked out or not (CI scans the history too, but only after the push).
#
# Git writes one line per pushed ref on stdin: <local ref> <local sha> <remote ref> <remote sha>.
# The remote sha is all zeros for a branch that is not on the remote yet.
zero=0000000000000000000000000000000000000000
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks is not installed, and the push cannot be checked for secrets without it."
  echo "Install it with: brew install gitleaks   (other systems: https://github.com/gitleaks/gitleaks)"
  exit 1
fi
# pnpm reads from /dev/null so that it cannot consume the lines of the refs that follow. It checks
# the checked-out commit, so deleting a branch (local sha all zeros) has nothing to check, and
# pushing a ref that is not checked out is left to CI, except for the secret scan.
while read -r local_ref local_sha _remote_ref remote_sha; do
  if [ "$local_sha" = "$zero" ]; then
    continue
  fi

  # A new branch has no remote commit to start from: its whole history is scanned
  if [ "$remote_sha" = "$zero" ]; then
    range="$local_sha"
  else
    range="$remote_sha..$local_sha"
  fi
  gitleaks git --no-banner --redact --log-opts="$range" || exit 1

  if [ "$local_sha" != "$(git rev-parse HEAD)" ]; then
    echo "pre-push: $local_ref is not the checked-out commit, so it is not checked here (CI checks it)"
  elif [ "$remote_sha" = "$zero" ]; then
    pnpm validate:affected </dev/null || exit 1
  else
    pnpm validate:affected -- --since "$remote_sha" </dev/null || exit 1
  fi
done
```
Hook files are committed (`.husky/*`); the generated `.husky/_` folder is ignored by Husky itself. **Rules:** never `--no-verify`; a failing hook is fixed, not bypassed; `pnpm validate:all` runs everything on the whole repo.

#### 2.6.6 Validators (what each one guards)
| Script | Guards | Source |
|---|---|---|
| `validate:deprecations` | removed/renamed APIs of the libraries in §2.5 never come back; each hit prints file:line, the API and its replacement | Appendix A.1 |
| `validate:env` | `.env.example` ⇄ `src/config/env.schema.ts`: every schema key declared, none extra, no duplicates, a commented-out key only if the schema accepts it missing | Appendix A.2 |
| `validate:pins` | every dependency of `package.json` (dependencies, devDependencies, optionalDependencies) is an exact version: no `^`, no `~`, no tag, no range; peer ranges are not checked | `scripts/lib/pins.ts` |
| `validate:rollbacks` | every `prisma/migrations/<name>/` has `prisma/rollbacks/<name>.rollback.sql` and vice versa (kept outside `migrations/` because Prisma treats each subfolder there as a migration) | Appendix A.3 |
| `validate:docs` | generated docs (`events.md`, `parity-matrix.md`, operations list) equal a fresh generation; docs mention every env var and error code (§6.13) | `scripts/gen-docs.ts --check` |
| `validate:affected` | the pre-push composition of all of the above plus lint, type-check, tests | Appendix A.4 |
| `smoke-http` | a running service answers like a load balancer/operator expects (CI boots the built app) | Appendix A.5 |

#### 2.6.7 CI (`.github/workflows/ci.yml`)
Action versions are pinned by commit SHA (comment = version). Jobs are the four required checks.
```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

# A new push cancels the superseded pull-request run; main runs must finish
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

permissions:
  contents: read

env:
  NODE_ENV: test
  # The Git hooks are for laptops: CI runs the same checks itself, as jobs
  HUSKY: '0'

jobs:
  lint-and-types:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile --prefer-offline
      - run: pnpm db:generate
      - run: pnpm format:check
      # The commits of the pull request and its title (it becomes the squash commit on main)
      - name: Commit messages follow Conventional Commits
        if: github.event_name == 'pull_request'
        env:
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
        run: pnpm exec commitlint --from "$BASE_SHA" --to "$HEAD_SHA"
      # Dependabot titles can pass 72 characters
      - name: Pull request title follows Conventional Commits
        if: github.event_name == 'pull_request' && github.actor != 'dependabot[bot]'
        env:
          PR_TITLE: ${{ github.event.pull_request.title }}
        run: printf '%s\n' "$PR_TITLE" | pnpm exec commitlint
      - run: pnpm validate:deprecations
      - run: pnpm validate:env
      - run: pnpm validate:rollbacks
      - run: pnpm validate:pins
      - run: pnpm validate:docs
      - run: pnpm lint
      - run: pnpm type-check
      # build too: a project that type-checks can still fail to compile
      - run: pnpm build

  # Unit tests with coverage gates (jest.config.cts thresholds; `--coverage` makes jest enforce them).
  # Includes tests/parity (reads node_modules/whatsapp-web.js/index.d.ts) and the docs drift tests.
  unit-tests:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile --prefer-offline
      - run: pnpm db:generate
      - run: pnpm test:cov

  # The suites that need a real database and Redis, plus a boot of the built service
  integration-tests:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    services:
      postgres:
        image: postgres:18.6-alpine
        env:
          POSTGRES_USER: gateway
          POSTGRES_PASSWORD: ci_password
          POSTGRES_DB: gateway_ci
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U gateway -d gateway_ci"
          --health-interval 5s --health-timeout 3s --health-retries 10
      redis:
        image: redis:8.10.1-alpine
        ports: ['6379:6379']
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s --health-timeout 3s --health-retries 10
    env:
      DATABASE_URL: postgresql://gateway:ci_password@localhost:5432/gateway_ci
      REDIS_URL: redis://localhost:6379
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile --prefer-offline
      - run: pnpm db:generate
      - name: Migrate an empty database
        run: pnpm db:migrate
      - name: Integration suites
        run: pnpm test:integration
      - name: The built service starts and answers
        run: |
          pnpm build
          # The rest of the env is the one of .env.example
          set -a; . ./.env.example; set +a
          export NODE_ENV=test
          touch api.log
          trap 'kill $(jobs -p) 2>/dev/null || true' EXIT
          PORT=8081 node dist/main.js > api.log 2>&1 &
          pnpm exec tsx scripts/smoke-http.ts http://localhost:8081
      - name: Service log
        if: failure()
        run: tail -n 60 api.log
      # Last, because it empties the database: every rollback must run cleanly, newest first
      - name: Rollbacks run
        run: |
          for file in $(ls prisma/rollbacks/*.rollback.sql 2>/dev/null | sort -r); do
            psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$file"
          done

  # Builds the image and scans it. A critical or high vulnerability that has a fix fails the job.
  security-scan:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    services:
      postgres:
        image: postgres:18.6-alpine
        env:
          POSTGRES_USER: gateway
          POSTGRES_PASSWORD: ci_password
          POSTGRES_DB: gateway_ci
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U gateway -d gateway_ci"
          --health-interval 5s --health-timeout 3s --health-retries 10
      redis:
        image: redis:8.10.1-alpine
        ports: ['6379:6379']
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s --health-timeout 3s --health-retries 10
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0 # gitleaks reads the whole history
      # A secret that was ever committed stays in the history, so the whole history is scanned
      - name: Scan the history for secrets
        env:
          GITLEAKS_VERSION: 8.28.0
          GITLEAKS_SHA256: a65b5253807a68ac0cafa4414031fd740aeb55f54fb7e55f386acb52e6a840eb
        run: |
          curl --fail --silent --show-error --location --output gitleaks.tar.gz \
            "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
          echo "${GITLEAKS_SHA256}  gitleaks.tar.gz" | sha256sum --check
          tar -xzf gitleaks.tar.gz gitleaks
          ./gitleaks git --no-banner --redact --verbose
      - uses: docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069 # v4.4.1
      - name: Build the image
        uses: docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0
        with:
          context: .
          file: Dockerfile
          tags: wwebjs-gateway:ci
          load: true
          push: false
          cache-from: type=gha
          cache-to: type=gha,mode=max
      # The scan reads the OS and the base image; run the image too, in the mode it has where deployed
      - name: The image starts and answers
        run: |
          docker run -d --name service --network host --env-file .env.example \
            -e NODE_ENV=production -e PORT=8080 \
            -e DATABASE_URL=postgresql://gateway:ci_password@localhost:5432/gateway_ci \
            -e REDIS_URL=redis://localhost:6379 \
            -e ADMIN_API_KEY="$(openssl rand -hex 24)" \
            wwebjs-gateway:ci
          curl --fail --silent --show-error --retry 20 --retry-delay 1 --retry-connrefused \
            http://localhost:8080/ready
      - name: Service log
        if: failure()
        run: docker logs service
      - name: Scan the image
        uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0
        with:
          image-ref: wwebjs-gateway:ci
          severity: CRITICAL,HIGH
          ignore-unfixed: true
          exit-code: '1'
```
(The image runs migrations in `docker-entrypoint.sh`, so the `security-scan` run must provide `DATABASE_URL` as above. The YAML shows the final form; until step 4.7 the boot and image checks curl `/health` instead of `/ready`, and `smoke-http` only checks `/health`. `.env.example` must hold values that pass the schema, because the `integration-tests` job sources it. The deploy/publish job — GHCR push and optional deploy — is added in Phase 11, on `main` only, after these four.)

**Implementation notes (step 0.9):** the workflow is the committed `.github/workflows/ci.yml`, checked with `actionlint`; its six action SHAs were checked against their release tags and the gitleaks checksum against the release. It differs from the draft above in four ways. (1) Until step 1.1 makes the port configurable the gateway listens on 3000, so the boot and image checks use `http://localhost:3000` and `/health` (the draft's 8081 and 8080 return in 1.1, when the port becomes configurable; `/ready` returns in 4.7). (2) The rollbacks loop uses a Bash glob with `nullglob`, newest first, instead of `ls | sort -r` (it survives names with spaces and an empty folder). (3) `prisma.config.ts` loads `.env.local` when it exists, because the Prisma CLI does not read `.env` files; that file is what `pnpm bootstrap` creates, and CI and the image use the environment instead. (4) The image keeps only production dependencies and removes the `npm` that ships with the base image, which bundles its own `tar`, `undici`, `ip-address` and `brace-expansion`; with them, Trivy fails the job on high advisories that have a fix. The base image also runs `apt-get upgrade`, and `openssl` is installed in the build stage too, because the Prisma schema engine is downloaded for the OpenSSL it finds. Verified locally with a real `docker compose up`, a real `pnpm bootstrap` and `trivy image --severity CRITICAL,HIGH --ignore-unfixed` (exit 0). The published ports of the compose file are `API_PORT`, `POSTGRES_PORT` and `REDIS_PORT` (defaults 3000, 5432, 6379), so the stack can start next to others. They are published on `127.0.0.1` only, because the stack runs with the placeholder credentials of `.env.example`.

**Review of the whole pull request (end of Phase 0).** Three independent reviewers, one per batch, read it before it was opened; what they found and was confirmed by running it: (1) the `@prisma/client` import ban never fired, because the generator writes the client to `src/generated/prisma` and the code imports it by a relative path, so `restrictImports` now also bans `**/generated/prisma` outside `src/database`, and `tests/parity/lint-boundaries.spec.ts` reads the effective rules to keep it that way; (2) `.dockerignore` patterns without `**/` only match in the root of the context, so a `.env`, a `.wwebjs_auth` or a `*.pem` inside `src/` would have been copied into the image (checked with a throwaway build); (3) the `pre-push` hook scans the commits that are pushed with gitleaks, for every ref and before anything else, because the repository is public and CI scans only after the push (the range logic was checked in a scratch repository); (4) the four checkouts use `persist-credentials: false`, and the boot check runs `node --env-file=.env.example`, which parses the file instead of sourcing it and never overrides a variable the job already sets; (5) `bootstrap` writes random `ADMIN_API_KEY` and `METRICS_TOKEN` to `.env.local`; (6) the required checks of the ruleset carry the id of the GitHub Actions app, 15368; (7) the runtime stage sets `CHECKPOINT_DISABLE=1`, which the installed CLI reads (found in its code); (8) `validate-affected` only accepts a commit hash after `--since`, and `smoke-http` follows no redirect and prints only the keys of an unexpected body. A reviewer also said the schema engine is not fetched by `prisma --version`; it is, there are zero engine files before it and one after.


#### 2.6.8 Dependabot, PR template, repository ruleset
`.github/dependabot.yml` (the TDD pins every version, so routine bumps are done on purpose, one area per PR after reading the changelog; security alerts are unaffected by `ignore`):
```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule: { interval: weekly }
    open-pull-requests-limit: 5
    commit-message: { prefix: chore(deps) }
    ignore:
      - dependency-name: '*'
        update-types: ['version-update:semver-minor', 'version-update:semver-patch']
      # TypeScript stays on 5.9 until typescript-eslint, ts-jest and Nest certify the next major
      - dependency-name: typescript
        update-types: ['version-update:semver-major']
      # The runtime is Node 24, so the types follow the Node major
      - dependency-name: '@types/node'
        update-types: ['version-update:semver-major']
      # Upgrading the WhatsApp library is a deliberate act with its own runbook (docs/upgrading.md)
      - dependency-name: whatsapp-web.js

  - package-ecosystem: github-actions
    directory: /
    schedule: { interval: weekly }
    open-pull-requests-limit: 5
    commit-message: { prefix: ci(deps) }
    groups:
      actions-minor-and-patch: { update-types: [minor, patch] }

  - package-ecosystem: docker
    directory: /
    schedule: { interval: weekly }
    commit-message: { prefix: chore(deps) }
    ignore:
      - dependency-name: '*'
        update-types: ['version-update:semver-minor', 'version-update:semver-patch']

  - package-ecosystem: docker-compose
    directory: /
    schedule: { interval: weekly }
    commit-message: { prefix: chore(deps) }
    ignore:
      - dependency-name: '*'
        update-types: ['version-update:semver-minor', 'version-update:semver-patch']
```
`.github/pull_request_template.md`:
```markdown
## Summary
<!-- What changes and why -->

## TDD reference
<!-- Which TDD section does this implement? e.g. §6.4 -->

## Checklist
- [ ] The title is a Conventional Commit, lowercase, 72 characters or fewer (it becomes the squash commit)
- [ ] Only `wwebjs-adapter.ts` imports whatsapp-web.js; only `src/database/**` uses Prisma
- [ ] New/changed capability is ONE `@WaOperation` with summary, description, examples, errors, `scope` and `wwebjs` links
- [ ] New env vars are in `env.schema.ts`, `.env.example` AND the docs
- [ ] Parity matrix / generated docs regenerated (`pnpm docs:gen`) and committed
- [ ] Tests added or updated (unit; integration if it touches Postgres/Redis); coverage gates pass
- [ ] Migration includes a rollback script in `prisma/rollbacks/`
- [ ] Sends stay idempotent; events keep `seq` order; nothing blocks the event pipeline
- [ ] No secrets, QR codes or WhatsApp session data in code, logs or fixtures
- [ ] The step's checkbox and progress row in `docs/IMPLEMENTATION_PLAN.md` are updated

## Migration notes
<!-- Deployment steps, breaking changes, or "none" -->
```
**Protection of `main` = a GitHub repository ruleset** (the modern replacement of classic branch protection), committed as `deploy/github-ruleset.json` and applied by the OWNER once the four CI checks have run at least once (a required check that has never reported cannot be selected):
```json
{
  "name": "protect-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "lint-and-types", "integration_id": 15368 },
          { "context": "unit-tests", "integration_id": 15368 },
          { "context": "integration-tests", "integration_id": 15368 },
          { "context": "security-scan", "integration_id": 15368 }
        ]
      }
    }
  ]
}
```
Every required check carries `"integration_id": 15368`, the id of the GitHub Actions app (`gh api /apps/github-actions --jq .id`), so a check of the same name reported by another app does not satisfy the rule. Apply with `gh api -X POST repos/<owner>/<repo>/rulesets --input deploy/github-ruleset.json` (verify the payload schema against the current GitHub REST docs for repository rulesets at apply time). Notes: (1) **0 required approvals on purpose** — this is a solo-owner repo and GitHub does not let an author approve their own PR; the PR itself, the four green checks, resolved conversations, squash-only and linear history are the gate (raise it to 1 when a second person joins). (2) `bypass_actors` is empty, so not even the admin pushes straight to `main`. (3) **Decision (2026-10-27): the repository is PUBLIC — `eosmin/wwebjs-gateway`** (the name was checked and is free). Rulesets and branch protection are enforced by GitHub only on public repositories or with Pro/Team (on a free private repo the API answers `403 Upgrade to GitHub Pro or make this repository public`, which is the case of `omnichannel-platform` today), so being public makes `protect-main` real at no cost. Record this in the README "Repository settings" section and in `docs/repository-settings.md`, together with the public-repository rules of §10 and the settings the owner enables once: Dependabot alerts and security updates, secret scanning with push protection, private vulnerability reporting, "automatically delete head branches", squash-only merges. Trunk-based: short-lived `feat/*`, `fix/*`, `chore/*` branches; squash-merge by the owner; the PR title follows Conventional Commits because it becomes the squash commit.

#### 2.6.9 Claude Code automation (the hooks that fire during AI sessions)
`.claude/settings.json` (committed; per-machine overrides go in the git-ignored `.claude/settings.local.json`):
```json
{
  "permissions": {
    "deny": [
      "Read(**/.env)",
      "Read(**/.env.*)",
      "Read(!**/.env.example)",
      "Read(**/.wwebjs_auth/**)",
      "Read(**/.wwebjs_cache/**)",
      "Edit(docs/events.md)",
      "Edit(docs/parity-matrix.md)",
      "Edit(docs/operations-list.md)",
      "Edit(docs/websocket-commands.md)",
      "Edit(docs/openapi.json)",
      "Edit(docs/metrics.md)",
      "Edit(docs/errors.md)",
      "Edit(docs/config-reference.md)"
    ]
  },
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|Bash",
        "hooks": [
          {
            "type": "command",
            "command": "command -v code-review-graph >/dev/null 2>&1 || exit 0; code-review-graph update --skip-flows",
            "timeout": 30
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "command -v code-review-graph >/dev/null 2>&1 || exit 0; code-review-graph status",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```
- **PostToolUse** (after every Edit/Write/Bash) incrementally updates the `code-review-graph` knowledge graph; **SessionStart** prints its status. The first two lines of `permissions.deny` keep secrets out of the model's context; the `.wwebjs_*` lines protect account credentials; the generated docs can only change through `pnpm docs:gen`. Only `Edit(...)` rules are listed for them: in Claude Code an `Edit(path)` rule governs every tool that writes files, `Write` included, and a `Write(path)` rule is never matched. The `Read(!**/.env.example)` negation is honored because it comes after the rules it carves out of. These rules govern Claude's file tools only: a `Bash` command such as `cat .env` is not matched by a `Read` rule, so they are a guard against accidents, not a sandbox. Both hooks start with `command -v code-review-graph >/dev/null 2>&1 || exit 0`, so a machine without the tool gets no hook error on every call.
- `.mcp.json` (committed): `{ "mcpServers": { "code-review-graph": { "command": "uvx", "args": ["code-review-graph==2.3.2", "serve"], "type": "stdio" } } }`. The version is pinned like every other tool of the project: an unpinned `uvx` would run whatever is newest on PyPI, with the owner's privileges, on a machine that holds WhatsApp credentials. Bump it on purpose.
- `.claude/skills/` (`explore-codebase.md`, `review-changes.md`, `debug-issue.md`, `refactor-safely.md`) come from running `code-review-graph install` in the repo (they are the same four skills `omnichannel-platform` has); then build the graph once with `code-review-graph build` (or the command its `status` suggests). Prerequisites on the machine: `uv`/`uvx` and `code-review-graph` (already installed on the owner's machine), `gitleaks`, `gh`, `pnpm` (corepack).
- **Reviewer subagent** `.claude/agents/code-reviewer.md` (committed, read-only): independent "fresh eyes" review of ONE batch of at most 10 files through ONE lens. It never edits files and never writes to git. It is invoked only when the owner asks for a review (the agent offers one at the end of a step; see the procedure in the project `CLAUDE.md`). File content:
```markdown
---
name: code-reviewer
description: Read-only reviewer for wwebjs-gateway. Reviews ONE batch of at most 10 files through ONE lens (correctness, security, tests, or config-ci-docker) and reports findings, one line each. Never edits files, never writes to git.
tools: Read, Grep, Glob, Bash
---

You review code of the wwebjs-gateway repository. You receive: a step number, a list of at most 10 files, ONE lens, and the TDD sections that apply. Read every listed file IN FULL (and the files it imports when needed to judge it). Do not review files you were not given, except to confirm a call chain.

Lenses: correctness (logic, races, error paths, boundary values, resource cleanup), security (secrets, permissions, SSRF, injection, credential and personal-data exposure, public-repository hygiene), tests (missing cases, tests that cannot fail, mocks hiding behavior, coverage of failure paths), config-ci-docker (env schema vs .env.example, CI jobs, Dockerfile, hooks, scripts, docs drift).

Project invariants to check on every pass (a violation is at least HIGH):

1. Only src/whatsapp/wwebjs-adapter.ts imports whatsapp-web.js; only src/database/** uses the Prisma client; no process.env outside src/config; no console, any, @ts-ignore.
2. Every wwebjs call goes through the adapter's timeout and error translation; no floating promise; a Puppeteer rejection is attributed to a session, never crashes the process.
3. Event pipeline order is dedupe, store, order buffer, seq, publish; seq is assigned AFTER ordering; held messages stay crash-safe (emittedAt).
4. Sends are idempotent; an unknown outcome is never blindly retried; the send policy is evaluated; humanize state is cleared in finally; policy pacing delays instead of failing.
5. Secrets, QR codes, API keys, webhook secrets and message bodies are never logged or committed; fixtures are redacted (the repository is PUBLIC).
6. Every @WaOperation has summary, description, examples, errors, scope and wwebjs links (or gateway: true); documentation ships with the behavior.
7. Webhooks: SSRF guard on every attempt, HMAC signature, at-least-once with seq.

Rules: use Bash only for read-only commands (git diff, git log, git show, git status, pnpm lint, pnpm type-check, pnpm test, tsx scripts/validate-*.ts). NEVER run git add, commit, push, checkout, reset, gh write commands, or modify any file. Report only problems you can point to in the code; if you are unsure, say so and mark it UNVERIFIED.

Output, one finding per line, most severe first: `path:line: SEVERITY: problem. Suggested fix.` where SEVERITY is BLOCKER, HIGH, MEDIUM or LOW. No praise, no formatting nits unless they change behavior. End with three lines: `Files read in full: ...`, `Files only skimmed or not read: ...`, `Not covered by this lens: ...`.
```
- Project `CLAUDE.md` documents the hooks and the rules "never run `git commit`/`git push`/`gh pr create` unless the owner explicitly asks", "never work on `main`", "never `--no-verify`"; it also carries the "How to work", "Definition of done for any step" and "Code review of a step" procedures (the `/code-review` 10-findings-cap method) and the "MCP Tools: code-review-graph" section (query the graph BEFORE Grep/Glob/Read), all copied from `omnichannel-platform`'s `CLAUDE.md`.

#### 2.6.10 Local bootstrap (`scripts/bootstrap.sh`)
```bash
#!/usr/bin/env bash
set -euo pipefail

echo "→ Checking prerequisites"
command -v node   >/dev/null || { echo "Node.js 24 required"; exit 1; }
command -v docker >/dev/null || { echo "Docker required"; exit 1; }
corepack enable >/dev/null 2>&1 || true          # pnpm version comes from package.json "packageManager"
command -v gitleaks >/dev/null || { echo "gitleaks required by the pre-commit hook: brew install gitleaks (other systems: https://github.com/gitleaks/gitleaks)"; exit 1; }
command -v openssl >/dev/null || { echo "openssl required: it generates the local secrets"; exit 1; }
command -v pnpm   >/dev/null || { echo "pnpm required: run 'corepack enable' (it may need elevated permissions)"; exit 1; }
node_major=$(node -v | sed 's/v\([0-9]*\).*/\1/')
[ "$node_major" -ge 24 ] || { echo "Node.js 24+ required, found $(node -v)"; exit 1; }

echo "→ Installing dependencies (also installs the Git hooks)"
pnpm install --frozen-lockfile

echo "→ Creating the local environment file"
if [ ! -f .env.local ]; then
  # The secrets of the example are public placeholders: the local file gets its own random ones
  admin_api_key=$(openssl rand -hex 24)
  metrics_token=$(openssl rand -hex 24)
  sed -e "s|^ADMIN_API_KEY=.*|ADMIN_API_KEY=${admin_api_key}|" \
      -e "s|^METRICS_TOKEN=.*|METRICS_TOKEN=${metrics_token}|" \
      .env.example > .env.local
fi

echo "→ Starting infrastructure (postgres, redis)"
docker compose up -d --wait postgres redis

echo "→ Generating the Prisma client and migrating the database"
pnpm db:generate
pnpm db:migrate

echo "Setup complete. Run: pnpm dev"
```

#### Appendix A — validator sources (reproduce exactly, adapting only what is marked)
**A.1 `scripts/lib/deprecations.ts`** (the comment-stripper is deliberate: a comment may name the old API to explain why it is not used):
```ts
export interface DeprecatedApi {
  name: string
  pattern: RegExp
  replacement: string
}

export const DEPRECATED_APIS: readonly DeprecatedApi[] = [
  { name: 'prisma.$use(', pattern: /\.\$use\(/, replacement: '$extends (Prisma 7)' },
  {
    name: 'prisma-client-js',
    pattern: /prisma-client-js/,
    replacement: 'the generator "prisma-client"'
  },
  {
    name: 'datasourceUrl / datasources',
    pattern: /\bdatasourceUrl\s*:|\bdatasources\s*:\s*\{/,
    replacement: 'a driver adapter (PrismaPg)'
  },
  {
    name: 'prisma db push',
    pattern: /prisma\s+db\s+push/,
    replacement: 'prisma migrate dev / deploy'
  },
  { name: 'z.nativeEnum(', pattern: /\bz\.nativeEnum\(/, replacement: 'z.enum(Enum)' },
  {
    name: 'z.string().url() / .email() / .uuid()',
    pattern:
      /\bz\.string\(\)(\s*\.\w+\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))*\s*\.(url|email|uuid)\(/,
    replacement: 'z.url() / z.email() / z.uuid()'
  },
  { name: 'z.coerce.boolean(', pattern: /\bz\.coerce\.boolean\(/, replacement: 'z.stringbool()' },
  {
    name: 'z.object(...).strict() / .passthrough()',
    pattern: /\}\)\s*\.(strict|passthrough)\(/,
    replacement: 'z.strictObject() / z.looseObject()'
  },
  {
    name: "from 'zod/v3'",
    pattern: /['"]zod\/v3['"]/,
    replacement: "import { z } from 'zod' (Zod 4)"
  },
  {
    name: "from 'redis'",
    pattern: /(\bfrom\s+|\brequire\(\s*|\bimport\(\s*|\bimport\s+)['"]redis(\/[^'"]*)?['"]/,
    replacement: 'ioredis'
  },
  { name: 'prom-client', pattern: /prom-client/, replacement: '@prometheus-io/client' },
  {
    name: 'QueueScheduler',
    pattern: /\bQueueScheduler\b/,
    replacement: 'queue.upsertJobScheduler (BullMQ)'
  },
  {
    name: '@nestjs/platform-express',
    pattern: /@nestjs\/platform-express/,
    replacement: '@nestjs/platform-fastify'
  },
  {
    name: 'new Buttons( / new List(',
    pattern: /\bnew\s+(Buttons|List)\(/,
    replacement: 'polls; Buttons/List are unsupported (parity matrix)'
  },
  {
    name: "'incoming_call' / 'code_received' events",
    pattern: /['"](incoming_call|code_received)['"]/,
    replacement: "the real wwebjs events 'call' / 'code'"
  }
]

// Files that are not application code, or that are the list itself. The ESLint config names the
// banned packages on purpose, to forbid them, and so does the test that guards those bans: they
// are the list's twins.
const NOT_SCANNED =
  /(^|\/)(node_modules|dist|coverage|generated)\/|^(docs|prisma\/migrations|prisma\/rollbacks)\/|(^|\/)(pnpm-lock\.yaml|eslint\.config\.js|tests\/parity\/lint-boundaries\.spec\.ts|scripts\/lib\/deprecations(\.spec)?\.ts)$/
const SCANNED_EXTENSIONS = /\.(ts|tsx|js|jsx|cjs|mjs|cts|mts|prisma)$|(^|\/)package\.json$/

export interface Finding {
  file: string
  line: number
  api: string
  replacement: string
}

export function isScanned(file: string): boolean {
  return !NOT_SCANNED.test(file) && SCANNED_EXTENSIONS.test(file)
}

// The source without its comments. The lines stay where they were, so that a finding has the right
// line. The text of a string is kept (a "//" in it is not a comment). A quote ends at the end of its
// line; a template literal does not.
function withoutComments(source: string): string {
  let out = ''
  let quote: string | undefined
  let comment: 'line' | 'block' | undefined
  for (let i = 0; i < source.length; i++) {
    const char = source.charAt(i)
    const next = source.charAt(i + 1)
    if (char === '\n') {
      if (comment === 'line') comment = undefined
      if (quote !== undefined && quote !== '`') quote = undefined
      out += char
    } else if (comment === 'block') {
      if (char === '*' && next === '/') {
        comment = undefined
        i++
      }
    } else if (comment === 'line') {
      // dropped until the end of the line
    } else if (quote !== undefined) {
      out += char
      if (char === '\\') {
        out += next
        i++
      } else if (char === quote) {
        quote = undefined
      }
    } else if (char === '\\') {
      // An escaped slash, as in /^https?:\/\//, is not the start of a comment
      out += char + next
      i++
    } else if (char === '/' && next === '/') {
      comment = 'line'
    } else if (char === '/' && next === '*') {
      comment = 'block'
      i++
    } else {
      if (char === "'" || char === '"' || char === '`') quote = char
      out += char
    }
  }
  return out
}

export function findDeprecations(file: string, source: string): Finding[] {
  if (!isScanned(file)) return []
  const findings: Finding[] = []
  // Over the whole text, so that a call that Prettier broke over several lines is still seen
  const code = withoutComments(source)
  for (const api of DEPRECATED_APIS) {
    for (const match of code.matchAll(new RegExp(api.pattern.source, 'g'))) {
      const line = code.slice(0, match.index).split('\n').length
      findings.push({ file, line, api: api.name, replacement: api.replacement })
    }
  }
  findings.sort((a, b) => a.line - b.line)
  return findings
}
```
Each entry is covered by a `deprecations.spec.ts` unit test (a hit and a non-hit per entry, plus "comments are ignored" and "multi-line call is seen"). Add an entry here whenever §2.5 gains a removed API.

`scripts/validate-deprecations.ts`:
```ts
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { exit } from 'node:process'

import { findDeprecations, isScanned } from './lib/deprecations.js'

// What git sees, without what .gitignore hides. NUL-separated so that a name with accents is not quoted.
const listed = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  }
)
const files = [...new Set(listed.split('\0'))].filter(
  file => file !== '' && statSync(file, { throwIfNoEntry: false })?.isFile() === true
)
const findings = files.flatMap(file =>
  isScanned(file) ? findDeprecations(file, readFileSync(file, 'utf8')) : []
)

if (findings.length > 0) {
  console.error('Removed or renamed APIs are back in the code:')
  for (const { file, line, api, replacement } of findings) {
    console.error(`  ${file}:${line}  ${api}  ->  ${replacement}`)
  }
  exit(1)
}
console.log(`no deprecated API in ${files.filter(isScanned).length} files`)
```
**A.2 `scripts/validate-env-example.ts`:** imports `envSchema` from `../src/config/env.schema` (a `z.object`); reads `.env.example`; for each line matching `/^(#?)\s?([A-Z][A-Z0-9_]*)=/` records `{ key, commented }`; reports (exit 1): a schema key not declared; a key declared but not in the schema; a key declared twice; a key commented out whose schema does not accept `undefined` (`shape[key].safeParse(undefined).success`). Prints `env examples match their schemas` on success. Tooling-only keys (read by `prisma.config.ts`, e.g. `DATABASE_URL`) must also be in the schema.

**A.3 `scripts/check-rollbacks.ts`:** lists subdirectories of `prisma/migrations` and files `prisma/rollbacks/*.rollback.sql`; fails with `migration <name> has no rollbacks/<name>.rollback.sql` or `rollbacks/<name>.rollback.sql matches no migration`; prints `<n> migrations, each with a rollback`. Rollback scripts are plain SQL run with `psql -v ON_ERROR_STOP=1`, newest first (CI job "Rollbacks run").

**A.4 `scripts/validate-affected.ts` + `scripts/lib/affected.ts`** (single package, so no Nx: "affected" means "is there anything besides docs to check"):
```ts
// A push that only touches docs/ has no code to lint, compile or test, but the generated docs must
// still match their generator, so the docs checks still run.
export function isDocsOnly(changedFiles: readonly string[]): boolean {
  return changedFiles.length > 0 && changedFiles.every(file => file.startsWith('docs/'))
}
```
```ts
// What CI would fail on (pre-push hook). No Docker, no database.
// Usage: tsx scripts/validate-affected.ts [--since <sha>]
//   --since: the commit the remote branch is at, which the pre-push hook passes. What is pushed is
//   then the commits after it, so a documentation commit on top of code that was already checked
//   is not checked again.
import { execFileSync, spawnSync } from 'node:child_process'
import { argv, exit } from 'node:process'

import { isCommitSha, isDocsOnly } from './lib/affected.js'

function git(...args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const hint =
      args[0] === 'merge-base' ? '\nis this a shallow clone? try `git fetch --unshallow`' : ''
    console.error(`git ${args.join(' ')} failed: ${detail}${hint}`)
    exit(1)
  }
}
function exists(ref: string): boolean {
  return spawnSync('git', ['rev-parse', '--verify', '--quiet', ref]).status === 0
}
function isAncestorOfHead(commit: string): boolean {
  return spawnSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD']).status === 0
}
function changedSince(commit: string): string[] {
  return git('diff', '--name-only', '--no-renames', commit, 'HEAD').split('\n').filter(Boolean)
}

const baseRef = ['origin/main', 'main'].find(exists)
if (baseRef === undefined) {
  console.error('neither origin/main nor main exists here: run `git fetch origin main` first')
  exit(1)
}
const base = git('merge-base', baseRef, 'HEAD')
const changed = changedSince(base)
if (changed.length === 0) {
  console.log(`nothing changed since ${baseRef}: nothing to check`)
  exit(0)
}

// A remote commit that this clone does not have, or that is no longer behind HEAD (a rebased
// branch), cannot tell what is pushed: then the whole branch is checked
const sinceIndex = argv.indexOf('--since')
const sinceArgument = sinceIndex === -1 ? undefined : argv[sinceIndex + 1]
if (sinceIndex !== -1 && !isCommitSha(sinceArgument)) {
  console.error('--since needs a commit hash: ignoring it, the whole branch is checked')
}
const since = isCommitSha(sinceArgument) ? sinceArgument : undefined
const pushed = since !== undefined && isAncestorOfHead(since) ? changedSince(since) : changed
if (pushed.length === 0) {
  console.log('nothing new is pushed: nothing to check')
  exit(0)
}

const DOCS_STEPS = [{ name: 'validate:docs', command: ['validate:docs'] }]
const CODE_STEPS = [
  { name: 'lint', command: ['lint'] },
  { name: 'type-check', command: ['type-check'] },
  { name: 'test (unit)', command: ['test'] },
  { name: 'format:check', command: ['format:check'] },
  { name: 'validate:env', command: ['validate:env'] },
  { name: 'validate:deprecations', command: ['validate:deprecations'] },
  { name: 'validate:rollbacks', command: ['validate:rollbacks'] },
  { name: 'validate:pins', command: ['validate:pins'] },
  ...DOCS_STEPS
]
const steps = isDocsOnly(pushed) ? DOCS_STEPS : CODE_STEPS

for (const { name, command } of steps) {
  console.log(`\n> ${name}`)
  const result = spawnSync('pnpm', command, { stdio: 'inherit' })
  if (result.error !== undefined) console.error(`could not run pnpm: ${result.error.message}`)
  if (result.status !== 0) {
    console.error(`\n${name} failed: fix it before pushing (CI would fail on it too)`)
    exit(result.status ?? 1)
  }
}
console.log('\nall checks passed')
```
**A.5 `scripts/smoke-http.ts <baseUrl>`:** waits up to 30 s for `GET /health` 200 (5 s per request); then expects `GET /health` 200, `GET /ready` 200, `GET /metrics` 200 with header `Authorization: Bearer <METRICS_TOKEN>` (token read from env; the response must contain `# TYPE gw_sessions `), `GET /metrics` without credentials 401, and an unknown route `GET /v1/unknown` 404 whose JSON body is the error contract `{ error: { code: 'NOT_FOUND', requestId } }`; collects problems, prints them and exits 1, otherwise prints `<baseUrl>: probes, metrics and the error contract are fine`.

**Implementation notes (step 0.8):** the sources above are the committed files. They differ from the first draft of this appendix in three ways: relative imports carry the `.js` suffix that `nodenext` requires; `NOT_SCANNED` also lists `eslint.config.js`, which names the banned packages in order to forbid them; and the rules of A.2 and A.3 live in pure functions (`scripts/lib/env-example.ts`, `scripts/lib/rollbacks.ts`) with their own specs, the scripts only read the files and print. Specs of `scripts/lib/` run in the unit suite (`testMatch` includes `scripts/**/*.spec.ts`). `check-rollbacks` treats a missing `prisma/migrations` or `prisma/rollbacks` as empty. The `bootstrap` package script is added in step 0.9, together with the `docker-compose.yml` and the Prisma setup it runs.

---

## 3. Directory Structure (final state)

```
wwebjs-gateway/
├── .github/ (workflows/ci.yml, workflows/wwebjs-watch.yml, dependabot.yml, pull_request_template.md)
├── .husky/ (pre-commit, commit-msg, pre-push)
├── .claude/ (settings.json, skills/, agents/code-reviewer.md)  .mcp.json  .vscode/settings.json
├── commitlint.config.js  .prettierrc  .prettierignore  pnpm-workspace.yaml
├── .dockerignore  .env.example  .gitignore  .nvmrc
├── CLAUDE.md  README.md
├── Dockerfile  docker-entrypoint.sh  docker-compose.yml  docker-compose.prod.yml
├── eslint.config.js  nest-cli.json  package.json  prisma.config.ts
├── tsconfig.json  tsconfig.build.json  tsconfig.spec.json
├── jest.config.cts  jest.integration.config.cts
├── prisma/
│   ├── schema.prisma
│   └── migrations/                  # generated SQL (committed)
├── deploy/
│   ├── Caddyfile                    # VPS reverse proxy example (TLS, websocket)
│   ├── backup-sessions.sh           # tar+timestamp backup of the session volume
│   └── github-ruleset.json          # ruleset that protects main (§2.6.8)
├── docs/                            # see §6.13 — all of it is part of the deliverable
│   ├── TDD.md  IMPLEMENTATION_PLAN.md  getting-started.md  architecture.md  authentication.md  sessions.md
│   ├── messages.md  reactions-and-receipts.md  ordering.md  origin.md  safety.md
│   ├── events.md                    # GENERATED from event schemas (do not hand-edit)
│   ├── operations-list.md           # GENERATED: every operation (REST path + socket command + errors)
│   ├── websocket-commands.md        # GENERATED: every socket command with params and examples
│   ├── openapi.json                 # GENERATED: the OpenAPI document served at /docs/json
│   ├── metrics.md                   # GENERATED: every Prometheus series (name, type, labels, help)
│   ├── errors.md                    # GENERATED: every error code (HTTP status, meaning, where it can occur)
│   ├── config-reference.md          # GENERATED: every env var (type, default, description, related guide)
│   ├── websocket.md  webhooks.md
│   ├── parity-matrix.md             # GENERATED: every wwebjs symbol → operation or "unsupported: reason"
│   ├── limits.md  operations.md  troubleshooting.md  faq.md
│   ├── development.md  repository-settings.md  contributing.md
│   ├── deploy-vps.md  deploy-railway.md  backup-restore.md  upgrading.md
│   ├── adr/                         # one Architecture Decision Record per decision (0001-….md)
├── scripts/
│   ├── bootstrap.sh                 # one-command local setup
│   ├── validate-deprecations.ts  validate-env-example.ts  check-rollbacks.ts
│   ├── validate-affected.ts         # what the pre-push hook runs
│   ├── smoke-http.ts                # probes a running service (CI + operators)
│   ├── lib/ (deprecations.ts, affected.ts)
│   ├── gen-docs.ts                  # generates every GENERATED file of §6.13 (+ --check mode)
│   └── e2e-real.ts                  # opt-in smoke test against a real number (E2E_REAL=1)
├── src/
│   ├── main.ts                      # Nest bootstrap (FastifyAdapter), process guards, shutdown hooks
│   ├── app.module.ts                # root module
│   ├── config/
│   │   ├── env.schema.ts            # zod schema of ALL env vars
│   │   └── config.module.ts         # ConfigModule.forRoot({ validate }) + typed AppConfig provider (only reader of process.env)
│   ├── common/
│   │   ├── errors.ts                # AppError hierarchy + ErrorCode enum
│   │   ├── filters/all-exceptions.filter.ts      # uniform error body, request id
│   │   ├── guards/api-key.guard.ts               # REST + socket auth, scope check helper
│   │   ├── interceptors/                         # request-id, metrics, timeout
│   │   └── lib/ (crypto.ts, wa-id.ts, throttle.ts, token-bucket.ts, ssrf.ts, timeout.ts, retry.ts, humanize.ts)
│   ├── types/
│   │   ├── events.ts                # WA_EVENT_NAMES, zod payload schemas, WaEventPayloadMap (single source for webhooks/socket/docs)
│   │   └── dto.ts                   # all DTO zod schemas + inferred types (createZodDto wrappers live next to controllers)
│   ├── infra/                       # RedisModule (ioredis factory), MetricsModule (@prometheus-io/client), LoggerModule
│   ├── database/
│   │   ├── prisma.service.ts        # PrismaClient + adapter-pg + lifecycle
│   │   └── repositories/ (api-keys, sessions, webhooks, deliveries, inbound-hooks, messages, idempotency).repository.ts
│   ├── whatsapp/                    # WhatsAppModule
│   │   ├── whatsapp-client.port.ts  # WhatsAppClientPort + WHATSAPP_CLIENT_FACTORY injection token
│   │   ├── wwebjs-adapter.ts        # ONLY file importing 'whatsapp-web.js'
│   │   ├── mappers.ts               # wwebjs objects → DTOs (pure), incl. origin extraction
│   │   ├── event-bus.service.ts     # typed in-process pub/sub
│   │   ├── session-manager.service.ts
│   │   ├── watchdog.service.ts
│   │   ├── inbound-order-buffer.ts  # per-chat reorder buffer (§6.4)
│   │   ├── reconciler.service.ts    # catch-up after ready/restart (§6.4)
│   │   └── event-pipeline.service.ts# dedupe → order → seq → store → publish
│   ├── api/                         # ApiModule — the operation registry as decorators (§6.7)
│   │   ├── wa-operation.decorator.ts        # @WaOperation({...}) metadata
│   │   ├── operation-registry.service.ts    # DiscoveryService scan → registry (REST/socket/docs/parity)
│   │   ├── controllers/
│   │   │   ├── sessions.controller.ts  presence-profile.controller.ts  settings.controller.ts
│   │   │   ├── messages.controller.ts  polls-events.controller.ts  chats.controller.ts
│   │   │   ├── contacts.controller.ts  groups.controller.ts  channels.controller.ts
│   │   │   ├── labels.controller.ts  broadcasts.controller.ts  calls.controller.ts  lookup.controller.ts
│   │   │   ├── api-keys.controller.ts  webhooks.controller.ts  inbound.controller.ts
│   │   │   ├── qr.controller.ts  media.controller.ts  system.controller.ts  health.controller.ts
│   │   └── schemas/                 # zod schemas per resource (request/response/examples)
│   ├── services/                    # feature providers
│   │   ├── auth.service.ts  send-queue.service.ts  send-policy.service.ts  message-store.service.ts
│   │   ├── webhook.service.ts  webhook-dispatcher.service.ts  delivery.processor.ts
│   │   ├── inbound-hook.service.ts  retention.service.ts
│   ├── realtime/socket.gateway.ts   # @WebSocketGateway: auth, rooms, events out, commands in, replay
│   └── parity/overrides.ts          # symbols marked `unsupported` WITH reasons
└── tests/
    ├── helpers/ (fake-whatsapp-client.ts, test-app.ts, webhook-receiver.ts, chaos.ts)
    ├── unit/
    ├── integration/
    ├── fixtures/                    # redacted real payloads (Click-to-WhatsApp message, rawData samples)
    ├── parity/                      # parity + docs drift tests
    └── e2e-real/                    # opt-in (E2E_REAL=1)
```
All services are `@Injectable()` providers grouped in feature modules (`ConfigModule`, `InfraModule`, `DatabaseModule`, `WhatsAppModule`, `ApiModule`, `WebhooksModule`, `RealtimeModule`). Constructors contain no business logic.

---

## 4. Core Development Philosophy

### 4.1 Simulation of real development
Build as a human would: `git init` → `.gitignore` → `pnpm init` / Nest scaffold + the complete toolchain of §2.6 (hooks, lint, format, CI) from the very first commits → config → common/types → database → whatsapp port/adapter → services → api (decorator + controllers) → realtime → main/Docker/CI → docs. Never create a file that imports a module that does not exist yet. Read existing code before modifying it. **No placeholder / TODO-stub code.** No over-engineering beyond this document.

### 4.2 Dependency order (strict)
config → common/types → infra → database → whatsapp (port → mappers → event-bus → adapter → order-buffer → pipeline → session-manager → watchdog → reconciler) → services → api (decorator → registry → schemas → controllers) → realtime → main → tests alongside each module → Docker → CI → docs.

### 4.3 Verify before presenting
After every step run `pnpm validate:all` (at minimum `pnpm lint`, `pnpm type-check`, `pnpm test`). Fix failures before moving on. Never commit broken code. The Git hooks (§2.6.5) enforce this on every commit and push; NEVER bypass them (`--no-verify` is forbidden).

---

## 5. Domain Model

### 5.1 Session ID
`sessionId`: `^[-_\w]{1,64}$` (identical to wwebjs `clientId` regex). Used as `LocalAuth.clientId` and Postgres PK.

### 5.2 Session status machine
`created → starting → qr | pairing_code → authenticating → ready`; any state `→ disconnected | failed`; `stop` → `stopped`.

| Status | Meaning |
|---|---|
| `created` | row exists, never started / logged out |
| `starting` | Chromium launching |
| `qr` | waiting for QR scan (latest QR cached in memory only — never persisted) |
| `pairing_code` | a phone-number pairing code was requested and is pending |
| `authenticating` | `authenticated` fired, waiting for `ready` |
| `ready` | usable |
| `disconnected` | WA/network dropped; manager reconnects per §6.5 |
| `stopped` | intentionally stopped |
| `failed` | start failed / `auth_failure` / reconnect attempts exhausted; needs manual `start` |

### 5.3 Database schema (`prisma/schema.prisma`; PostgreSQL; use `@@map` snake_case table names)
- **`ApiKey` (`api_keys`)**: `id uuid`, `name`, `keyHash` (unique, sha256 hex), `keyPrefix`, `sessionId?` (relation → Session, `onDelete: Cascade`; null = admin key), `scopes String[]` (§6.2), `allowedCidrs String[]` (empty = any), `expiresAt?`, `rotatedFromId?` (key this one replaced), `createdAt`, `lastUsedAt?`, `revokedAt?`.
- **`Session` (`sessions`)**: `id String @id`, `name?`, `status SessionStatus`, `phoneNumber?`, `pushName?`, `autoStart Boolean @default(true)`, `settings Json @default("{}")` (per-session defaults: humanize, sendJitterMs, auto-download flags, ordering overrides), `createdAt`, `updatedAt`, `lastConnectedAt?`, `lastEventAt?`, `linkedAt?` (first successful `ready` after linking; drives the warm-up of §6.8.1), `lastError?`.
- **`Webhook` (`webhooks`)**: `id uuid`, `sessionId?` (cascade; null = all sessions), `url`, `secret`, `events String[] @default(["*"])`, `enabled`, `mediaMode WebhookMediaMode @default(reference)` (`none|reference|inline`), `createdAt`.
- **`WebhookDelivery` (`webhook_deliveries`)**: `id uuid`, `webhookId` (cascade), `sessionId`, `event`, `seq BigInt`, `payload Json` (QR redacted), `status DeliveryStatus` (`pending|success|failed`), `attempts`, `lastStatusCode?`, `lastError?`, `createdAt`, `deliveredAt?`. Indexes `(webhookId, createdAt desc)`, `(status)`.
- **`InboundHook` (`inbound_hooks`)**: `id uuid`, `sessionId` (cascade), `name`, `tokenHash` (unique), `createdAt`, `revokedAt?`.
- **`StoredMessage` (`messages`)**: `id String` (serialized wwebjs id), `sessionId` (cascade), `chatId`, `direction ('in'|'out')`, `fromMe`, `type`, `body?` (null when `STORE_MESSAGE_BODIES=false`), `hasMedia`, `ack Int`, `sentAt` (sender timestamp), `receivedAt` (gateway arrival), `emittedAt?` (set when the event was published; null = still pending/held — used for crash recovery, §6.4), `origin Json?`, `dto Json`, `createdAt`. `@@id([sessionId, id])`, `@@index([sessionId, chatId, sentAt(sort: Desc)])`, `@@index([sessionId, emittedAt])`.
- **`IdempotencyKey` (`idempotency_keys`)**: `sessionId`, `key`, `requestHash`, `messageId?`, `status ('pending'|'done'|'failed')`, `response Json?`, `createdAt`. `@@id([sessionId, key])`. Purged after 24 h.

- **`Suppression` (`suppressions`)**: `sessionId` (cascade), `chatId`, `reason ('manual'|'opt_out')`, `createdAt`, `note?`. `@@id([sessionId, chatId])`. Also `Session.linkedAt?` (first successful `ready` after linking; drives warm-up) and send-policy overrides inside `Session.settings.sendPolicy`. Rolling counters (buckets, cold sends per day, duplicate-content hashes, ack health window) live in Redis with TTLs, not in Postgres.

Secrets rule: raw API keys and inbound tokens are returned ONCE and stored only as sha256. Webhook `secret` is stored in clear (needed to sign), never returned after creation (`rotate-secret` returns a new one).

### 5.4 Events
Canonical wwebjs event names (§2.5) plus gateway-synthesized events:

| Synthesized event | When |
|---|---|
| `session_status` | every status transition: `{ status, previous, reason? }` |
| `message_batch` | an ordering burst closed (§6.4): `{ chatId, messages[] (ordered by sentAt), firstSentAt, lastSentAt, count, origin? (the first non-null `origin` among the messages, §6.6.1), reason: 'burst'\|'reconcile' }` |
| `message_sent` | an async-queued outbound message was handed to WhatsApp: `{ jobId, idempotencyKey?, message }` |
| `message_failed` | an outbound message permanently failed: `{ jobId, idempotencyKey?, error }` |
| `session_error` | adapter-level failure (Chromium crash, call-timeout storm, `SEND_HEALTH_DEGRADED`) before the manager reacts |
| `chat_suppressed` | a chat entered the suppression list (§6.8.1): `{ chatId, reason: 'manual'\|'opt_out' }` |
| `chat_unreachable` | the soft unreachable flag of §6.8.1 rule 8 was set or cleared: `{ chatId, unreachable: boolean }` |
| `ping` | synthetic event from `POST /v1/webhooks/:id/test` |

Define `WA_EVENT_NAMES` (const tuple), a Zod payload schema per event, and `WaEventPayloadMap` in `src/types/events.ts`. `scripts/gen-docs.ts` renders `docs/events.md` (when each event fires, payload schema, JSON example) from these schemas.

### 5.5 Event envelope (webhooks AND socket)
```json
{
  "id": "evt_<uuid>",
  "event": "message",
  "sessionId": "support-line",
  "seq": 1042,
  "timestamp": "2026-10-26T15:04:05.123Z",
  "data": { }
}
```
- `seq` is a per-session strictly increasing integer (Redis `INCR seq:<sessionId>`), assigned AFTER ordering (§6.4), so `seq` order == conversation order. `id` is for dedupe. Delivery is **at-least-once** — consumers must be idempotent (documented prominently).
- `data` is always a DTO (never a raw wwebjs object).
- Media on message events: `data.media = { mimetype, filename, size, downloadUrl }`; `data.media.base64` only when the webhook's `mediaMode='inline'` AND size ≤ `WEBHOOK_INLINE_MEDIA_MAX_BYTES`. Media is downloaded on demand.

---

## 6. Architecture & Behavior Specs

```
 Own apps ──REST/Socket cmd──▶ Nest (Fastify) + Socket.IO gateway ──▶ @WaOperation controllers ──▶ services
                                                                  │
                                       send-queue (BullMQ, per session, persistent)
                                                                  │
                                         SessionManager ──▶ WhatsAppClientPort ──▶ wwebjs (1 Chromium / session)
                                                ▲ Watchdog / Reconciler     │ raw events
                                                │                           ▼
                                event-pipeline: dedupe → store → ORDER BUFFER → seq → publish (+ message_batch)
                                                                  ├──▶ SocketGateway ──▶ rooms
                                                                  └──▶ WebhookDispatcher ──▶ deliveries (pg) ──▶ BullMQ processor ──▶ external URLs
 External systems ──POST /v1/hooks/inbound/:token──▶ same `messages.send` pipeline as REST
```

### 6.1 Configuration
`env.schema.ts` is the Zod schema of every env var; `ConfigModule.forRoot({ validate })` parses once at boot and fails fast with one readable error listing every invalid var. A typed `AppConfig` provider is the only way to read config; no other file touches `process.env`. Full list in §6.15.

### 6.2 Authentication & authorization
- `X-API-Key: <key>` (or `Authorization: Bearer <key>`) enforced by a global `ApiKeyGuard` (routes opt out with `@Public()`). Socket.IO: `io(url, { auth: { apiKey } })`.
- `ADMIN_API_KEY` env (≥32 chars) is the bootstrap admin key (timing-safe compare). Only admin keys manage `/v1/api-keys`.
- DB keys: `wgk_<43 url-safe chars>` (32 random bytes, base64url), looked up by sha256; `last_used_at` updated debounced (≤ once/min/key); revoked keys rejected (in-memory cache TTL ≤ 30 s, invalidated on revoke).
- Session scope: a key with `sessionId` can only reach `/v1/sessions/{thatId}/…` and its own webhooks. One helper `assertSessionAccess(principal, sessionId)` is the only enforcement point (REST, socket, inbound).
- **Permission scopes (least privilege for plugins and other apps):** every key carries `scopes`, a subset of `read` (all GET operations), `send` (send messages, react, typing/state, mark seen, inbound-hook sends), `manage` (session lifecycle, chats/groups/channels/profile/settings mutations, send policy, suppressions), `webhooks` (webhook and inbound-hook CRUD), `events` (Socket.IO `subscribe`/`replay`/`command`, where `command` additionally requires the scope of the operation it invokes). Every `@WaOperation` declares its `scope`; the guard enforces it, so a key that only sends cannot touch webhooks or sessions. Operations that are not tied to one session (`POST/GET /v1/sessions`, `GET /v1/system/info`, `/v1/api-keys`, `/metrics`, `/admin/queues`) have `scope: 'admin'`, which no key can be granted: only admin keys pass. Default for a new key: `["read","send","events"]`. Admin keys implicitly have every scope. Insufficient scope → `403 INSUFFICIENT_SCOPE`.
- **Expiry and rotation:** a key may have `expiresAt` (`API_KEY_MAX_TTL_DAYS` caps it when set; 0 = no cap); expired → `401 API_KEY_EXPIRED`. `POST /v1/api-keys/:id/rotate` issues a NEW key with the same name, session, scopes and CIDRs (returned once) and sets the old key's `expiresAt` to now + `API_KEY_ROTATION_GRACE_MINUTES` (10), so a consumer can swap the secret without downtime; the old key is then rejected.
- **Optional IP allowlist per key:** `allowedCidrs` (empty = any); a request from outside the list → `403 IP_NOT_ALLOWED`. The client IP honors `TRUST_PROXY_HOPS` (behind Caddy/Railway the proxy's `X-Forwarded-For` is trusted only for that many hops).
- Public: `GET /health`, `GET /ready`, `POST /v1/hooks/inbound/:token` (token-authenticated), `/docs` only if `ENABLE_DOCS=true`. `GET /metrics` requires admin key OR `METRICS_TOKEN` bearer.
- Errors: 401 missing/invalid (`UNAUTHORIZED`), 401 `API_KEY_EXPIRED`, 403 `INSUFFICIENT_SCOPE`, 403 `IP_NOT_ALLOWED`, 403 session out of scope (`FORBIDDEN`).
- **Authentication between apps (e.g. a Crisp plugin):** one key per consuming site/workspace, limited to that site's session and to the scopes it needs; a different secret per direction (the plugin's API key towards the gateway is NOT the webhook signing secret that the gateway uses towards the plugin); keys kept encrypted in the consumer's storage, never in URLs or logs; HTTPS everywhere (private network plus `WEBHOOK_PRIVATE_HOST_ALLOWLIST` when both run side by side). OAuth2 client-credentials, mTLS or per-request JWTs are intentionally NOT built (they only pay off with third-party consumers) and are recorded as alternatives in an ADR. How the consumer authenticates calls coming from the third party (for Crisp, Crisp's own signing) is the consumer's concern.

### 6.3 WhatsApp port & adapter
`WhatsAppClientPort` is the ONLY abstraction the rest of the app sees. It mirrors the full wwebjs surface (§6.12) with our DTO types in/out and these guarantees: every method has a timeout (`WA_CALL_TIMEOUT_MS`, default 60 s; media/send 180 s), Puppeteer-class errors become typed `WaDisconnectedError` / `WaTimeoutError` / `WaOperationError`, and event handlers run inside try/catch.

`wwebjs-adapter.ts` implements the port:
`new Client({ authStrategy: new LocalAuth({ clientId: sessionId, dataPath: env.WWEBJS_DATA_PATH }), puppeteer: { headless: true, executablePath: env.PUPPETEER_EXECUTABLE_PATH, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote'] }, qrMaxRetries, webVersion/webVersionCache from env, pairWithPhoneNumber when pairing requested, deviceName/browserName from env })`.
It subscribes to ALL events in §2.5, maps through `mappers.ts`, forwards `{event, data}`; listens to Puppeteer browser/page `disconnected`/`close`/`error` and emits `session_error`. The adapter is deliberately thin and is the ONLY file excluded from coverage thresholds (cannot run without a real account); everything else is tested against `tests/helpers/fake-whatsapp-client.ts`. A `WHATSAPP_CLIENT_FACTORY` provider token `(sessionId, options) => WhatsAppClientPort` is injected into `SessionManager`; tests override it with the fake.

### 6.4 Event pipeline, ordering & reconciliation (`event-pipeline.service.ts`, `inbound-order-buffer.ts`, `reconciler.service.ts`)

**Problem being solved:** a contact with no connectivity writes N messages; when WhatsApp reconnects it delivers them in one burst in arbitrary arrival order. Consumers must see them in the order they were written.

For every event from a client, in order:
1. **Dedupe**: for message-bearing events `SET dedupe:<session>:<event>:<messageId>[:<ack>] NX EX 600` in Redis; drop duplicates (wwebjs can re-emit after reconnect). `message_ack` dedupes on `(messageId, ack)`.
2. **Store**: upsert the `messages` row immediately (`sentAt` = wwebjs `timestamp`, `receivedAt` = now, `emittedAt` = null). Errors are logged and counted, never block.
3. **Order buffer** (only for `message` and `message_create` events; every other event passes straight through, except `message_ack`/`message_edit`/`message_reaction`/`message_revoke_*` for a message currently HELD, which are held behind it and released right after it):
   - A message is **late** when `receivedAt − sentAt > INBOUND_LATE_THRESHOLD_S` (default 3 s).
   - If the chat has NO open buffer and the message is NOT late → publish immediately (zero added latency in normal chats).
   - Otherwise the message joins the chat's buffer. Each arrival restarts a debounce timer of `INBOUND_ORDER_WINDOW_MS` (default **1500 ms**); the buffer is force-flushed when it has been open `INBOUND_ORDER_MAX_HOLD_MS` (default 5000 ms) or holds `INBOUND_ORDER_MAX_MESSAGES` (default 200). A real-time message that arrives while a buffer is open joins it (preserves order).
   - **On flush**: sort by `sentAt` ascending; for ties on the same second, order by the canonical order WhatsApp Web shows in that chat (fetched once per flush via `fetchMessages({limit: buffer.size + 5})` and matched by id); final tiebreak `receivedAt`. Messages are then published in that order, flagged `data.ordering = { held: true, reordered: boolean, heldMs }`.
   - If the buffer contained ≥ 2 messages with `fromMe=false`, additionally publish one **`message_batch`** event right after them: `{ chatId, messages: [...ordered DTOs], firstSentAt, lastSentAt, count, origin?, reason: 'burst' }` (`origin` = the first non-null `origin` among its messages). Chatbot consumers should react to `message_batch` (answer once) instead of every `message`.
4. **Stamp**: assign `id` and `seq` (Redis INCR) at publish time — so `seq` order equals the corrected order. Update `emittedAt` for the stored rows.
5. **Publish** to the in-process `EventBus` → `SocketGateway` and `WebhookDispatcher`.

**Crash safety:** held messages exist in `messages` with `emittedAt IS NULL`. On boot (after the session is `ready`) the pipeline re-feeds rows with `emittedAt IS NULL AND direction='in'` through the order buffer, so a crash mid-hold neither loses nor reorders messages.

**Catch-up reconciliation (`reconciler.service.ts`)**: on every `ready` (first start, reconnect, process restart) and if `RECONCILE_ON_READY=true`: for up to `RECONCILE_MAX_CHATS` (50) chats with `unreadCount > 0` or `timestamp > lastEventAt`, `fetchMessages({limit: RECONCILE_FETCH_LIMIT})` (50), keep INCOMING messages with `sentAt > now − RECONCILE_LOOKBACK_HOURS` (48) that are absent from `messages`, and push them through the pipeline (they go through the order buffer; batch `reason: 'reconcile'`). This closes gaps from downtime or missed events.

Pipeline errors are caught per event, counted in metrics, and never stop the stream. Ordering can be disabled per session (`settings.ordering.enabled=false`) or globally (`INBOUND_ORDERING_ENABLED=false`). `docs/ordering.md` documents the algorithm, knobs, the 1-second timestamp limit, and a recommended consumer pattern (react to `message_batch`, sort by `sentAt` as a safety net).

### 6.5 SessionManager & Watchdog
**SessionManager**
- `Map<sessionId, { client, status, qr?, startedAt, reconnectAttempts }>`; DB is the source of truth for existence/config.
- `create(id, opts)` → row `created`; 409 if exists or if `MAX_SESSIONS` running.
- `start(id, { pairingPhoneNumber? })` → `starting`; factory builds the client; events drive status per §5.2 and persist to DB; every transition publishes `session_status`. QR cached in memory (cleared on `authenticated`/`ready`). On `ready`: store `phone_number`, `push_name`, `last_connected_at`, reset `reconnectAttempts`, re-apply per-session settings, trigger reconciliation (§6.4).
- `stop(id)` → `destroy()`, `stopped`, `auto_start=false`. `restart` = stop+start preserving `auto_start`. `logout` → `client.logout()`, status `created`, `auto_start=false`. `remove` → logout best-effort + delete row. `resetState(id)` → `Client.resetState()`.
- **Reconnect**: on `disconnected` (reason ≠ `LOGOUT`) or `session_error` or watchdog trigger: destroy client (swallow errors, kill orphan Chromium via the adapter), set `disconnected`, retry `start` with exponential backoff + jitter (5 s → 5 min cap) up to `SESSION_RECONNECT_MAX_ATTEMPTS` (0 = unlimited; resets on `ready`; finite & exhausted → `failed`). Reason `LOGOUT` → `created`, no retry (needs new QR). `auth_failure` → `failed`, no retry. `change_state` `CONFLICT` → honor `TAKEOVER_ON_CONFLICT`.
- **Restore on boot** (`OnApplicationBootstrap`, non-blocking): every row with `auto_start=true` and a previous successful link starts sequentially with `SESSION_START_STAGGER_MS`.
- **Shutdown**: destroy every client without logout.
- `requireReady(id)` throws `ConflictError('SESSION_NOT_READY')`.

**Watchdog**
- Every `WATCHDOG_INTERVAL_MS` (30 s) per `ready` session: `getState()` with 10 s timeout. `WATCHDOG_MAX_FAILURES` (3) consecutive failures, or state in `{CONFLICT (without takeover), UNPAIRED, UNPAIRED_IDLE, DEPRECATED_VERSION, TOS_BLOCK, PROXYBLOCK}` → `session_error` + reconnect path (blocking states set `failed` + `last_error` instead of looping).
- Stuck startup: a session in `starting`/`authenticating` longer than `SESSION_START_TIMEOUT_MS` (180 s) is restarted.
- Optional memory guard: if process RSS > `MEMORY_RESTART_THRESHOLD_MB` (0 = off), restart the largest idle session (never mid-send).

### 6.6 Serialization (`mappers.ts`, `types/dto.ts`)
Pure functions per DTO: `MessageDto`, `ChatDto`, `GroupChatDto`, `ChannelDto`, `ContactDto`, `BusinessContactDto`, `LabelDto`, `BroadcastDto`, `CallDto`, `ReactionDto`, `PollVoteDto`, `GroupNotificationDto`, `OrderDto`, `ProductDto`, `PaymentDto`, `ClientInfoDto`, `MessageInfoDto`, `MembershipRequestDto`, etc. — one Zod schema per DTO covering ALL fields exposed by the corresponding wwebjs interface in `index.d.ts` (the parity test also checks DTO field coverage, §6.12). Mappers take structural (duck-typed) inputs so they are unit-testable without wwebjs. Dates are ISO strings; ids are serialized strings; media bytes never inlined except per §5.5.

`MessageDto` adds gateway fields beyond wwebjs: `sentAt` (ISO, from `timestamp`), `receivedAt` (ISO), `ordering?` (§6.4), `origin?` (§6.6.1), `raw?`.

#### 6.6.1 `raw` and `origin` (conversation-origin metadata)
- **`raw`**: sanitized copy of `Message.rawData` (the WhatsApp Web internal message object). Sanitization: cycle-safe, drops functions, binary buffers/typed arrays and base64 blobs larger than `RAW_MAX_FIELD_BYTES` (8 KiB) replacing them with `"[omitted:<bytes>]"`, depth-limited. Included on message events when `INCLUDE_RAW=true` (default true); per-webhook override `includeRaw`. Documented as "unstable shape: mirrors WhatsApp Web internals and may change without notice".
- **`origin`**: derived, stable, typed object extracted from `rawData.ctwaContext` by a pure mapper (`extractOrigin`). Verified field names in use by a prior production implementation of this same integration: `ctwaContext.{ conversionSource, sourceUrl, title, description, thumbnailUrl, mediaUrl }` (all optional, WhatsApp may omit any). Shape:
  ```ts
  origin?: {
    kind: 'click_to_whatsapp_ad';        // only value for now
    conversionSource?: string;           // e.g. the ad placement/source type
    sourceUrl?: string;                  // link to the ad / post the user clicked
    sourceId?: string;                   // ad/post id: taken from ctwaContext.sourceId when present, else parsed from sourceUrl/mediaUrl (numeric post/ad id) — null when neither yields one
    title?: string; description?: string;
    thumbnailUrl?: string; mediaUrl?: string;  // mediaUrl = original ad/post media link
    ctwaClid?: string;                   // click id, when present in rawData (e.g. ctwaPayload/ctwaClid keys)
  }
  ```
  `origin` is present only when `ctwaContext` exists. It is attached to the message that carries the context (normally the first incoming message of a conversation started from an ad) and persisted in `messages.origin`. If WhatsApp renames fields, `raw` still carries everything; `extractOrigin` is covered by unit tests with fixtures captured from real messages.
- **Verification step (mandatory, Phase 12):** with a real Meta Click-to-WhatsApp ad, capture the raw message JSON, store it as a redacted fixture in `tests/fixtures/`, confirm which key contains the ad id (`sourceId` vs derivable from `sourceUrl`), and finalize `extractOrigin`. Until then the id-derivation rules above are best-effort and documented as such.
- **How a consumer recognizes an ad message (same envelope over webhooks and Socket.IO):** the `message` / `message_create` event (and each message inside `message_batch`, plus the batch itself) carries `data.origin`. The test is one line: `data.origin?.kind === 'click_to_whatsapp_ad'`. When present, `origin.sourceId` (or, until step 12.3 confirms it, `origin.sourceUrl`) identifies the ad/post for the consumer's own lookups. Example webhook body:
  ```json
  {
    "id": "evt_0f3c…", "event": "message", "sessionId": "support-line", "seq": 1042,
    "timestamp": "2026-10-27T15:04:05.123Z",
    "data": {
      "id": "false_5215500000001@c.us_3EB0…", "chatId": "5215500000001@c.us", "fromMe": false,
      "body": "Hola, ¿cuál es el precio?", "type": "chat", "sentAt": "2026-10-27T15:04:04.000Z",
      "origin": {
        "kind": "click_to_whatsapp_ad", "conversionSource": "ctwa_ad", "sourceId": "120210000000000000",
        "sourceUrl": "https://example.com/ad", "title": "Ad title", "description": "Ad text",
        "thumbnailUrl": "https://example.com/t.jpg", "mediaUrl": "https://example.com/m"
      }
    }
  }
  ```
  `origin` rides only on the message that carries WhatsApp's ad context (normally the first message of a conversation started from the ad); later messages of the same chat do not have it, so a consumer that needs it later reads it from its own storage or from `GET …/stored-messages` (the gateway persists it in `messages.origin`). It is a field of the message, not a new event type, so a webhook's `events` filter selects by event name (`message`, `message_batch`) and the consumer branches on `origin`. If WhatsApp changes the internal shape, `data.raw` still carries everything.
- `docs/origin.md` documents `origin` and `raw`: what they are, when present, the Meta Click-to-WhatsApp case, field table, and the stability caveat. It does NOT describe any consumer-side behavior.

### 6.7 Operation registry via decorators — single source of truth (DRY at the architectural level)
Every capability is ONE controller method annotated with `@WaOperation`:
```ts
@WaOperation({
  id: 'chats.setState',                         // unique, dotted; also the default socket command name
  scope: 'send',                                // REQUIRED: read | send | manage | webhooks | events | admin (§6.2)
  summary: 'Set typing/recording state',        // REQUIRED
  description: '…markdown…',                    // REQUIRED: behavior, limits
  socket: { command: 'chat.state' },            // exposed as a socket command too
  errors: ['SESSION_NOT_READY','CHAT_NOT_FOUND'],
  examples: { request: {...}, response: {...} },// REQUIRED
  wwebjs: ['Chat.sendStateTyping','Chat.sendStateRecording','Chat.clearState'], // parity links, REQUIRED
})
@Post('sessions/:sessionId/chats/:chatId/state')
setState(@Param() p: ChatParamsDto, @Body() body: SetChatStateDto) { … }
```
- The Nest route decorators define REST; Zod DTOs (`createZodDto`) define validation and Swagger schemas; `@WaOperation` stores metadata (`Reflect.defineMetadata`).
- `OperationRegistryService` (on bootstrap) uses `DiscoveryService`/`MetadataScanner` to collect all `@WaOperation` methods → used by (a) `SocketGateway` to dispatch `command` messages by `op` through the SAME controller method with the same Zod validation and `assertSessionAccess`, (b) `scripts/gen-docs.ts` + parity test, (c) OpenAPI enrichment (examples/descriptions).
- Gateway-native operations (no wwebjs counterpart: send policy, suppressions, `GET …/stored-messages`, `GET …/send-jobs/:jobId`, system, api-keys, webhooks, inbound hooks) declare `gateway: true` and `wwebjs: []`; every other operation MUST list at least one wwebjs symbol. The parity test counts `gateway: true` operations separately and fails on an operation that has neither.
- Controllers are thin: they call services; services call `WhatsAppClientPort` via `SessionManager.requireReady`. A shared interceptor provides timeouts, metrics and error mapping uniformly.

### 6.8 Messaging & the persistent send queue (`send-queue.service.ts`)
Reliability goal: a message the API accepted is not lost on restart and never sent twice.
- All sends (REST, socket command, inbound hook) go through `messages.send`. Pipeline: validate → **idempotency check** → enqueue → worker sends via the port → persist result → emit `message_sent`/`message_failed`.
- **Queue**: BullMQ with one dynamically created **Worker per session** on queue `send:<sessionId>`, concurrency 1 (per-conversation ordering). Workers are created/removed with the session lifecycle; jobs for a not-ready session stay delayed (retry every `SEND_NOT_READY_RETRY_MS`) until ready or `SEND_MAX_WAIT_MS` (5 min) elapses → `message_failed(SESSION_NOT_READY)`.
- **Sync vs async**: default `wait=true` — the call waits (≤ `SEND_SYNC_TIMEOUT_MS`, 60 s) for the job result and returns `201 { messageId, chatId, timestamp, ack }`. On timeout → `202 { jobId, status: 'queued' }` and the result arrives as `message_sent`/`message_failed`. `wait=false` → immediate `202 { jobId }`. `GET /v1/sessions/:id/send-jobs/:jobId` returns job status.
- **Idempotency**: header `Idempotency-Key` (≤ 128 chars). Same key + same request hash → original result (or in-flight job); same key + different payload → `422 IDEMPOTENCY_KEY_REUSED`. Stored 24 h.
- **Retries** inside the worker: only for errors proven pre-send (session not ready, `WaDisconnectedError` before dispatch). A send whose outcome is unknown (timeout after dispatch) is NOT blindly retried — marked `failed` with `UNKNOWN_OUTCOME`; before any manual retry check `messages`/`getMessageById` (documented). Avoids double-sends.
- **Pacing**: per-session min interval `SEND_MIN_INTERVAL_MS` (1000) + jitter up to `SEND_JITTER_MS` (400). Per-session circuit breaker: `SEND_BREAKER_THRESHOLD` consecutive hard failures (5) pause that session's queue for `SEND_BREAKER_COOLDOWN_MS` and emit `session_error`.
- **Humanize**: body field `humanize: { typing?: 'auto' | number(ms), recording?: boolean, markSeenFirst?: boolean }`. `auto` = clamp(35 ms × body length ± jitter, 600 ms, 8000 ms). The worker sets typing/recording state (renewing every 20 s for long durations), waits, `clearState()`s (also on failure — `finally`), then sends. Per-session defaults in `sessions.settings.humanize`; request values override.
- **Recipient resolution**: `to` accepts E.164-ish phone (spaces/dashes tolerated) or a full id (`@c.us`, `@g.us`, `@lid`, `@newsletter`, `status@broadcast`). Phones are resolved with `getNumberId`; unregistered → `422 NUMBER_NOT_ON_WHATSAPP`. Cached in Redis 1 h.
- **Send body** (Zod discriminated union on `type`): `text`, `media` (`source`: `{ base64, mimetype, filename? }` | `{ url, filename? }` | `{ messageId }`; options `caption`, `asDocument`, `asVoice`, `asGif`, `asSticker` (+ `stickerName/Author/Categories`), `asHd`, `viewOnce`), `location`, `contact` (`contactId` | `vcard`), `contacts`, `poll`, `event` (ScheduledEvent), `groupInvite`. Common options map 1:1 to `MessageSendOptions`: `quotedMessageId`, `ignoreQuoteErrors`, `mentions`, `groupMentions`, `linkPreview`, `parseVCards`, `sendSeen`, `waitUntilMsgSent`, `extra`.
- `media.url` fetching: SSRF guard, size cap `MAX_MEDIA_BYTES` (32 MiB), timeout, mimetype sniffing.

#### 6.8.1 Send policy (account-safety guard) — `send-policy.service.ts`
Goal: make the account behave like a person having conversations, and lower the chance of WhatsApp restricting or banning a number. **WhatsApp publishes no thresholds and no guarantee exists**; every number below is a conservative STARTING POINT, tunable per session, never a promise. The dominant real-world risk factors are: recipients who report/block, many first messages to people who never wrote, identical text to many people, bursts, and brand-new accounts with sudden volume. The policy targets exactly those.

Every send is evaluated by `SendPolicyService` twice: at enqueue (cheap rejections give the caller an immediate answer) and right before dispatch in the worker (budgets and delays). Decisions are `allow`, `delay(ms)` (the job is re-queued; chatbots never see an error for pacing) or `reject(code)` (`422 POLICY_BLOCKED` with `details.rule`; for async sends a `message_failed` event with the same code). Rules, in order:
1. **Open conversation vs cold send.** A chat is *open* if the contact sent us a message within `CONVERSATION_WINDOW_HOURS` (24). Replies inside an open conversation are the normal, low-risk case and are exempt from the cold rules below. Anything else is a *cold send*.
2. **Cold sends are off by default** (`ALLOW_COLD_SENDS=false`, per-session override `settings.sendPolicy.allowColdSends`). When allowed: at most `COLD_SENDS_PER_DAY` (20) distinct new chats per session per day, `COLD_SEND_MIN_GAP_MS` (60000) between them, plus the duplicate-content guard (rule 5). The `getNumberId` lookups of cold sends are capped too (`LOOKUPS_PER_DAY`, 100): many look-ups of unregistered numbers is itself a signal.
3. **Per-chat pacing:** `PER_CHAT_MIN_INTERVAL_MS` (1500) between consecutive messages to the same chat and `PER_CHAT_MAX_PER_MINUTE` (10).
4. **Per-session budgets (token buckets):** `SESSION_MAX_PER_MINUTE` (20), `SESSION_MAX_PER_HOUR` (300), `SESSION_MAX_PER_DAY` (1500). Exceeding a bucket yields `delay` until a token is free (never an error), so bursts are smoothed into a steady flow ("cooldown"). Plus the pacing of §6.8 (`SEND_MIN_INTERVAL_MS` + jitter).
5. **Duplicate-content guard (cold sends only):** if the same normalized body (lowercased, whitespace-collapsed, digits/URLs masked) was already sent to ≥ `DUPLICATE_RECIPIENTS_THRESHOLD` (5) different chats within `DUPLICATE_WINDOW_MINUTES` (10) → `reject(DUPLICATE_CONTENT)`.
6. **Warm-up for young accounts:** while a session's account is younger than `WARMUP_DAYS` (14, measured from the first successful `ready` after linking, stored in `sessions.linkedAt`) every budget of rules 2–4 is scaled by a linear ramp from `WARMUP_START_FRACTION` (0.1) to 1.0.
7. **Suppression list:** a chat in `suppressions` rejects every send with `RECIPIENT_SUPPRESSED`. Entries come from `POST …/suppressions` and — opt-in only, default empty — from `settings.sendPolicy.optOutKeywords` (an incoming message whose whole normalized text equals one of the keywords, e.g. `stop`, `baja`, adds the chat and publishes `chat_suppressed`).
8. **Unreachable flag (possible block / dead number) — deliberately slow and soft.** A recipient who is merely offline (no data, phone off) also leaves our messages at ack 1 ("server") until they reconnect, because WhatsApp holds them for delivery; that case is indistinguishable from a block, so a short window would cause false positives. Therefore: a chat is flagged `unreachable` only when the contact has sent NOTHING for `UNREACHABLE_MIN_AGE_HOURS` (72) AND the last `UNREACHABLE_STREAK` (5) outbound messages to it are all still at ack < 2 AND the oldest of them is older than that same age. Effect: only cold sends to that chat are rejected (`RECIPIENT_UNREACHABLE`); replies inside an open conversation are never affected (an incoming message proves the contact can reach us). The flag (Redis, 30-day TTL, event `chat_unreachable`) clears automatically on any incoming message from the contact or any later ack ≥ 2. It never writes to the suppression list.
9. **Health-based throttle:** the pipeline keeps a rolling window of the last `HEALTH_WINDOW` (50) outbound results per session. Only HARD failures count as bad: send exceptions, timeouts and ack = -1 (`ACK_ERROR`). Acks stuck at 1 are NOT counted (normal for offline recipients). If the bad ratio exceeds `HEALTH_MAX_BAD_RATIO` (0.2) the session's budgets are halved for `HEALTH_COOLDOWN_MIN` (30) minutes and `session_error` (`code: 'SEND_HEALTH_DEGRADED'`) is published. Throttling DELAYS: the jobs stay queued in BullMQ and drain at the reduced rate. A job delayed by policy waits at most `SEND_POLICY_MAX_WAIT_MS` (1800000 = 30 min, separate from `SEND_MAX_WAIT_MS`, which only covers "session not ready"); beyond that it ends as `message_failed(POLICY_DELAY_EXCEEDED)` so the consumer can decide. Synchronous callers (`wait=true`) get `202 { jobId, status: 'queued' }` after `SEND_SYNC_TIMEOUT_MS`, as usual. This complements the circuit breaker of §6.8.
10. **Quiet hours (optional, per session):** `settings.sendPolicy.quietHours { from, to, timezone }`; cold sends inside the window are delayed to its end (replies are never held).

Humanization of §6.8 (`humanize`, typing before sending, `markSeenFirst`) is ON by default for text replies through `settings.humanize`; `humanize.minReplyDelayMs` (default 1500) prevents instant replies.

Operations (gateway-native: `@WaOperation` with `wwebjs: []` and `gateway: true`, excluded from the parity count but still documented): `GET|PUT …/send-policy` (effective policy = env defaults + session overrides), `GET …/send-policy/usage` (current bucket levels, cold sends today, warm-up factor, health ratio, throttle state), `GET|POST|DELETE …/suppressions[/:chatId]`. Metrics: `gw_policy_decisions_total{rule,decision}`, `gw_policy_delay_seconds`, `gw_suppressed_chats`. Docs: `docs/safety.md` (what the policy does and does NOT guarantee, tuning, warm-up plan, operational checklist below).

**Operational checklist (goes into `docs/safety.md`, not enforceable in code):** use numbers with history and a real SIM, not freshly created ones; complete the profile (name, photo); keep the phone's WhatsApp updated and connected at least every few days (linked devices are unlinked after ~14 days offline); one gateway instance per session and never the same session open elsewhere; keep a stable server IP/region per number and avoid frequent relinks; scale volume gradually over weeks; write messages people want to receive and make it easy to stop; never buy lists or message people who did not initiate; for business-initiated outreach at scale use the official WhatsApp Business Platform instead of this gateway.

### 6.9 Outbound webhooks
- **Dispatcher** subscribes to the EventBus; loads enabled webhooks where `sessionId IS NULL OR = event.sessionId` and (`'*' ∈ events` OR `event ∈ events`); in-memory list cache invalidated on CRUD.
- For each match: insert `webhook_deliveries` (`pending`, payload redacted of QR) then `queue.add('deliver', { deliveryId, envelope }, { attempts: WEBHOOK_MAX_ATTEMPTS, backoff: { type: 'exponential', delay: WEBHOOK_BACKOFF_MS }, removeOnComplete: { age: 3600 }, removeOnFail: { age: 86400 } })`. The job carries the full envelope (Redis AOF persists it); the DB copy is redacted. If the DB insert fails, the event is still enqueued (job-only) and counted — never lose a deliverable event because the log is down.
- **Processor** (concurrency `WEBHOOK_WORKER_CONCURRENCY`): headers `Content-Type: application/json`, `User-Agent: wwebjs-gateway/<version>`, `X-Gateway-Event`, `X-Gateway-Delivery`, `X-Gateway-Seq`, `X-Gateway-Timestamp` (unix s), `X-Gateway-Signature: sha256=<hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>`. `AbortSignal.timeout(WEBHOOK_TIMEOUT_MS)`, `redirect: 'error'`. 2xx = success; anything else = record + throw → BullMQ retry. Final failure → `failed` (dead-letter list).
- **SSRF policy**: default blocks loopback/link-local/private/ULA/metadata ranges, re-checked each attempt. Own apps often live on a private network (e.g. `http://bot:3000`), so allow specific private targets via `WEBHOOK_PRIVATE_HOST_ALLOWLIST` (hostnames / CIDRs). `ALLOW_PRIVATE_WEBHOOK_TARGETS=true` disables the guard (dev/test only; startup warning).
- **Replay/dead letters**: `GET /v1/webhooks/:id/deliveries?status=failed`, `POST …/deliveries/:deliveryId/retry`, `POST /v1/webhooks/:id/deliveries/retry-failed`, `POST /v1/webhooks/:id/test` (`ping`).
- **Ordering note**: deliveries retry independently, so a late retry can arrive after a newer event; consumers order by `seq`. `docs/webhooks.md` includes a reference consumer buffering by `seq`.
- Retention (`RetentionService`, daily via `upsertJobScheduler`): delete deliveries older than `DELIVERY_RETENTION_DAYS` (14), messages older than `MESSAGE_RETENTION_DAYS` (30), idempotency keys older than 24 h.

### 6.10 Inbound webhooks & Socket.IO
**Inbound**: `POST /v1/sessions/:sessionId/inbound-hooks {name}` → `{ id, name, url }` ONCE (token = 32 random bytes base64url, stored sha256). `POST /v1/hooks/inbound/:token` accepts the SAME schema as `messages.send` plus a no-code shape `{ "to", "text" }` (one `z.union` transform). Supports `Idempotency-Key`. Rate-limited per token; revoked → 401.

**Socket.IO** (`socket.gateway.ts`): CORS from `CORS_ORIGINS`; handshake middleware authenticates `handshake.auth.apiKey` with `AuthService`.
- Client → server:
  - `subscribe { sessionId, events? }` (ack `{ ok, snapshot: { status, qr?, seq } }`), `unsubscribe { sessionId }`. Admin may subscribe `'*'`.
  - `command { op, sessionId, params, idempotencyKey? }` (ack `{ ok: true, data } | { ok: false, error: { code, message, details } }`). `op` is any operation's socket command name. **Example:** `command { op: 'chat.state', sessionId: 'sales', params: { chatId: '5215512345678@c.us', state: 'typing', durationMs: 5000 } }` sets typing on that conversation. Scope and validation identical to REST (same controller methods via the registry).
  - `replay { sessionId, afterSeq, limit }` → re-emits retained events (Redis stream `events:<sessionId>` trimmed to `EVENT_REPLAY_WINDOW_SECONDS`, default 300) so a reconnecting client closes gaps (ack `{ ok, from, to, truncated }`).
- Server → client: single event `wa:event` carrying the §5.5 envelope.
- Backpressure: bounded per-socket emit queue; slow consumers are disconnected with reason `slow_consumer`.

### 6.11 REST API surface (all under `/v1`; each is a `@WaOperation` controller method unless noted)
Session routes live under `/v1/sessions/:sessionId`. Full parameter/response detail lives in the Zod schemas and the generated OpenAPI.

**System (hand-written):** `GET /health` (liveness, Terminus) · `GET /ready` (pg+redis ping, 503 otherwise) · `GET /metrics` · `GET /docs` & `/docs/json` (flag-gated) · `GET /v1/system/info` (gateway version, wwebjs version, WA Web version per session, uptime, counts).
**API keys (admin):** `POST /v1/api-keys {name, sessionId?, scopes?, allowedCidrs?, expiresAt?}` · `GET /v1/api-keys` · `POST /v1/api-keys/:id/rotate` · `DELETE /v1/api-keys/:id` (revoke). **Queue dashboard:** `/admin/queues` (Bull Board; HTTP Basic auth with user `admin` and the admin key as password, because a browser cannot send `X-API-Key`; only when `BULL_BOARD_ENABLED=true`; the route relaxes helmet's CSP for its own UI only).
**Sessions:** `POST /v1/sessions` · `GET /v1/sessions` · `GET/DELETE /v1/sessions/:id` · `PATCH /v1/sessions/:id` (name, autoStart, settings) · `POST …/start|stop|restart|logout|reset-state` · `GET …/qr` · `GET …/qr.png` · `POST …/pairing-code {phoneNumber, showNotification?}` · `DELETE …/pairing-code` · `GET …/info` (ClientInfo + battery) · `GET …/state` · `GET …/wweb-version`.
**Presence & profile:** `POST …/presence {state: available|unavailable}` · `PUT …/profile/status` · `PUT …/profile/display-name` · `PUT/DELETE …/profile/picture` · `PUT …/settings {autoDownloadAudio, autoDownloadDocuments, autoDownloadPhotos, autoDownloadVideos, backgroundSync}`.
**Messages:** `POST …/messages` (§6.8) · `GET …/send-jobs/:jobId` · `GET …/messages/:messageId` · `GET …/messages/search?query&chatId&limit&page&fromMe` · `POST …/messages/:messageId/reply` · `/react` · `/forward {chatId}` · `/star` · `/unstar` · `/pin {duration}` · `/unpin` · `PATCH …/messages/:messageId` (edit) · `DELETE …/messages/:messageId?everyone&clearMedia` · `GET …/messages/:messageId/media` (binary stream) · `/quoted` · `/mentions` · `/group-mentions` · `/info` (receipts) · `/order` · `/payment` · `/reactions` · `/poll-votes` · `POST /vote {selectedOptions}` · `POST /accept-group-invite` (V4) · `DELETE …/status-messages/:messageId` · `GET …/stored-messages?chatId&before&limit` (from our DB, ordered by `sentAt`).
**Polls & scheduled events:** `GET …/polls/:messageId/votes` · `POST …/events/:messageId/response {response}` · `PATCH …/events/:messageId`.
**Chats:** `GET …/chats` · `GET …/chats/:chatId` · `GET …/chats/:chatId/messages?limit&fromMe` · `POST …/chats/:chatId/state {state: typing|recording|clear, durationMs?}` · `/seen` · `/mark-unread` · `/archive` · `/unarchive` · `/pin` · `/unpin` · `/mute {until?}` · `/unmute` · `/clear-messages` · `DELETE …/chats/:chatId` · `GET …/chats/:chatId/pinned-messages` · `GET/PUT …/chats/:chatId/labels` · `POST …/chats/:chatId/sync-history` · `GET/PUT …/chats/:chatId/customer-note`.
**Contacts:** `GET …/contacts` · `GET …/contacts/blocked` · `GET …/contacts/:contactId` (incl. Business profile) · `/about` · `/picture` · `/common-groups` · `/device-count` · `/broadcast` · `POST /block` · `POST /unblock` · `PUT/DELETE …/contacts/:contactId/addressbook` · `GET …/contacts/lid-phone?ids=` · `GET …/numbers/:number`.
**Groups:** `POST …/groups` (all `CreateGroupOptions`) · `GET …/groups` · `GET …/groups/:groupId` · `PATCH …/groups/:groupId` · `PATCH …/groups/:groupId/settings` · `POST …/groups/:groupId/participants {action, participants[], options}` · `GET/POST …/groups/:groupId/invite[/revoke]` · `PUT/DELETE …/groups/:groupId/picture` · `POST …/groups/:groupId/leave` · `GET …/groups/:groupId/membership-requests` · `POST …/membership-requests/approve|reject` · `POST …/groups/join {inviteCode}` · `GET …/groups/invite-info/:inviteCode` · `POST …/groups/join-v4`.
**Channels:** `GET …/channels` · `GET …/channels/by-invite/:code` · `GET …/channels/search` · `POST …/channels` · `DELETE …/channels/:channelId` · `POST …/subscribe|unsubscribe` · `GET …/subscribers` · `PATCH …/channels/:channelId` · `PUT …/picture` · `PUT …/reaction-setting` · `POST …/mute|unmute` · `POST/GET …/messages` · `POST …/seen` · admin invite send/accept/revoke · `demote-admin` · `transfer-ownership`.
**Labels:** `GET …/labels` · `GET …/labels/:labelId` · `GET …/labels/:labelId/chats` · `POST …/labels/assign {labelIds, chatIds}`.
**Broadcasts/Status:** `GET …/broadcasts` · `GET …/broadcasts/:broadcastId`. (Posting a status = `messages.send` to `status@broadcast`.)
**Calls:** `POST …/calls/link {startTime, callType}` · `POST …/calls/:callId/reject` (recent incoming calls in an in-memory ring buffer, `CALL_CACHE_SIZE`).
**Webhooks:** `POST/GET /v1/webhooks` · `GET/PATCH/DELETE /v1/webhooks/:id` · `POST …/rotate-secret` · `POST …/test` · `GET …/deliveries` · `POST …/deliveries/:id/retry` · `POST …/deliveries/retry-failed`.
**Inbound hooks:** `POST|GET …/inbound-hooks` · `DELETE …/inbound-hooks/:hookId` · `POST /v1/hooks/inbound/:token`.
**Send policy (gateway-native, §6.8.1):** `GET|PUT …/send-policy` (effective policy = env defaults + session overrides) · `GET …/send-policy/usage` (bucket levels, cold sends today, warm-up factor, health ratio, throttle state) · `GET …/suppressions` · `POST …/suppressions {chatId, note?}` · `DELETE …/suppressions/:chatId` · `GET …/unreachable-chats`.

**Error format (uniform, via `AllExceptionsFilter`):**
```json
{ "error": { "code": "SESSION_NOT_READY", "message": "…", "details": { }, "requestId": "…" } }
```
Codes are an enum in `common/errors.ts`, documented per operation. Zod failures → 400 `VALIDATION_ERROR` (`z.treeifyError`). Unknown → 500 `INTERNAL` (message hidden in production). wwebjs failures → 502 `WHATSAPP_ERROR`/504 `WHATSAPP_TIMEOUT`.

**Cross-cutting:** `@fastify/helmet`, `@fastify/cors`, `@nestjs/throttler` (global `RATE_LIMIT_MAX`/min keyed by API key or IP; stricter on inbound), `x-request-id` propagation, pino redaction (`x-api-key`, `authorization`, any `secret`/`token`/`qr` field), body limits (40 MiB on send; 1 MiB elsewhere). Metrics (`@prometheus-io/client`): `gw_sessions{status}`, `gw_events_total{event}`, `gw_ordering_held_total`, `gw_ordering_reordered_total`, `gw_ordering_hold_seconds`, `gw_send_total{result}`, `gw_send_duration_seconds`, `gw_send_queue_depth{session}`, `gw_webhook_deliveries_total{result}`, `gw_webhook_duration_seconds`, `gw_wa_call_duration_seconds{op}`, `gw_wa_call_errors_total{op,type}`, `gw_watchdog_restarts_total`, `gw_reconcile_recovered_total`, default Node/process metrics.

### 6.12 Parity guarantee (the "100%" proof)
**Inventory (verified from `whatsapp-web.js@1.34.7/index.d.ts`)** — every member below must be mapped to an operation, an event, a config option, or marked `unsupported` with a reason:

- **Client** (84 members): `info, acceptInvite, acceptChannelAdminInvite, revokeChannelAdminInvite, demoteChannelAdmin, acceptGroupV4Invite, getInviteInfo, archiveChat, pinChat, unpinChat, createGroup, createChannel, deleteChannel, subscribeToChannel, unsubscribeFromChannel, searchChannels, destroy, logout, getBlockedContacts, getChatById, getChannelByInviteCode, getChats, getChannels, getContactById, getMessageById, getPinnedMessages, getContacts, getCountryCode, getFormattedNumber, getLabels, getBroadcasts, getBroadcastById, revokeStatusMessage, addOrRemoveLabels, getLabelById, getChatLabels, getChatsByLabelId, getProfilePicUrl, getCommonGroups, getState, getWWebVersion, initialize, isRegisteredUser, getNumberId, muteChat, requestPairingCode, cancelPairingCode, resetState, sendMessage, sendReaction, sendChannelAdminInvite, searchMessages, sendPresenceAvailable, sendPresenceUnavailable, sendSeen, markChatUnread, setStatus, setDisplayName, setAutoDownloadAudio, setAutoDownloadDocuments, setAutoDownloadPhotos, setAutoDownloadVideos, setBackgroundSync, getContactDeviceCount, syncHistory, saveOrEditAddressbookContact, addOrEditCustomerNote, getCustomerNote, deleteAddressbookContact, getContactLidAndPhone, unarchiveChat, unmuteChat, setProfilePicture, deleteProfilePicture, createCallLink, sendResponseToScheduledEvent, getGroupMembershipRequests, approveGroupMembershipRequests, rejectGroupMembershipRequests, transferChannelOwnership, getPollVotes, on` (+ `pupPage`, `pupBrowser` → `unsupported: security`).
- **Chat**: `archive, pin, unpin, clearMessages, clearState, delete, fetchMessages, mute, sendMessage, sendSeen, sendStateRecording, sendStateTyping, unarchive, unmute, getContact, markUnread, getLabels, changeLabels, getPinnedMessages, syncHistory, addOrEditCustomerNote, getCustomerNote` + fields.
- **GroupChat**: `addParticipants, removeParticipants, promoteParticipants, demoteParticipants, setSubject, setDescription, setAddMembersAdminsOnly, setMessagesAdminsOnly, setInfoAdminsOnly, getGroupMembershipRequests, approveGroupMembershipRequests, rejectGroupMembershipRequests, getInviteCode, revokeInvite, leave, setPicture, deletePicture` + fields.
- **Channel**: `getSubscribers, setSubject, setDescription, setProfilePicture, setReactionSetting, mute, unmute, sendMessage, sendSeen, sendChannelAdminInvite, acceptChannelAdminInvite, revokeChannelAdminInvite, demoteChannelAdmin, fetchMessages, transferChannelOwnership, deleteChannel`.
- **Message**: `reload, acceptGroupV4Invite, delete, downloadMedia, getChat, getContact, getMentions, getGroupMentions, getQuotedMessage, reply, react, forward, star, unstar, pin, unpin, getInfo, getOrder, getPayment, getPollVotes, getReactions, edit, editScheduledEvent, vote` + all data fields (ack, author, body, location, vCards, inviteV4, mentionedIds, poll*, event*, order/product/business fields; `rawData` → exposed as `raw`, §6.6.1).
- **Contact / BusinessContact**: `getProfilePicUrl, getChat, getCountryCode, getFormattedNumber, block, unblock, getAbout, getCommonGroups, getBroadcast` + fields (incl. business profile).
- **Label**: `getChats` + fields. **Broadcast**: `getChat, getContact` + fields. **Call**: `reject` + fields. **GroupNotification**: `getChat, getContact, getRecipients, reply` + fields. **Poll / PollVote / Reaction / Order / Product / Payment / Location / MessageMedia / MessageInfo / ClientInfo / MembershipRequest**: all fields represented in DTOs.
- **Options**: `MessageSendOptions` (21), `MessageEditOptions`, `CreateGroupOptions` (8), `AddParticipantsOptions`, `MembershipRequestActionOptions`, `CreateChannelOptions`, `SearchChannelsOptions`, `MessageSendChannelOptions`, `MessageSearchOptions`, `PollSendOptions`, `ScheduledEventSendOptions`, `LocationSendOptions`, `MediaFromURLOptions`, `UnsubscribeOptions`, `TransferChannelOwnershipOptions`, `ClientOptions` (config-level options map to env; `evalOnNewDoc`, `authStrategy` → `unsupported: internal`).
- **Events**: all 31 in §2.5.
- `Buttons`, `List`: see §1.

**Mechanism (`tests/parity/`)**
1. A test reads `node_modules/whatsapp-web.js/index.d.ts` with the TypeScript compiler API and extracts every exported class/interface member.
2. Covered symbols come from (a) `@WaOperation.wwebjs` links discovered via the registry, (b) `src/parity/overrides.ts` (`unsupported` symbols each WITH a reason), (c) event names ↔ `WA_EVENT_NAMES`, (d) DTO schema field names.
3. The test **fails** if any symbol is neither covered nor explicitly unsupported-with-reason, or if an override references a symbol that no longer exists. Upgrading the library forces a conscious decision for every new/removed member.
4. `scripts/gen-docs.ts` renders `docs/parity-matrix.md` from the same data (symbol → operation id → REST path → socket command, or → unsupported + reason). CI fails if the committed file differs from regenerated output.

### 6.13 Documentation is a deliverable, enforced by CI
**Rule: nothing exists in this system without documentation.** Every route, socket command, event, error code, env var, metric, DTO field, policy rule, operational procedure and architectural decision is documented in the repository, in English, with a runnable example where one makes sense. Documentation lands in the SAME PR as the behavior (PR template checklist, §2.6.8) and is enforced by tests, not by good will.

**What is documented, where, and how it is enforced**

| Subject | Document | Origin | Enforcement |
|---|---|---|---|
| Every REST route and DTO | `openapi.json`, `/docs` (Swagger UI), `operations-list.md` | GENERATED from controllers + Zod (`@nestjs/swagger`) | test fails if any `@WaOperation` lacks `summary`, `description`, `examples.request/response`, `errors`, `wwebjs` links (or `gateway: true`), or any Zod field lacks `.describe(...)`; `validate:docs` diff |
| Every socket command | `websocket-commands.md` | GENERATED from `@WaOperation.socket` | `validate:docs` diff |
| Every event (wwebjs + synthesized: `session_status`, `message_batch`, `message_sent`, `message_failed`, `session_error`, `chat_suppressed`, `chat_unreachable`, `ping`) incl. `message_reaction` | `events.md` | GENERATED from the Zod payload schemas (when it fires, fields, JSON example) | test: every name in `WA_EVENT_NAMES` + synthesized list appears; `validate:docs` diff |
| Every wwebjs symbol | `parity-matrix.md` | GENERATED | parity test + `validate:docs` diff |
| Every error code | `errors.md` | GENERATED from `common/errors.ts` (status, meaning, operations that can return it) | test: every code present |
| Every env var | `config-reference.md` | GENERATED from `env.schema.ts` (`.describe()` is mandatory on each var) | `validate:env` (.env.example) + test: every var present |
| Every Prometheus series | `metrics.md` | GENERATED from the metric definitions in `src/infra/metrics` | test: every registered series present |
| Event/ordering/safety behavior | `ordering.md`, `origin.md`, `safety.md`, `reactions-and-receipts.md` | hand-written | test: each env var of its feature (§6.4, §6.6.1, §6.8.1) is mentioned in its guide |
| Decisions and their why | `adr/NNNN-*.md` | hand-written, one per decision | test: ADR files follow the template (Context / Decision / Consequences / Alternatives) |

**Hand-written guides (all REQUIRED, each with runnable `curl` + Node examples; no `TODO`/`TBD`/placeholder text):**
- `getting-started` (zero → first message in 10 minutes), `architecture` (diagram + data flow + module map), `authentication` (admin key, session-scoped keys, permission scopes, expiry and rotation, IP allowlist, socket auth, a worked example of wiring a plugin such as a Crisp one), `sessions` (QR flow, pairing-code flow, status machine, reconnection, restore on boot, watchdog), `messages` (every message type, humanize, idempotency, queue semantics, sync vs async results, quoting, mentions, media sources), `reactions-and-receipts` (the `message_reaction` event and `Reaction` fields incl. `orphan`, `GET …/reactions`, `POST …/react`, ack levels −1…4, `GET …/messages/:id/info`), `ordering` (§6.4: algorithm, knobs, `message_batch`, 1-second limit, recommended consumer pattern), `origin` (§6.6.1: `origin` and `raw`, Meta Click-to-WhatsApp, field table, stability caveat), `safety` (§6.8.1: every policy rule with its env vars and defaults, warm-up plan, suppression, unreachable flag, what is NOT guaranteed, operational checklist), `websocket` (handshake auth, subscribe, commands, replay, backpressure, the typing example), `webhooks` (outbound envelope, delivery semantics, `seq` ordering, signature verification in Node/Python/PHP, SSRF allowlist, dead letters and replay, inbound hooks), `limits` (library hard limits incl. no incoming typing; 1 s timestamps; payload/size limits), `operations` (health/readiness, metrics usage, suggested alert rules, watchdog behavior), `troubleshooting` (symptom → cause → fix table: session stuck in `qr`, `DEPRECATED_VERSION`, webhooks failing, ordering surprises, policy rejections…), `faq`.
- Project and operations: `development` (toolchain, bootstrap, scripts, Git hooks, commit convention, CI jobs and how to reproduce them locally, Claude Code hooks), `contributing` (branch/PR flow), `repository-settings` (ruleset, plan limitation, secrets), `deploy-vps`, `deploy-railway`, `backup-restore`, `upgrading` (incident runbook of §6.14).
- **ADRs** (`docs/adr/0001-….md` …): at minimum — NestJS + Fastify adapter; Prisma 7; single instance; `whatsapp-web.js` over Baileys (with the comparison); `@WaOperation` registry; ordering buffer + `message_batch`; persistent send queue + idempotency; send policy and cold-send default-off; WA Web version pinning; `raw`/`origin`; pnpm/Jest/TypeScript 5.9 alignment with `omnichannel-platform`; ruleset/protection strategy; API-key model (scopes, expiry, rotation, CIDR) and the rejected alternatives (OAuth2 client-credentials, mTLS, per-request JWT); no built-in admin UI (separate project) and Bull Board for queues; single package now with the migration path to a pnpm-workspace monorepo (`apps/api` + `apps/web` + a generated API client). Each follows Context / Decision / Consequences / Alternatives considered.

**Docs tests (`tests/parity/docs.spec.ts`, run in `unit-tests` and by `validate:docs`):** (1) every generated file equals a fresh generation; (2) each hand-written guide in the list above exists and is non-empty; (3) no guide of the required-guide manifest nor generated file contains `TODO`, `TBD`, `FIXME`, `lorem`, or an empty code block (`docs/TDD.md`, `docs/IMPLEMENTATION_PLAN.md` and `docs/adr/` are excluded: they quote those words as rules); (4) every relative Markdown link and anchor resolves; (5) every `curl` example in the guides targets a route that exists in the registry; (6) every `@WaOperation` id appears in `operations-list.md`; (7) every env var, error code, event name and metric name appears in its generated reference AND the env vars of features appear in the feature guide; (8) the README links every guide. A missing or stale document fails CI.

### 6.14 Deployment, durability & operations
**Single instance.** The Dockerfile is identical for both targets; `docker-entrypoint.sh` runs `prisma migrate deploy` then starts Node.

- **VPS (recommended for cost/RAM)** — `docs/deploy-vps.md`: ≥ 4 GB RAM (≈ 400 MB per session + headroom; size by `MAX_SESSIONS`), `docker-compose.prod.yml` (api + postgres + redis with AOF), Caddy (`deploy/Caddyfile`) for TLS + WebSocket, `restart: unless-stopped`, `shm_size: 1gb`, ufw (80/443 only), unattended upgrades, daily `deploy/backup-sessions.sh` (tar of `/data/wwebjs_auth` and `/data/wwebjs_cache` — the cache holds the known-good WhatsApp Web snapshot you pinned — + `pg_dump`) with off-box copy, log rotation.
- **Railway** — `docs/deploy-railway.md`: one service from the Dockerfile with **replicas = 1**, a persistent Volume at `/data`, Railway Postgres + Redis (persistence on), memory sizing, health check `/ready`, env var table, note that deploys cause a brief restart + staggered session restore, Volume snapshot procedure.
- **Persistence rules:** `/data/wwebjs_auth` is the account credential store — losing it means re-scanning QRs. Redis runs with AOF so queued sends/deliveries survive restarts. README states RPO/RTO expectations.
- **Boot order (`main.ts`)**: validate env → Nest bootstrap (Prisma connects with retry/backoff, Redis connects with retry) → start BullMQ processors → listen → `/ready` true → `SessionManager.restoreAll()` staggered → pipeline re-feeds held messages. If pg/redis go down at runtime: `/ready` → 503, `/health` stays 200; processors resume automatically (`maxRetriesPerRequest: null`).
- **Process guards:** `unhandledRejection`/`uncaughtException` log fatal with context; known wwebjs/Puppeteer error signatures are attributed to the owning session and trigger that session's reconnect instead of exiting; anything else exits non-zero so the supervisor restarts cleanly.
- **Graceful shutdown (`enableShutdownHooks`, SIGTERM/SIGINT):** mark `/ready` false, stop accepting HTTP, flush order buffers (publish held messages), drain in-flight sends (≤ 20 s), close Socket.IO, pause+close BullMQ workers, destroy sessions without logout, close Prisma/Redis; hard-exit timer 30 s.
- **Library breakage & recovery (WhatsApp Web changes, new `whatsapp-web.js` release):** `docs/upgrading.md` is an incident runbook with three escalating levels, fastest first:
  1. **Level 1 — switch the WhatsApp Web version, no rebuild (minutes).** The library loads a pinned WA Web build (`ClientOptions.webVersion` + `webVersionCache`). The gateway reads `WWEB_VERSION`, `WWEB_VERSION_CACHE_TYPE` (`local` | `remote` | `none`) and `WWEB_VERSION_REMOTE_PATH` from env, so changing them in the deploy environment and restarting is enough (sessions on the volume come back without a QR). The runbook says how to find a known-good WA Web version and how to roll back to the previous value.
  2. **Level 2 — bump `whatsapp-web.js` (≈ CI time + deploy).** Branch `chore/bump-wwebjs`, change the pin, run `pnpm install`; the PARITY test fails on any added/removed symbol until it is mapped or marked unsupported; unit + integration suites; staging session smoke test (`E2E_REAL=1`) on a spare number; PR → CI → merge → deploy. Rollback = redeploy the previous image tag (images are tagged with the git SHA and the library version).
  3. **Level 3 — degrade safely.** If neither works, the API, queue, webhooks and Socket.IO stay up; sessions sit in `failed`/`disconnected` with `last_error`; accepted sends wait in the persistent queue until `SEND_MAX_WAIT_MS` (then `message_failed`, so consumers can retry); nothing is lost on the inbound side because WhatsApp delivers pending messages when the session reconnects (the order buffer and reconciler of §6.4 absorb the burst).
- **Detection and notification:** the watchdog (§6.5) turns "library broken" into a visible state instead of silence: sessions stuck in `starting`/`authenticating`, `WAState` of `DEPRECATED_VERSION`/`UNPAIRED`/`TOS_BLOCK`, or N consecutive `getState()` failures publish `session_error` (webhook + socket) and increment `gw_watchdog_restarts_total`; `/v1/system/info` reports per-session status, wwebjs version and WA Web version; `docs/operations.md` ships alert rules for "no session `ready` for 5 min" and "restarts > 3 in 10 min".
- **Release watch:** `.github/workflows/wwebjs-watch.yml` (cron daily + manual): compares the pinned `whatsapp-web.js` version with `npm view whatsapp-web.js version` and the latest GitHub release of `wwebjs/whatsapp-web.js`; when newer it opens or updates ONE issue ("whatsapp-web.js X is available") with the release notes link and the Level 2 checklist. Dependabot ignores this package on purpose (§2.6.8); the issue is the notification, the upgrade stays a deliberate PR.

### 6.15 Environment variables (`.env.example` contains ALL, each commented and documented in `docs/`)

Core: `NODE_ENV`, `HOST`(0.0.0.0), `PORT`(3000), `PUBLIC_BASE_URL`, `LOG_LEVEL`(info), `DATABASE_URL`, `REDIS_URL`, `ADMIN_API_KEY`(≥32), `METRICS_TOKEN`(optional), `API_KEY_ROTATION_GRACE_MINUTES`(10), `API_KEY_MAX_TTL_DAYS`(0 = no cap), `TRUST_PROXY_HOPS`(0), `BULL_BOARD_ENABLED`(false), `CORS_ORIGINS`, `RATE_LIMIT_MAX`(300), `ENABLE_DOCS`(true in development and tests; **false in production** — the deployed instance is private, there is no public demo and no public Swagger UI; the committed `docs/openapi.json` and the guides are the public reference).
WhatsApp: `WWEBJS_DATA_PATH`(./.wwebjs_auth), `PUPPETEER_EXECUTABLE_PATH`, `WWEB_VERSION`(optional pin), `WWEB_VERSION_CACHE_TYPE`(local|remote|none), `WWEB_CACHE_PATH`(/data/wwebjs_cache in Docker: the HTML snapshots of WhatsApp Web versions, on the persistent volume), `WWEB_VERSION_REMOTE_PATH`(required when type is remote; contains the `{version}` placeholder), `WWEB_VERSION_STRICT`(true: a pinned version that cannot be loaded fails the session start loudly instead of silently running the live latest build), `QR_MAX_RETRIES`(6), `TAKEOVER_ON_CONFLICT`(false), `DEVICE_NAME`, `BROWSER_NAME`, `PROXY_URL`(optional), `WA_CALL_TIMEOUT_MS`(60000), `FFMPEG_PATH`.
Sessions: `MAX_SESSIONS`(10), `SESSION_START_STAGGER_MS`(5000), `SESSION_START_TIMEOUT_MS`(180000), `SESSION_RECONNECT_MAX_ATTEMPTS`(0=unlimited), `WATCHDOG_INTERVAL_MS`(30000), `WATCHDOG_MAX_FAILURES`(3), `MEMORY_RESTART_THRESHOLD_MB`(0).
Ordering & reconciliation: `INBOUND_ORDERING_ENABLED`(true), `INBOUND_LATE_THRESHOLD_S`(3), `INBOUND_ORDER_WINDOW_MS`(1500), `INBOUND_ORDER_MAX_HOLD_MS`(5000), `INBOUND_ORDER_MAX_MESSAGES`(200), `MESSAGE_BATCH_ENABLED`(true), `RECONCILE_ON_READY`(true), `RECONCILE_MAX_CHATS`(50), `RECONCILE_FETCH_LIMIT`(50), `RECONCILE_LOOKBACK_HOURS`(48).
Message data: `INCLUDE_RAW`(true), `RAW_MAX_FIELD_BYTES`(8192).
Sending: `SEND_MIN_INTERVAL_MS`(1000), `SEND_JITTER_MS`(400), `SEND_SYNC_TIMEOUT_MS`(60000), `SEND_MAX_WAIT_MS`(300000), `SEND_NOT_READY_RETRY_MS`(5000), `SEND_BREAKER_THRESHOLD`(5), `SEND_BREAKER_COOLDOWN_MS`(60000), `MAX_MEDIA_BYTES`(33554432).
Send policy (§6.8.1; all overridable per session): `CONVERSATION_WINDOW_HOURS`(24), `ALLOW_COLD_SENDS`(false), `COLD_SENDS_PER_DAY`(20), `COLD_SEND_MIN_GAP_MS`(60000), `LOOKUPS_PER_DAY`(100), `PER_CHAT_MIN_INTERVAL_MS`(1500), `PER_CHAT_MAX_PER_MINUTE`(10), `SESSION_MAX_PER_MINUTE`(20), `SESSION_MAX_PER_HOUR`(300), `SESSION_MAX_PER_DAY`(1500), `DUPLICATE_RECIPIENTS_THRESHOLD`(5), `DUPLICATE_WINDOW_MINUTES`(10), `WARMUP_DAYS`(14), `WARMUP_START_FRACTION`(0.1), `UNREACHABLE_STREAK`(5), `UNREACHABLE_MIN_AGE_HOURS`(72), `SEND_POLICY_MAX_WAIT_MS`(1800000), `HEALTH_WINDOW`(50), `HEALTH_MAX_BAD_RATIO`(0.2), `HEALTH_COOLDOWN_MIN`(30), `HUMANIZE_MIN_REPLY_DELAY_MS`(1500).
Events/webhooks: `EVENT_REPLAY_WINDOW_SECONDS`(300), `WEBHOOK_TIMEOUT_MS`(10000), `WEBHOOK_MAX_ATTEMPTS`(10), `WEBHOOK_BACKOFF_MS`(5000), `WEBHOOK_WORKER_CONCURRENCY`(10), `WEBHOOK_INLINE_MEDIA_MAX_BYTES`(5242880), `WEBHOOK_PRIVATE_HOST_ALLOWLIST`, `ALLOW_PRIVATE_WEBHOOK_TARGETS`(false), `CALL_CACHE_SIZE`(50).
Test/build-time only (NOT in `env.schema.ts`): `E2E_REAL`(false; enables the opt-in real-number suite), `PUPPETEER_SKIP_DOWNLOAD`(true in Docker and CI), `HUSKY`(0 in CI and Docker builds).
Retention: `DELIVERY_RETENTION_DAYS`(14), `MESSAGE_RETENTION_DAYS`(30), `STORE_MESSAGE_BODIES`(true).

---

## 7. Step-by-Step Implementation Plan

**Authorization (hard rule, overrides every "commit"/"push"/"PR" wording below):** the agent NEVER runs `git commit`, `git push` or `gh pr create` (nor any merge, rebase, tag or GitHub write) unless the owner explicitly asks for that exact action at that moment; one approval never extends to the next action. Wherever this plan says "commit X", "push" or "open the PR", it describes what the agent PREPARES and PROPOSES (files changed, checks passed, a Conventional Commit message) and then waits. Allowed without asking: editing files, running local checks/tests, `git status/diff/log`, `git init`, creating or switching local branches.

Branching: `main` is protected. Work on `feat/*` branches; when verified, `git push -u origin <branch>` and `gh pr create`, then **STOP** — the owner reviews and squash-merges. Never merge/push to `main`, never `--no-verify`, never force-push. The very first commit (`chore: initial project setup`) is on `main` locally before the remote exists (it is pushed once, at the owner's explicit request, as the single exception to "never push to `main`"); afterwards everything goes through branch + PR. After the owner merges: `git checkout main && git pull`, branch again.

Commit cadence: one commit per logical unit; each new dependency gets its own `chore(deps): add <package>` commit (a package with its `@types/*` companion is one). Conventional Commits only. Steps are numbered `<phase>.<n>` (e.g. 3.5); documentation for a step ships in the same PR.

**PR granularity (decided 2026-10-27):** because the owner squash-merges, a PR is the unit of history, CI, review and revert, so the unit of delivery is the STEP, not the milestone. Commits inside a PR are one per logical unit (one `chore(deps): add <package>` per dependency). One push + PR per step, except that tiny, tightly coupled steps are grouped as listed in `docs/IMPLEMENTATION_PLAN.md` ("PR grouping": **57 PRs** in total). Phase 0 is the exception: steps 0.2–0.10 are ONE PR (`chore/tooling-foundation`) because CI and the hooks arrive inside it, and step 0.1 is a local commit on `main` that precedes it. Branch names: `<type>/<phase>-<n>-<slug>` (e.g. `feat/3-5-order-buffer`); the `feat/...` names in the phase headings below are only the milestone prefix. One PR is open at a time unless the owner asks for stacked branches (after a squash-merge a stacked branch is rebased with `git rebase --onto main <old-base>`, only when the owner asks). The owner's phrases: "commitea" = make this step's commits; "sube y abre PR" = push the branch and `gh pr create`; each is valid for that step only (Authorization rule above).

**Phase 0 — Setup and toolchain (BEFORE any feature code)**. The goal: from the first real commit on, every commit and push is guarded by the same hooks and CI that `omnichannel-platform` has (§2.6).
- **Step 0.1 — `main`, local only:** `git init`; `.gitignore` (§2.6.3); `.nvmrc` (`24.20.0`); propose the commit `chore: initial project setup` (made only when the owner asks); move this TDD to `docs/TDD.md`; create `docs/IMPLEMENTATION_PLAN.md` — the 89 steps of this section as a checklist (grouped by milestone, each with its "Done when") plus a "Progress tracking" table (step, status, PR, date) that every PR updates as its last change. The commits of steps 0.1–0.6 are made before the hooks exist (they are still written as Conventional Commits, and CI's commitlint re-checks them on the PR). **Publishing, only when the owner asks (license already decided: all rights reserved, §11):** create the public repository `eosmin/wwebjs-gateway` and push the initial `main` ONCE — the only direct push to `main` ever (a PR needs a base branch on the remote; this is an explicit, one-time exception to the portfolio rule "never push to `main`"); the ruleset is applied after the first PR's checks have run.
- **Steps 0.2–0.10 — branch `chore/tooling-foundation`** (nine steps, in this order, each passing the hooks installed so far; Context7 before each dependency):
  0.2 `chore(tooling): add pnpm workspace and package manifest` — `package.json` (`packageManager`, `engines`, and only the scripts that already work: each later step adds the scripts of the tool it installs, e.g. `lint` in 0.5; `prepare: husky` and the `lint-staged` block arrive in 0.7, because `pnpm install` runs `prepare` and husky is not installed yet), `pnpm-workspace.yaml`, lockfile. Every tool a step installs (prettier, eslint, jest, husky, tsx, zod, prisma…) is added in that step with its own `chore(deps): add <package>` commit.
  0.3 dependencies and Nest scaffold — one `chore(deps): add <package>` commit PER dependency (the portfolio rule; a package and its `@types/*` companion count as one) for exactly what the scaffold needs: `@nestjs/core`, `@nestjs/common`, `@nestjs/platform-fastify`, `fastify`, `reflect-metadata`, `rxjs`, `@nestjs/cli`, `typescript`, `@types/node`; then `chore(app): add nest scaffold on the fastify adapter` — `nest-cli.json`, `tsconfig*.json`, `AppModule` with `GET /health` only. Every later phase adds its own dependencies the same way, each in its own commit.
  0.4 `chore(tooling): add prettier and editor settings` — `.prettierrc`, `.prettierignore`, `.vscode/settings.json`; run `pnpm format` once.
  0.5 `chore(tooling): add eslint flat config` — §2.6.4; `pnpm lint` must pass on the scaffold.
  0.6 `chore(tooling): add jest with coverage gates` — `jest.config.cts`, `jest.integration.config.cts`, `tsconfig.spec.json`, one health-endpoint spec.
  0.7 `chore(tooling): add husky, lint-staged, commitlint and gitleaks` — §2.6.5. **From this commit on every commit runs `pre-commit` and `commit-msg`.** Verify WITHOUT running `git commit` (Authorization rule): pipe a bad message and a good one into `pnpm exec commitlint` (exit non-zero / zero); run `gitleaks dir` on a temporary directory in the scratchpad that contains a fake secret (exit non-zero) and on the repository (exit zero); the first real commit the owner asks for after this step then exercises `pre-commit` and `commit-msg` end to end, and the agent reports their output.
  0.8 `chore(tooling): add validators` — Appendix A scripts: `validate-deprecations`, `validate-env-example`, `check-rollbacks`, `validate-affected`, `smoke-http`, `bootstrap.sh`; wire `pre-push`. Their scope in Phase 0 (they must pass on the scaffold and grow with the code): a MINIMAL `src/config/env.schema.ts` (`NODE_ENV`, `HOST`, `PORT`, `LOG_LEVEL`, `DATABASE_URL`, `REDIS_URL`, `ADMIN_API_KEY`, `METRICS_TOKEN`; Phase 1 completes it) with a matching `.env.example` (placeholders that satisfy the schema: `ADMIN_API_KEY` ≥ 32 characters, non-empty `METRICS_TOKEN`); a MINIMAL `scripts/gen-docs.ts` that already generates `docs/config-reference.md` from the env schema and supports `--check` (later phases add the other generated files) plus a minimal `tests/parity/docs.spec.ts` (generated files up to date, no `TODO`/`TBD`; its required-guide manifest starts with the guides that exist and grows every phase until it is complete in Phase 9); `check-rollbacks` and the CI rollback loop accept an empty `prisma/migrations/` (`.gitkeep`); `smoke-http` checks `GET /health` only — step 4.7 extends it. The dependencies this step needs (`zod`, `tsx`) are added first, one `chore(deps)` commit each.
  0.9 `ci: add pipeline, dependabot and pull request template` — §2.6.7–2.6.8, plus `deploy/github-ruleset.json`; `prisma/schema.prisma` with only `generator` and `datasource` (no models yet — confirm via Context7 that Prisma 7 `generate` accepts an empty schema, otherwise add the smallest real model needed), `prisma.config.ts`, empty `prisma/migrations/` and `prisma/rollbacks/` (`.gitkeep`); a `README.md` skeleton (what the project is, the unofficial/ToS disclaimer, that the production instance is private, links into `docs/`) and `SECURITY.md`, and a MINIMAL `Dockerfile` + `docker-entrypoint.sh` + `docker-compose.yml` (api + postgres + redis, so `docker compose up` already brings the project up), preceded by one `chore(deps)` commit each for `prisma` and `@prisma/client` (`pnpm db:generate` needs them; `@prisma/adapter-pg` and `pg` arrive in step 2.3), so all four CI jobs are green on the very first PR. In Phase 0 the scaffold only has `GET /health`: `prisma migrate deploy` is a no-op on zero migrations and the CI boot and image checks curl `/health` (the YAML of §2.6.7 shows the final `/ready` form; step 4.7 switches to it when `/ready` really pings Postgres and Redis). Phase 11 hardens the Docker files; it does not create them.
  0.10 `chore(tooling): add claude code hooks, settings and the code-reviewer subagent` — §2.6.9. The same PR carries the first ADRs in `docs/adr/` (template of §6.13): 0001 NestJS on the Fastify adapter, 0002 toolchain mirrored from `omnichannel-platform` (pnpm 11, Jest, TypeScript 5.9), 0003 public repository and the `protect-main` ruleset, 0004 `whatsapp-web.js` over Baileys.
  When — and only when — the owner explicitly asks: `git push -u origin chore/tooling-foundation` and `gh pr create`; then wait for the four CI checks to be GREEN on the PR, and STOP for the owner's squash-merge. The owner applies the repository ruleset (`deploy/github-ruleset.json`, §2.6.8) once these checks have run at least once; this PR also adds that JSON file.
- Only after Phase 0 is merged does Phase 1 begin. Coverage thresholds **lines/functions/statements 80, branches 75** apply from step 0.6 on (the scaffold must meet them); exclusions only `src/whatsapp/wwebjs-adapter.ts` and `src/main.ts`, each justified in a comment.

**Phase 1 — `feat/foundation`** (Milestone 1, steps 1.1–1.5; each with unit tests and its docs in the same PR):
- 1.1 `config/*`: the full `env.schema.ts` for every variable of §6.15 (each with `.describe()`), `AppConfig`; `.env.example` and `docs/config-reference.md` regenerate.
- 1.2 `common/errors.ts` (+ generator of `docs/errors.md`).
- 1.3 `types/{events,dto}.ts` (every event payload and DTO schema).
- 1.4 `common/lib/{crypto,wa-id,timeout,retry,throttle,token-bucket,humanize,ssrf}.ts`.
- 1.5 `infra/*`: Redis factory (`maxRetriesPerRequest: null`), logger with redaction, metrics (+ generator of `docs/metrics.md`).

**Phase 2 — `feat/database`** (Milestone 2, steps 2.1–2.4; integration tests against the compose Postgres):
- 2.1 `prisma/schema.prisma` with every model of §5.3 (`prisma.config.ts` already exists since Phase 0).
- 2.2 the first real migration and its rollback script in `prisma/rollbacks/`.
- 2.3 `prisma.service.ts` (driver adapter, lifecycle hooks).
- 2.4 repositories (api-keys, sessions, webhooks, deliveries, inbound-hooks, messages, idempotency, suppressions).

**Phase 3 — `feat/whatsapp-core`** (Milestone 3, steps 3.1–3.10):
- 3.1 `whatsapp-client.port.ts` (full surface).
- 3.2 `mappers.ts` (+ `extractOrigin`, `sanitizeRaw`; unit tests with fixtures).
- 3.3 `event-bus.service.ts`.
- 3.4 `tests/helpers/fake-whatsapp-client.ts`.
- 3.5 `inbound-order-buffer.ts` (tests: normal chat zero-latency, late burst reorder by `sentAt`, same-second tie-break via canonical order, max-hold/max-messages flush, real-time message joining an open buffer, held acks released after their message, batch emission, flush on shutdown).
- 3.6 `event-pipeline.service.ts` (dedupe, store, order, monotonic `seq`, crash recovery of `emittedAt IS NULL`).
- 3.7 `session-manager.service.ts`.
- 3.8 `watchdog.service.ts`.
- 3.9 `reconciler.service.ts` (tests: recovers missing messages, no duplicates, respects lookback).
- 3.10 `wwebjs-adapter.ts` LAST, plus the `whatsapp-web.js` pin (its own `chore(deps)` commit) and `.github/workflows/wwebjs-watch.yml` (§6.14 release watch).

**Phase 4 — `feat/api-core`** (Milestone 4, steps 4.1–4.8; integration tests via `@nestjs/testing` + Fastify `inject`). After this phase the server boots, creates a session and serves a QR:
- 4.1 `auth.service.ts` + `api-key.guard.ts` (session scope, permission scopes, expiry, CIDR allowlist; tests for each of `INSUFFICIENT_SCOPE`, `API_KEY_EXPIRED`, `IP_NOT_ALLOWED`, revocation cache).
- 4.2 filters/interceptors (error contract, request id, metrics, timeout).
- 4.3 `@WaOperation` decorator + `operation-registry.service.ts`.
- 4.4 Swagger / nestjs-zod wiring.
- 4.5 `system`, `health` (`/health`, `/ready` pinging Postgres and Redis, `/metrics`) and `api-keys` controllers (incl. `rotate` with its grace period and the `scope` metadata of every operation).
- 4.6 `sessions` and `qr` controllers.
- 4.7 `main.ts` finalized (process guards, shutdown hooks) and `smoke-http` + the CI boot/image checks extended from `/health` to `/ready`, `/metrics` and the error contract.
- 4.8 `tests/parity/` skeleton (expected-failures list shrinks each phase; must be empty by Phase 9).

**Phase 5 — `feat/messaging`** (Milestone 5, steps 5.1–5.10):
- 5.1 `send-policy.service.ts` (§6.8.1). Tests: open-conversation vs cold classification, cold sends blocked by default, token buckets delay instead of fail, per-chat pacing, duplicate-content guard, warm-up ramp, suppression via API/opt-out, an OFFLINE recipient (ack stuck at 1 for hours) is never flagged or suppressed while the contact wrote recently, the unreachable flag appears only after 72 h of silence + 5 undelivered and clears on an incoming message, health throttle counts only hard failures, halves budgets, keeps jobs queued and recovers, `POLICY_DELAY_EXCEEDED` after the max wait, quiet hours delay cold sends only.
- 5.2 `send-queue.service.ts` and the Bull Board mount (`/admin/queues`, admin-only, behind `BULL_BOARD_ENABLED`; queues register themselves as they are created — send queues here, the delivery and retention queues in 7.4–7.5). Tests: ordering per session, idempotency replay/conflict, restart durability with Redis, `UNKNOWN_OUTCOME` no-double-send, humanize state always cleared, circuit breaker, sync→202 fallback.
- 5.3 `message-store.service.ts`.
- 5.4 idempotency flow (repository use + 24 h purge).
- 5.5 `messages` controller (send, reply, react, forward, star, pin, edit, delete, media, receipts; tests incl. `NUMBER_NOT_ON_WHATSAPP`, SSRF media URL).
- 5.6 `polls-events` controller.
- 5.7 `chats` controller (incl. `chat.state` typing/recording).
- 5.8 presence/profile/settings controller.
- 5.9 `lookup` controller (numbers, lid/phone).
- 5.10 `send-policy` and `suppressions` controllers (gateway-native operations).

**Phase 6 — `feat/contacts-groups-channels`** (Milestone 6, steps 6.1–6.7): 6.1 contacts (incl. business profile, block/unblock, addressbook); 6.2 groups; 6.3 channels; 6.4 labels; 6.5 broadcasts/status; 6.6 calls (ring buffer, link, reject); 6.7 customer notes and remaining Client-level operations (`getInviteInfo`, `acceptInvite`, `syncHistory`, …) until the parity expected-failures list only holds Phase 7–9 items.

**Phase 7 — `feat/outbound-webhooks`** (Milestone 7, steps 7.1–7.6): 7.1 `webhook.service.ts`; 7.2 webhooks controller (CRUD, rotate-secret, test, deliveries, retry, retry-failed); 7.3 `webhook-dispatcher.service.ts`; 7.4 `delivery.processor.ts`; 7.5 `retention.service.ts`; 7.6 `tests/helpers/webhook-receiver.ts` + the integration suite (signature validity, retry-then-success, final failure, disabled webhook, event filter, QR redaction, inline-media modes, `includeRaw`, DB-down still enqueues, SSRF allowlist, retry-failed bulk, `message_batch` delivery).

**Phase 8 — `feat/inbound-and-realtime`** (Milestone 8, steps 8.1–8.3): 8.1 `inbound-hook.service.ts`; 8.2 inbound controller; 8.3 `socket.gateway.ts` (tests with `socket.io-client`: auth failure, scope enforcement, snapshot on subscribe, fan-out, **command round-trip incl. `chat.state` typing**, replay by `seq`, slow-consumer disconnect).

**Phase 9 — `feat/parity-and-docs`** (Milestone 9, steps 9.1–9.6). **From Phase 0 on, documentation is written in the same PR as the behavior** (this phase only closes remaining gaps and turns the strict checks on); each earlier phase adds its own guide sections and ADR as it ships:
- 9.1 complete `src/parity/overrides.ts`; parity tests green with an empty expected-failures list.
- 9.2 `scripts/gen-docs.ts` generates every GENERATED file of §6.13 (plus `--check`).
- 9.3 OpenAPI completeness test.
- 9.4 strict docs tests of §6.13 (the required-guide manifest is now complete).
- 9.5 close every hand-written guide of §6.13.
- 9.6 close the ADR set of §6.13.

**Phase 10 — `feat/resilience-tests`** (Milestone 10, steps 10.1–10.10): 10.1 `tests/helpers/chaos.ts`; then one integration scenario per step: 10.2 Redis restart mid-queue; 10.3 Postgres outage; 10.4 webhook consumer 500/timeout storm; 10.5 client crash during send; 10.6 duplicate events after reconnect; 10.7 burst arrival out of order (10 messages shuffled) → emitted in `sentAt` order with correct `seq`; 10.8 crash while a buffer is held, then restart; 10.9 graceful shutdown flushes buffers and drains; 10.10 boot with half-dead dependencies.

**Phase 11 — `feat/docker-deploy`** (Milestone 11, steps 11.1–11.6). The minimal Docker files and the CI pipeline exist since Phase 0; this phase HARDENS them:
- 11.1 `Dockerfile` (multi-stage; build on `node:24.20.0-bookworm-slim` with `corepack enable` and `pnpm install --frozen-lockfile` with `HUSKY=0`; runtime also Debian — NOT Alpine, Chromium needs it — with `chromium` + `fonts-liberation` + `ffmpeg`, non-root user, `PUPPETEER_SKIP_DOWNLOAD=true`, `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`, `HEALTHCHECK` on `/health`, `VOLUME /data`; the `security-scan` job builds, runs and scans it).
- 11.2 `docker-entrypoint.sh` (migrate, then start; signal forwarding).
- 11.3 `docker-compose.yml` (dev: api built from the Dockerfile + postgres + redis, healthchecks, so `docker compose up` brings the whole project to life; `pnpm infra:up` starts only postgres + redis for local `pnpm dev`).
- 11.4 `docker-compose.prod.yml` (api + `postgres:18.6-alpine` + `redis:8.10.1-alpine` with AOF, healthchecks, `depends_on: service_healthy`, `shm_size: 1gb`, named volumes).
- 11.5 `deploy/` files (`Caddyfile`, `backup-sessions.sh`) and the VPS/Railway/backup guides verified end to end.
- 11.6 the `publish` job in `.github/workflows/ci.yml` (GHCR push on `main` only, after the four required checks) and the optional deploy job.

**Phase 12 — `feat/real-e2e`** (Milestone 12, steps 12.1–12.4; opt-in `E2E_REAL=1`, two real numbers):
- 12.1 `tests/e2e-real/` + `scripts/e2e-real.ts`: QR/pairing → ready → send each message type → receive → webhook → socket → typing → group ops → logout.
- 12.2 offline burst ordering on real phones (disable the network on one phone, send 10 messages, reconnect, verify the emitted order and `message_batch`).
- 12.3 **capture a real Click-to-WhatsApp message, finalize `extractOrigin` (§6.6.1) and commit the redacted fixture.**
- 12.4 record the Buttons/List decision; finalize the README (architecture diagram, quickstart, disclaimer, links to every guide, RPO/RTO, repository-settings decision).

**Totals: 13 milestones (Phase 0 to Phase 12), 89 numbered steps** — Phase 0: 10 (0.1–0.10), Phase 1: 5, Phase 2: 4, Phase 3: 10, Phase 4: 8, Phase 5: 10, Phase 6: 7, Phase 7: 6, Phase 8: 3, Phase 9: 6, Phase 10: 10, Phase 11: 6, Phase 12: 4. One PR per step or per small group of steps (**57 PRs**, see "PR granularity" above and the grouping table in `docs/IMPLEMENTATION_PLAN.md`; step 0.1 is the only local commit on `main`). Several steps contain more than one commit (e.g. one `chore(deps): add <package>` commit per dependency).

---

## 8. Context7 Usage (required)
Before writing code that touches a library fetch current docs: (1) load skill `context7-mcp`; (2) `resolve-library-id`; (3) `query-docs` with the specific use case. Docs are the source of truth, not training data. Known IDs: `/wwebjs/whatsapp-web.js`, `/fastify/fastify` (v5.x), `/taskforcesh/bullmq`. Resolve the rest yourself (`@nestjs/*`, `nestjs-zod`, `prisma`/`@prisma/client`/`@prisma/adapter-pg`, `zod`, `socket.io`, `@prometheus-io/client`, `jest`/`ts-jest`, `typescript-eslint`, `husky`/`lint-staged`/`commitlint`, `pnpm` 11 `allowBuilds`, `nestjs-pino`). Prisma 7 and NestJS 12 are recent: never code from memory of older majors. Not needed for core TS syntax, Git, general patterns. If upstream docs disagree with §2.5, STOP, fix the TDD first, flag it to the owner.

---

## 9. Design Principles & Quality Standards (non-negotiable)

**Principles:** DRY (one `@WaOperation` per capability drives REST + socket + OpenAPI + parity + docs; one `assertSessionAccess`; one event catalogue; one send schema shared by REST/inbound/socket), KISS (use Nest idioms plainly; no custom DI tricks), YAGNI (see non-goals; but reliability features in §6 are requirements), SOLID (everything depends on `WhatsAppClientPort`; repositories wrap Prisma so services never touch `PrismaClient`; one responsibility per provider; no logic in constructors; composition over inheritance).

**Type safety:** `any` forbidden (`unknown` + Zod narrowing); `// @ts-ignore` banned (use `// @ts-expect-error: <reason>`); `as any` banned; `as unknown as T` only at documented boundaries; explicit return types on exported functions; Zod at every external boundary (HTTP, socket, env, inbound hooks; wwebjs payloads via mappers).

**Comment discipline:** comment only non-obvious decisions (hidden constraints, workarounds, subtle invariants). Do NOT write `TDD §X.Y` citations unless stripping the citation removes an unverifiable claim.

**Definition of done (every item required):**
- [ ] Parity test green: every wwebjs 1.34.7 symbol covered or `unsupported` with reason
- [ ] ABSOLUTELY everything documented (§6.13): OpenAPI, generated references (events, errors, config, metrics, operations, socket commands, parity), all hand-written guides and ADRs; docs drift/completeness/link tests green
- [ ] Offline-burst ordering proven (unit, integration, and real-number test); `message_batch` documented
- [ ] `origin` finalized against a real Click-to-WhatsApp message fixture
- [ ] Coverage ≥ 80% lines/functions/statements, ≥ 75% branches (CI gate)
- [ ] Resilience suite (Phase 10) green
- [ ] `docker compose up` brings up api + postgres + redis, healthy; prod compose documented
- [ ] CI green: lint → docs → test → build (→ deploy)
- [ ] `.env.example` documents every variable in §6.15
- [ ] Metrics endpoint exposes the series in §6.11; suggested alert rules in `docs/operations.md`
- [ ] VPS and Railway guides tested at least once end-to-end
- [ ] Real-number smoke test (`E2E_REAL=1`) passed and recorded
- [ ] Husky hooks active from the first feature commit; no commit or push ever used `--no-verify`; gitleaks clean on the whole history
- [ ] CI green on all four required checks (`lint-and-types`, `unit-tests`, `integration-tests`, `security-scan`); the `protect-main` ruleset applied with them (or the plan limitation of §2.6.8 recorded in the README)
- [ ] Conventional Commits (commitlint on commits AND the PR title); `main` protected; all changes via PRs; no secrets in any commit; deprecation scan clean

---

## 10. Security Checklist
**Public-repository hygiene (the repo is public — everything committed is world-readable, forever):**
- Never commit real phone numbers, chat ids, message bodies, push names, QR codes, session data, API keys, webhook secrets, hostnames or IPs of the real deployment. Fixtures (`tests/fixtures/`, including the Click-to-WhatsApp capture of step 12.3) are REDACTED before they are staged: phone numbers and ids replaced with obviously fake ones (`5215500000001@c.us`), names and text replaced, media removed, URLs rewritten to `example.com`; a unit test scans `tests/fixtures/` for patterns that look like real numbers and fails on a hit.
- All examples in docs, `.env.example` and `deploy/` use placeholders (`example.com`, `changeme`-style values that still satisfy the schema). `deploy/` never contains the real Caddy hostname.
- A `SECURITY.md` explains how to report vulnerabilities privately (GitHub private vulnerability reporting). The license is "all rights reserved" (decided 2026-10-27, §11): the root `LICENSE` file states it, and the README repeats it in one line. Do not add any open-source license file or SPDX header.
- The README states clearly what the project is (unofficial, ToS risk) and that the production instance is private.

- API keys hashed at rest; constant-time comparison for the admin key and HMAC verification examples.
- SSRF guard on webhook URLs and `media.url` (DNS-resolved, rejects loopback/link-local/private/ULA/metadata, re-checked every attempt, `redirect: 'error'`), with an explicit private-host allowlist for own-network consumers.
- No raw Puppeteer/`evaluate` exposure (RCE vector). Session scoping per key. Socket commands go through the same authorization as REST.
- Webhook signing with per-webhook secret + timestamp (replay window documented).
- No QR/secret/token/key in logs or in persisted delivery payloads; pino redaction configured and unit-tested. `raw` payloads are sanitized and size-capped.
- Rate limits on all routes; stricter on inbound.
- Container non-root; `/data` is the only persistent writable path; Chromium flags documented.
- `.wwebjs_auth` equals account credentials: encrypted-at-rest volume recommended, backups protected, never committed (README warning).
- Message bodies and `raw`/`origin` are personal data: `STORE_MESSAGE_BODIES`, `INCLUDE_RAW` and retention knobs documented; operators responsible for compliance.

---

## 11. Decisions log (read before starting; ask the owner for every PENDING item at the stated moment — never assume)

**Decided by the owner:**
- **Repository:** PUBLIC, `eosmin/wwebjs-gateway` (decided 2026-10-27). Consequences: `protect-main` ruleset is enforced for free (§2.6.8); the public-repository hygiene rules of §10 apply from the first commit.
- **Production instance, demo and visuals:** PRIVATE. No live demo, no public Swagger UI in production (`ENABLE_DOCS=false`), no screenshots in the README. This is an intentional deviation from the portfolio-wide standards "Live Demo" and "README screenshots" in the root `CLAUDE.md`; every other quality standard (tests > 70% — here 80%, CI/CD, Docker, `.env.example`, no secrets, Conventional Commits, protected `main`) is met.
- **Repository name:** `wwebjs-gateway`.
- **License:** all rights reserved (decided 2026-10-27). A root `LICENSE` file states "Copyright (c) 2026 Erick Monjaras (eosmin). All rights reserved." with no grant of rights; `package.json` uses `"license": "UNLICENSED"` and `"private": true`.
- **Module format:** ESM (decided 2026-10-27, step 0.3); see the note in §2.
- Technology and design decisions (NestJS + Fastify adapter, Prisma 7, single instance, `whatsapp-web.js` over Baileys, ordering buffer + `message_batch`, persistent send queue, send policy, WA Web version pinning, toolchain mirrored from `omnichannel-platform`) are in §2, §6 and become ADRs (§6.13).

**PENDING — ask the owner at the stated moment:**
| Item | Needed before | Note |
|---|---|---|
| Hosting: own VPS or Railway | step 11.5 | Guides are written for both until decided; the optional deploy job (11.6) waits for it |
| Two real WhatsApp numbers/phones for tests, and a real Meta Click-to-WhatsApp ad message | steps 12.1–12.3 | The ad capture finalizes `extractOrigin`; the fixture is redacted per §10 |

**VERIFY while building (not owner decisions; use Context7/the registry and record the result in the matching ADR or guide):** TypeScript 5.9 with Nest decorators and the Jest transform; ESM vs CJS output for Nest 12 + Prisma 7 + Jest; whether `prisma generate` accepts a schema without models; the exact pnpm 11 `allowBuilds` syntax; the `@prometheus-io/client` API; `nestjs-zod` with `@nestjs/swagger`; where archived WhatsApp Web version HTML files are hosted today and the `remotePath` format; the exact GitHub ruleset payload schema; the local global `pnpm` is 12.x while the project pins 11.25.0 (confirm corepack/`packageManager` switches it).
