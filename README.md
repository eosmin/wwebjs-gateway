# wwebjs-gateway

A self-hosted HTTP gateway for [`whatsapp-web.js`](https://github.com/wwebjs/whatsapp-web.js). It
is meant to expose the whole public API of the library over REST, Socket.IO and webhooks, with
several WhatsApp sessions in one process. Built with NestJS on Fastify, Prisma and PostgreSQL,
Redis and BullMQ, in strict TypeScript.

> **Status: under construction.** The repository holds the toolchain, the CI pipeline and a service
> that answers `GET /health`. The gateway itself is built step by step following
> [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md); the design it follows is
> [`docs/TDD.md`](docs/TDD.md). Nothing in this README describes a capability that does not exist
> yet.

## Read this before using it

- **It is unofficial.** `whatsapp-web.js` automates WhatsApp Web. Automating an account can
  violate WhatsApp's Terms of Service and can get a number banned. The intended use is
  legitimate, consent-based conversations and chatbots: no spam, no mass messaging. You use it at
  your own risk. For anything critical (notifications, billing, authentication codes), use the
  official route, the WhatsApp Business Platform (Cloud API), and keep this gateway for the
  conversational part; see [`docs/operations.md`](docs/operations.md).
- **The production instance is private.** There is no live demo, no public API documentation and
  no screenshots, on purpose. This repository only holds the code.
- **Run exactly one replica.** A session's Chromium process belongs to a single Node process, so
  the gateway is a single-instance service by design. Never scale it horizontally.
- **`.wwebjs_auth/` is an account credential.** Whoever has it can use the WhatsApp account. It is
  git-ignored and must never be committed, shared or backed up unprotected.

## Production readiness and risks

What can be said today, without claiming more than was checked:

- **Group writes are off by default.** Creating a group, adding, removing, promoting or demoting participants, revoking an invite link and joining a group (`ENABLE_GROUP_WRITES=false`) answer `403 OPERATION_DISABLED` before WhatsApp is touched. Automating group creation or changes goes against the terms of WhatsApp and can get the account blocked; two disposable test accounts were. Reads, the events of groups, and changing the subject, description and settings of a group or leaving one stay on, and are writes that still carry a risk. See `docs/groups.md`.
- **The official route.** For anything critical the official route is the WhatsApp Business API. This gateway uses an unofficial client: any use with a real number carries a risk of restriction. Never test with the production number.
- **A patch on top of a WhatsApp Web build.** The gateway depends on a patch of `whatsapp-web.js` checked against WhatsApp Web `2.3000.1054445547`; a new build can break it. Pinning a build is not solved (`docs/sessions.md`).
- **What was checked live and what was not**: see "Integration readiness and known limits" in `docs/IMPLEMENTATION_PLAN.md` (10.4).

## Run it

Requirements: Node.js 24, Docker, and [gitleaks](https://github.com/gitleaks/gitleaks)
(`brew install gitleaks`), which the pre-commit hook needs.

```bash
corepack enable
pnpm bootstrap        # installs dependencies and the Git hooks, starts Postgres and Redis
pnpm dev              # the service, on http://localhost:3000
```

Or the whole stack in containers, which builds the image and migrates the database on start:

```bash
docker compose up
```

The compose stack runs with the development credentials of `.env.example` and publishes its ports on
`127.0.0.1` only: it is for a development machine, never for a server.

If a default port is taken, move it: `API_PORT=3001 POSTGRES_PORT=5433 REDIS_PORT=6380 docker compose up`.

`pnpm bootstrap` creates `.env.local` from `.env.example`, with a random `ADMIN_API_KEY` and
`METRICS_TOKEN` instead of the public placeholders. It is git-ignored, and it is the file the
Prisma CLI reads (`pnpm db:migrate` needs it, or a `DATABASE_URL` in your environment).

The environment variables are listed in [`docs/config-reference.md`](docs/config-reference.md),
and [`.env.example`](.env.example) declares all of them.

## Develop

| Command                     | What it does                                                              |
| --------------------------- | ------------------------------------------------------------------------- |
| `pnpm validate:all`         | Everything CI checks, on the whole repository                             |
| `pnpm lint`                 | ESLint with zero warnings allowed                                         |
| `pnpm type-check`           | TypeScript, strict                                                        |
| `pnpm test:cov`             | Unit tests with the coverage gates                                        |
| `pnpm test:integration`     | Integration suites (need `pnpm infra:up`)                                 |
| `pnpm test:integration:cov` | Integration suites with the coverage thresholds of the critical code (CI) |
| `pnpm docs:gen`             | Regenerates the generated docs; `pnpm validate:docs` fails when stale     |

Git hooks run on every commit and push (secret scan, lint, commit message, checks); they are never
bypassed. Commits follow [Conventional Commits](https://www.conventionalcommits.org/).

## Documentation

Every guide lives in [`docs/`](docs/). The files marked generated come from the code by
`pnpm docs:gen` and are never edited by hand; `pnpm validate:docs` fails when one is stale, when an
internal link is broken or when a guide is missing from this list.

**Start here**

- [`docs/getting-started.md`](docs/getting-started.md): from a clone to a first message.
- [`docs/architecture.md`](docs/architecture.md): how the pieces fit and how data moves.
- [`docs/limits.md`](docs/limits.md): what the gateway cannot do, its limits, and what was checked live.
- [`docs/troubleshooting.md`](docs/troubleshooting.md) and [`docs/faq.md`](docs/faq.md): symptom, cause,
  fix, and short answers.

**Using the gateway**

- [`docs/authentication.md`](docs/authentication.md): API keys, scopes, expiry and rotation.
- [`docs/sessions.md`](docs/sessions.md): QR and pairing-code login, status machine, restore on boot.
- [`docs/messages.md`](docs/messages.md): every message type, idempotency, media sources.
- [`docs/send-queue.md`](docs/send-queue.md): the persistent send queue and its results.
- [`docs/safety.md`](docs/safety.md): the send policy, warm-up, suppression.
- [`docs/ordering.md`](docs/ordering.md): inbound ordering and `message_batch`.
- [`docs/reactions-and-receipts.md`](docs/reactions-and-receipts.md): reactions, ack levels and who read a
  message.
- [`docs/origin.md`](docs/origin.md): `origin` (Click-to-WhatsApp) and `raw` on a message.
- [`docs/chats.md`](docs/chats.md), [`docs/contacts.md`](docs/contacts.md),
  [`docs/groups.md`](docs/groups.md), [`docs/channels.md`](docs/channels.md),
  [`docs/labels.md`](docs/labels.md), [`docs/broadcasts.md`](docs/broadcasts.md),
  [`docs/calls.md`](docs/calls.md), [`docs/lookup.md`](docs/lookup.md),
  [`docs/presence-profile.md`](docs/presence-profile.md): one guide per area of the API.
- [`docs/websocket.md`](docs/websocket.md) and [`docs/webhooks.md`](docs/webhooks.md): the two ways to
  receive events.
- [`docs/system.md`](docs/system.md) and [`docs/operations.md`](docs/operations.md): health, metrics
  and running the gateway.

**Running and changing the project**

- [`docs/development.md`](docs/development.md): toolchain, scripts, tests, Git hooks and CI.
- [`docs/contributing.md`](docs/contributing.md): the flow of a change, from branch to merge.
- [`docs/repository-settings.md`](docs/repository-settings.md): the ruleset of `main`, what the owner
  enables, the secrets and permissions of the workflows.
- [`docs/deploy-vps.md`](docs/deploy-vps.md) and [`docs/deploy-railway.md`](docs/deploy-railway.md): what
  a deployment needs, and what is not available yet.
- [`docs/backup-restore.md`](docs/backup-restore.md): what holds state, what each loss costs, how to copy
  and restore it.
- [`docs/upgrading.md`](docs/upgrading.md): the runbook for a break of WhatsApp Web or a new
  `whatsapp-web.js`.

**Generated reference**

- [`docs/openapi.json`](docs/openapi.json): the OpenAPI document.
- [`docs/operations-list.md`](docs/operations-list.md): every operation, its route and its scope.
- [`docs/websocket-commands.md`](docs/websocket-commands.md): every socket command.
- [`docs/events.md`](docs/events.md): every event and its payload.
- [`docs/errors.md`](docs/errors.md): every error code.
- [`docs/config-reference.md`](docs/config-reference.md): every environment variable.
- [`docs/metrics.md`](docs/metrics.md): every Prometheus series.
- [`docs/parity-matrix.md`](docs/parity-matrix.md): every `whatsapp-web.js` symbol and where it is.

**Decisions:** [`docs/adr/`](docs/adr/README.md).

## Repository settings

The repository is **public**: everything committed is world-readable, forever. Never commit phone
numbers, message text, session data, hostnames or secrets; fixtures are redacted first.

`main` is meant to be protected by a repository ruleset, committed as
[`deploy/github-ruleset.json`](deploy/github-ruleset.json): changes arrive through pull requests
that are squash-merged, with linear history, resolved conversations and the four CI checks
(`lint-and-types`, `unit-tests`, `integration-tests`, `security-scan`) green and up to date. Nobody
bypasses it. **Nothing is enforced until the owner applies it**, once, after the checks have run at least
once:

```bash
gh api -X POST repos/eosmin/wwebjs-gateway/rulesets --input deploy/github-ruleset.json
```

When the file changes later, update the ruleset that already exists; a second `POST` would fail on
the repeated name:

```bash
id=$(gh api repos/eosmin/wwebjs-gateway/rulesets --jq '.[] | select(.name == "protect-main") | .id')
gh api -X PUT "repos/eosmin/wwebjs-gateway/rulesets/$id" --input deploy/github-ruleset.json
```

The settings the owner enables once on GitHub: Dependabot alerts and security updates, secret
scanning with push protection, private vulnerability reporting, automatic deletion of head
branches, and squash-only merges.

## Security

To report a vulnerability, read [`SECURITY.md`](SECURITY.md).

## License

All rights reserved. See [`LICENSE`](LICENSE).
