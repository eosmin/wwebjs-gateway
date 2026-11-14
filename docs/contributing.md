# Contributing

The flow of a change, from a branch to the merge. The tools are described in
[development](development.md) and the rules of the repository on GitHub in
[repository-settings](repository-settings.md).

This is a one-person project and the license is **all rights reserved** (`LICENSE`): reading the code does
not grant a right to reuse it. A pull request from a fork follows the same flow as any other, and nothing
promises that it will be merged. To report a vulnerability, do not open a pull request or an issue: read
`SECURITY.md`.

## Before you start

- Read [architecture](architecture.md) and the rules of [development](development.md). The design the code
  follows is `docs/TDD.md`, and the work is organized as the steps of `docs/IMPLEMENTATION_PLAN.md`.
- **The repository is public.** Everything you commit is readable by anyone, for ever. Never commit a
  phone number, the text of a real message, session data (`.wwebjs_auth/`, `.wwebjs_cache/`), a QR code, a
  hostname of a real deployment or a secret. A fixture is redacted before it is committed. The hooks scan
  for secrets, but they cannot know what is personal data.
- Never test with the number a business depends on. The checks that need a real account use a disposable
  test account and the protocol of [sessions](sessions.md).

## The flow

1. **Branch from an up to date `main`.** Never work on `main`: it is protected and a push to it is
   refused. Name the branch `<type>/<what>`, with the type of a commit (`feat`, `fix`, `docs`, `test`,
   `chore`, `ci`...), for example `fix/webhook-retry-order`.
2. **Write the change with its tests and its documentation.** A change to behavior carries its unit
   tests (and an integration test when it touches Postgres, Redis, an endpoint or a queue), and the
   documentation that describes it: a new variable goes in `env.schema.ts`, `.env.example` and the
   guides; a new capability is one `@WaOperation`; the generated docs are regenerated with
   `pnpm docs:gen`. A pull request that only fixes documentation is not made on its own: documentation
   fixes travel with the change they describe.
3. **Commit by logical unit**, in Conventional Commits ([development](development.md)). Each new
   dependency is its own `chore(deps): add <package>` commit, pinned to an exact version.
4. **Run the checks.** `pnpm validate:all` is everything that CI runs on the code, except the suites that
   need Postgres and Redis (`pnpm test:integration`). The Git hooks run on every commit and push and
   are never bypassed.
5. **Push the branch and open a pull request against `main`.** The title follows the same Conventional
   Commit rules as a commit, in lowercase and at most 72 characters, because the pull request is
   squash-merged and its title becomes the commit on `main`.
6. **Fill the template** (`.github/pull_request_template.md`): the summary, the section of the TDD it
   implements, the checklist and the migration notes. The checklist is the list of things a reviewer
   looks at:
   - only the adapter imports `whatsapp-web.js`, and only `src/database/**` uses Prisma;
   - a capability is one `@WaOperation` with its summary, description, examples, errors, scope and links;
   - new variables are in the schema, in `.env.example` and in the docs;
   - generated docs are regenerated and committed;
   - tests were added and the coverage thresholds pass;
   - a migration has its rollback script in `prisma/rollbacks/` and is one transaction;
   - sends stay idempotent, events keep their `seq` order, and nothing blocks the event pipeline;
   - no secret, QR code or session data is in code, logs or fixtures.
7. **Wait for the four required checks** (`lint-and-types`, `unit-tests`, `integration-tests`,
   `security-scan`). The branch has to be up to date with `main` for the merge, and every conversation
   has to be resolved. The only way to merge is a squash.

## Review

Review the change before you open the pull request, in small batches (one library, or ten files at most)
and one question at a time: correctness, security (secrets, permissions, credentials, personal data),
tests, or configuration (CI, Docker, hooks, environment). Check each finding by running the code before you
change anything: some findings are false positives, and a fix without a test that fails first proves
nothing. Read the riskiest code yourself: the adapter boundary, the send queue and policy, the order
buffer, authentication and the SSRF guard. A tool tells where to look, not that the rest is right.

## Debt

A limit, a deferral or a finding left unfixed on purpose is written down in the same pull request, in
`docs/IMPLEMENTATION_PLAN.md`, with the step that closes it: a description does not outlive the merge.
Do not weaken a test, a threshold or a lint rule to make a change pass, and do not leave a placeholder.

## What a pull request never does

- It never commits to `main`, rewrites its history or bypasses the ruleset.
- It never uses `--no-verify`.
- It never merges by hand.
- It does not stack on another unmerged branch: wait for the first pull request to merge and pull `main`.
