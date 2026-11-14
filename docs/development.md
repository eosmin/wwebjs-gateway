# Development

How to work on the gateway: the toolchain, the scripts, the tests, the Git hooks, the commit
convention, the CI jobs and how to reproduce each one on your machine. To run the gateway and send a
first message, read [getting-started](getting-started.md); to see how the code is organized, read
[architecture](architecture.md); for the branch and pull request flow, read
[contributing](contributing.md).

## Toolchain

| Tool              | Version         | Where it is pinned                                            |
| ----------------- | --------------- | ------------------------------------------------------------- |
| Node.js           | 24.20.0         | `.nvmrc` (`engines.node` asks for 24 or newer)                |
| pnpm              | 11.25.0         | `packageManager` in `package.json`, activated by `corepack`   |
| TypeScript        | 5.9.3, strict   | `package.json`; no `any`, no `@ts-ignore`                     |
| Jest              | 30.5.1          | `jest.config.cts` and `jest.integration.config.cts`           |
| ESLint            | 10.9.1          | `eslint.config.js` (flat config), zero warnings allowed       |
| Prettier          | 3.9.6           | `.prettierrc`                                                 |
| Husky, lint-staged, commitlint | see `package.json` | The Git hooks (below)                          |
| gitleaks          | a local binary  | Not an npm package: `brew install gitleaks`                   |
| Docker            | any recent      | Postgres and Redis for development and for the integration suites |

**Every dependency is pinned to an exact version** (`pnpm validate:pins` fails on a range), and
Dependabot proposes the major updates on purpose. `whatsapp-web.js` is excluded from Dependabot
because upgrading it has its own runbook ([upgrading](upgrading.md)). The patch the gateway applies to
that library is `patches/whatsapp-web.js@1.34.8.patch`, applied by pnpm through `patchedDependencies`
in `pnpm-workspace.yaml`; the same file lists which install scripts may run (`allowBuilds`) and the
overrides of transitive packages, each with the reason in a comment.

## Set up

```bash
corepack enable
pnpm bootstrap
```

`scripts/bootstrap.sh` checks Node, Docker, gitleaks, openssl and pnpm, installs the dependencies (which
also installs the Git hooks through the `prepare` script), writes `.env.local` from `.env.example` with
random secrets, starts Postgres and Redis (`docker compose up -d --wait postgres redis`), generates the
Prisma client and applies the migrations. `.env.local` is git-ignored and it is the file the application
and the Prisma CLI read. To run a session you also need a browser: see
[getting-started](getting-started.md).

## Scripts

| Command                       | What it does                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| `pnpm dev`                    | Runs the service with reload (`nest start --watch`), on `PORT` (3000)                        |
| `pnpm build` / `pnpm start`   | Compiles to `dist/` and runs `dist/main.js`                                                  |
| `pnpm lint` / `pnpm lint:fix` | ESLint over the whole repository, zero warnings allowed                                      |
| `pnpm type-check`             | `tsc --noEmit`                                                                               |
| `pnpm format` / `format:check`| Prettier, write or check                                                                     |
| `pnpm test`                   | Unit suites                                                                                  |
| `pnpm test:cov`               | Unit suites with the coverage thresholds (what CI runs)                                      |
| `pnpm test:integration`       | Integration suites, one worker at a time; they need `pnpm infra:up`                          |
| `pnpm test:integration:cov`   | The same with the 90 % thresholds of the critical code (what CI runs)                        |
| `pnpm infra:up` / `infra:down` / `infra:logs` | Postgres and Redis of `docker-compose.yml`                                   |
| `pnpm db:generate`            | Generates the Prisma client (git-ignored, `pnpm install` does not create it)                 |
| `pnpm db:migrate`             | `prisma migrate deploy`: applies the committed migrations                                    |
| `pnpm db:migrate:dev`         | `prisma migrate dev`: creates a migration from a change of `prisma/schema.prisma`            |
| `pnpm docs:gen`               | Regenerates the generated docs                                                               |
| `pnpm validate:*`             | The validators below                                                                         |
| `pnpm validate:all`           | Lint, type-check, format, every validator and the unit tests, on the whole repository        |
| `pnpm validate:affected`       | What the pre-push hook runs                                                                  |
| `pnpm wa-web:sweep`           | The signature sweep of the live WhatsApp Web build ([operations](operations.md))             |

