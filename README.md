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
  your own risk.
- **The production instance is private.** There is no live demo, no public API documentation and
  no screenshots, on purpose. This repository only holds the code.
- **Run exactly one replica.** A session's Chromium process belongs to a single Node process, so
  the gateway is a single-instance service by design. Never scale it horizontally.
- **`.wwebjs_auth/` is an account credential.** Whoever has it can use the WhatsApp account. It is
  git-ignored and must never be committed, shared or backed up unprotected.

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

If a default port is taken, move it: `API_PORT=3001 POSTGRES_PORT=5433 REDIS_PORT=6380 docker compose up`.

`pnpm bootstrap` creates `.env.local` from `.env.example`. It is git-ignored, and it is the file the
Prisma CLI reads (`pnpm db:migrate` needs it, or a `DATABASE_URL` in your environment).

The environment variables are listed in [`docs/config-reference.md`](docs/config-reference.md),
and [`.env.example`](.env.example) declares all of them.

## Develop

| Command                 | What it does                                                          |
| ----------------------- | --------------------------------------------------------------------- |
| `pnpm validate:all`     | Everything CI checks, on the whole repository                         |
| `pnpm lint`             | ESLint with zero warnings allowed                                     |
| `pnpm type-check`       | TypeScript, strict                                                    |
| `pnpm test:cov`         | Unit tests with the coverage gates                                    |
| `pnpm test:integration` | Integration suites (need `pnpm infra:up`)                             |
| `pnpm docs:gen`         | Regenerates the generated docs; `pnpm validate:docs` fails when stale |

Git hooks run on every commit and push (secret scan, lint, commit message, checks); they are never
bypassed. Commits follow [Conventional Commits](https://www.conventionalcommits.org/).

## Repository settings

The repository is **public**: everything committed is world-readable, forever. Never commit phone
numbers, message text, session data, hostnames or secrets; fixtures are redacted first.

`main` is protected by a repository ruleset, committed as
[`deploy/github-ruleset.json`](deploy/github-ruleset.json): changes arrive through pull requests
that are squash-merged, with linear history, resolved conversations and the four CI checks
(`lint-and-types`, `unit-tests`, `integration-tests`, `security-scan`) green and up to date. Nobody
bypasses it. The owner applies it once, after the checks have run at least once:

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