`pnpm` runs Node with `--experimental-vm-modules`, set once in `pnpm-workspace.yaml`, which Jest 30
needs for the ESM-only packages of Nest 12. If you run `jest` through another tool, set it yourself.

### The validators

| Command                       | What it checks                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| `validate:env`                | `.env.example` declares every variable of `src/config/env.schema.ts` and nothing else        |
| `validate:deprecations`       | No deprecated form of a library the project bans (Zod 3 forms, `QueueScheduler`, ...)       |
| `validate:rollbacks`          | Every migration has its rollback script in `prisma/rollbacks/`                              |
| `validate:migrations`         | Every migration is one atomic transaction, or says why not                                  |
| `validate:pins`               | Every dependency is an exact version                                                        |
| `validate:docs`               | The generated docs equal a fresh generation (a stale file fails)                            |

## Layout

`src/` is described in [architecture](architecture.md). The rest:

| Path                  | What it holds                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `src/**/*.spec.ts`    | Unit specs, next to the code they test                                                     |
| `tests/integration/`  | Integration specs that need Postgres and Redis                                             |
| `tests/parity/`       | The parity, OpenAPI, socket command, docs and boundary specs                               |
| `tests/helpers/`      | Shared helpers, among them `fake-whatsapp-client.ts` (a fake of the client port) and `webhook-receiver.ts` |
| `scripts/`            | The generators and validators; `scripts/lib/` holds their logic and its specs              |
| `prisma/`             | `schema.prisma`, `migrations/` and `rollbacks/`                                            |
| `ops/`                | The Prometheus alert rules and the files of the WhatsApp Web build watch                   |
| `docs/`               | The guides, the generated reference, the TDD, the plan and `adr/`                          |
| `patches/`            | The patch of `whatsapp-web.js`                                                             |

## Rules that tests and the linter enforce

- Only `src/whatsapp/wwebjs-adapter.ts` (and its own spec) imports `whatsapp-web.js`, and only
  `src/database/**` uses the Prisma client. Express, `prom-client` and `redis` are banned, and so are
  deep relative imports. `tests/parity/lint-boundaries.spec.ts` checks that the ESLint rules say so.
- `process.env` is read only in `src/config`. There is no `console`, `any` or `@ts-ignore`.
- A capability is one `@WaOperation` method of a controller; the REST route, the socket command, the
  OpenAPI document and the generated docs come from it ([architecture](architecture.md)).
- Every `whatsapp-web.js` symbol is mapped or listed with a reason in `src/parity/overrides.ts`
  (`tests/parity`).
- Zod 4 only, validated through `nestjs-zod`. Never `JSON.stringify` an object of the library.

## Tests

- **Unit specs** do not touch the network or a database. The WhatsApp client is replaced by the fake of
  `tests/helpers/fake-whatsapp-client.ts`, so the sessions, the pipeline and the controllers run
  without a browser. The global thresholds of `pnpm test:cov` are 80 % of lines, functions and
  statements and 75 % of branches.
- **Integration specs** (`tests/integration/`) use a real Postgres and a real Redis: run
  `pnpm infra:up` first. They run one at a time. The critical code (the send queue, the event
  pipeline and the order buffer) has 90 % thresholds, measured with the unit specs of those files too.
- **Nothing in CI reaches WhatsApp.** What needs a real account is checked by hand with a test account
  and the protocol of [sessions](sessions.md) ("Checking an upgrade of whatsapp-web.js with a real
  account"): never use a production number.
- Run Jest with `--no-cache` when you want to be sure that a cached success does not hide a failure.

## Migrations

Change `prisma/schema.prisma`, run `pnpm db:migrate:dev` and commit the SQL it generates under
`prisma/migrations/`. Each migration needs a rollback script in `prisma/rollbacks/` with the same
name (`<migration>.rollback.sql`) and has to be one `BEGIN; … COMMIT;` transaction, or say why not with
a `-- no-transaction: <reason>` line. Never use `prisma db push`. The container runs
`prisma migrate deploy` before it starts the gateway (`docker-entrypoint.sh`). CI applies the
migrations to an empty database and then runs every rollback, newest first.

## Documentation

Documentation ships in the same pull request as the behavior. The generated files (`events.md`,
`errors.md`, `config-reference.md`, `metrics.md`, `operations-list.md`, `websocket-commands.md`,
`parity-matrix.md` and `openapi.json`) are never edited by hand: change the code and run
`pnpm docs:gen`. `pnpm validate:docs` fails when one is stale, when a guide is missing from the
manifest in `scripts/lib/guides.ts`, when an internal link or anchor is broken, when a guide is not
linked from the README, when a `curl` example targets a route that does not exist, or when a guide
does not mention the variables of its feature. Run it with a clean environment, as CI does, so a local
`.env.local` cannot hide a failure:

```bash
(
  mv .env.local .env.local.bak
  trap 'mv .env.local.bak .env.local' EXIT
  env -i HOME="$HOME" PATH="$PATH" pnpm validate:docs
)
```

## Git hooks

Husky installs them with `pnpm install`. They are never bypassed (`--no-verify` is not an option of
this project).

| Hook         | What it does                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------- |
| `pre-commit` | Refuses to run without `gitleaks`. Runs `lint-staged` (ESLint with `--fix`, Prettier, `prisma format`, and the rollback and migration validators for a migration), then scans the staged diff for secrets |
| `commit-msg` | `commitlint`: the message follows Conventional Commits                                                            |
| `pre-push`   | Scans the commits that are pushed for secrets, then runs `pnpm validate:affected`: lint, type-check, unit tests, format and the validators; a push that only touches `docs/` runs only `validate:docs`. The builds and the suites that need Postgres or Redis are left to CI |

The repository is public: a secret that is pushed is published, which is why the scan runs before
anything leaves your machine.

## Commit messages

Conventional Commits, enforced by `commitlint.config.js`: `type(scope): subject`, with the type one of
`feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`, `ci`, `revert` or `build`, a
lowercase subject of at most 72 characters and body lines of at most 100. The scope is one of a list
in the same file (a scope outside it is a warning). One commit per logical unit, and one
`chore(deps): add <package>` commit per dependency. The title of the pull request follows the same
rules, because it becomes the squash commit.

## CI

`.github/workflows/ci.yml` runs on every pull request and on `main`. Four jobs are required to merge
([repository-settings](repository-settings.md)):

| Job                 | What it runs                                                                                    | Reproduce it                                  |
| ------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `lint-and-types`    | Prettier check, commitlint over the commits and the title, the validators, lint, type-check and `pnpm build` | `pnpm validate:all` and `pnpm build`          |
| `unit-tests`        | `pnpm test:cov`, with the docs and parity specs                                                 | `pnpm test:cov`                               |
| `integration-tests` | Migrates an empty database, runs `pnpm test:integration:cov`, boots the built service and probes it with `scripts/smoke-http.ts`, then runs every rollback | `pnpm infra:up`, `pnpm db:migrate`, `pnpm test:integration:cov` |
| `security-scan`     | Scans the whole Git history with gitleaks, builds the image, starts it in production mode and probes it, then scans it with Trivy (critical and high vulnerabilities that have a fix fail the job) | `docker build .` and `gitleaks git`           |

Two scheduled workflows are not required checks: `wwebjs release watch` and `WhatsApp Web build
watch` ([upgrading](upgrading.md), [operations](operations.md)).

A red job that has nothing to do with your change is a flaky test: rerun it once, and if it fails
again, report it instead of widening your change.

## Claude Code configuration

The repository ships configuration for Claude Code, which runs on the machine of whoever opens it, so a
change to it is reviewed like code (`SECURITY.md`):

- `.claude/settings.json` denies reading `.env*` files (except `.env.example`) and the saved logins
  (`.wwebjs_auth/`, `.wwebjs_cache/`), denies editing the generated docs, and runs a graph update
  (`code-review-graph`, when installed) after edits.
- `.mcp.json` starts the `code-review-graph` MCP server with `uvx`, pinned to an exact version.
- `.claude/agents/code-reviewer.md` is a read-only reviewer subagent, and `.claude/skills/` holds four
  short skills (explore, debug, refactor, review).
- `.claude/settings.local.json` is for your own overrides and is git-ignored.

None of it is needed to build, test or run the gateway.
