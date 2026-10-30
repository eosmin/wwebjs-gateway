# CLAUDE.md — wwebjs-gateway (Project: whatsapp)

Production-grade REST + outbound/inbound webhooks + Socket.IO gateway with 100% API parity over `whatsapp-web.js`. Multi-session, NestJS 12 (Fastify adapter) + Prisma 7 + Postgres + Redis/BullMQ, TypeScript strict.

**This is a REAL production system** (chatbots / real conversations), not a demo. Reliability, durability and complete documentation outrank brevity. Single instance by design (replicas = 1).

## Stage

- **TDD stage (finished):** the folder held only the TDD and this file. It ended when the repository was initialized (step 0.1); the TDD now lives at `docs/TDD.md`.
- **Build stage (current):** `git init` was run inside `whatsapp/` (never at the `portafolio/` root). Follow `docs/IMPLEMENTATION_PLAN.md` step by step (the specification is `docs/TDD.md`, §7 is the plan).

The root `../CLAUDE.md` still applies: DRY/KISS/YAGNI/SOLID, strict typing (no `any`, no `@ts-ignore`), Conventional Commits, Context7 before touching any library, deprecation discipline, comment discipline, quality standards.

## Git workflow (same as `omnichannel-platform`)

- **AUTHORIZATION (standing, owner 2026-10-31):** when a step's "Done when" is verified, its review is done (see "Code review of a step") and `pnpm validate:all` is green, commit (one commit per logical unit), push the feature branch and open the PR **without asking**. Nothing else is authorized: never rebase, tag, force-push, `--no-verify`, or touch `main`; any other `gh` or GitHub API write (settings, rulesets, issues, releases) still needs the owner's explicit request. Hooks never get bypassed.
- **Never work directly against `main`** (the step 0.1 commit and the one-time push of the initial `main` were the only exceptions). Create a feature branch first (`feat/`, `fix/`, `chore/`), push only that branch and open a PR against `main`.
- **Merge (owner, 2026-10-31):** right after opening the PR run `gh pr merge --auto --squash`. GitHub merges by itself when every check required by the `protect-main` ruleset is green and never before; the ruleset is the gate, not the assistant. Never merge by hand, never bypass the ruleset, never disable a check to get a merge. Requires **Allow auto-merge** in the repository settings (owner's one-time switch). Do not start the next step until the PR is merged and `main` is pulled: **never stack branches**, a conflict in the first propagates to all the others.
- **A red job unrelated to the change** (a flaky test) is rerun once. If it fails again, record it in the PR description and fix it in its own PR; do not widen the current one.
- **Decisions (owner, 2026-10-31): when the TDD is ambiguous or silent, decide; do not ask the owner.** The owner is not expected to judge technical choices, so the decision is made here and made well.
  - **Priority, in this order:** security and data safety, then correctness, then maintainability, then the smallest scope, then speed. Speed and token cost never outrank the first three. Among options that are equally safe and correct, take the one that least extends the TDD.
  - **No shortcuts to finish sooner.** Never skip, loosen or delete a test, check, threshold, budget or lint rule; never add `any`, an ignore or a mock that hides the behavior under test; never leave a placeholder or a TODO; never pick the weaker option because the right one is bigger.
  - **When the right option is too big for the PR,** do the correct part and add a task to `IMPLEMENTATION_PLAN.md` in the same PR, naming the step that owns the rest. A deferral that is not written in the plan is a shortcut.
  - **Write it down** in a "Decisions" section of the PR description: what was chosen, the best alternative that was rejected, why, and any debt created with where it is tracked.
  - **Stop and ask only** when the choice contradicts an explicit statement of the TDD, cannot be undone (data, secrets, money, a real account) or acts outside the repository.
- **PR granularity:** commits per logical unit (one `chore(deps): add <package>` per dependency); one push + PR per step, grouped per the "PR grouping" table in `docs/IMPLEMENTATION_PLAN.md` (57 PRs; Phase 0 is one PR; step 0.1 is a local commit on `main` that precedes it). Branch name `<type>/<phase>-<n>-<slug>` (e.g. `feat/3-5-order-buffer`). One PR open at a time.
- **No documentation-only PRs.** A PR carries a real change; doc fixes ride inside the PR of the work they describe.

## Git hooks (Husky) — installed by `pnpm install` (`prepare` script). NEVER `--no-verify`.

- `pre-commit`: refuses to run without `gitleaks` (`brew install gitleaks`); `lint-staged` fixes and re-stages (ESLint `--fix --max-warnings=0`, Prettier, `prisma format`, rollback check for migrations); then `gitleaks` scans the staged diff.
- `commit-msg`: `commitlint` — Conventional Commits, lowercase subject ≤ 72 chars (e.g. `feat(ordering): flush a burst sorted by sentAt`). PR titles follow the same rules (they become the squash commit).
- `pre-push`: `pnpm validate:affected` (lint, type-check, unit tests, format check, validators; docs-only pushes run only the docs check). Builds and suites that need Postgres/Redis are left to CI.
- `pnpm validate:all` = everything on the whole repo. CI (`lint-and-types`, `unit-tests`, `integration-tests`, `security-scan`) runs the same checks; all four are required to merge.

## Claude Code automation

- `.claude/settings.json` (committed): denies reading `.env*` (except `.env.example`) and `.wwebjs_auth/`/`.wwebjs_cache/` (account credentials); denies editing the generated docs (`pnpm docs:gen` owns them); `SessionStart` runs `code-review-graph status`, `PostToolUse` (Edit|Write|Bash) runs `code-review-graph update --skip-flows`. MCP server in `.mcp.json`; skills in `.claude/skills/`.
- Per-machine overrides live in `.claude/settings.local.json` (git-ignored).

## Read first

- `docs/TDD.md` — the single source of truth (decisions log in §11): stack/versions (§2), compat & deprecation notes (§2.5), structure (§3), domain model (§5), behavior specs (§6), plan (§7), definition of done (§9).

## Project-specific rules

- Only `src/whatsapp/wwebjs-adapter.ts` (and its own spec, which drives a real `Client`) may import `whatsapp-web.js`. Everything else depends on `WhatsAppClientPort` and our DTOs. Never `JSON.stringify` a wwebjs object.
- Never set `puppeteer.userDataDir` (LocalAuth throws). Session IDs match `^[-_\w]{1,64}$`.
- BullMQ-connected ioredis must use `maxRetriesPerRequest: null`; no `QueueScheduler`.
- Zod 4 only (`z.email()`, `z.uuid()`, `z.url()`, `z.strictObject()`), validated through `nestjs-zod`. Prisma 7.10.1 with the pg driver adapter (NOT `prisma@8` rc); fetch the Prisma 7 setup from Context7 first; never `prisma db push`; `BigInt` never leaks into DTOs. No `@nestjs/platform-express`.
- Inbound message order: events go dedupe → store → per-chat order buffer → `seq` → publish. `seq` is assigned AFTER ordering. Order by sender `sentAt` (1 s resolution), ties by WhatsApp Web chat order. `message_batch` is a synthesized event for chatbots. Held messages are crash-safe via `messages.emittedAt`.
- `origin` (Meta Click-to-WhatsApp ad metadata) is extracted from `rawData.ctwaContext` (`conversionSource, sourceUrl, title, description, thumbnailUrl, mediaUrl`); `raw` carries the full sanitized rawData. Finalize `sourceId` derivation with a real ad message fixture. The gateway only delivers this data; consumer-side logic (auto-replies, lead matching) is out of scope and never appears in code or docs.
- Raw API keys / inbound tokens are returned once and stored as sha256. Never log keys, secrets, tokens or QR strings.
- Webhook and media URLs go through the SSRF guard (`assertPublicHttpUrl`).
- Single-instance by design: no Socket.IO Redis adapter, no RemoteAuth, never run >1 replica.
- Every capability is ONE controller method with `@WaOperation({... scope ...})` — the `scope` (`read|send|manage|webhooks|events|admin`) is mandatory and enforced by the guard (REST route + socket command + OpenAPI + parity + docs derive from it via `OperationRegistryService`). Never hand-write a parallel route or socket handler for something the registry covers.
- 100% parity is enforced by `tests/parity`: any new/removed wwebjs symbol must be mapped or listed `unsupported` with a reason in `src/parity/overrides.ts`. Never expose `pupPage`/`pupBrowser`/arbitrary evaluate.
- Docs are generated/verified in CI (`pnpm docs:gen`, then `pnpm validate:docs` fails on any diff). Update docs in the same PR as the behavior.
- Delivery is at-least-once with per-session `seq`; sends are idempotent (`Idempotency-Key`) and never blindly retried after an unknown outcome.
- Every wwebjs call goes through the adapter's timeout + error translation; unhandled Puppeteer rejections must be attributed to a session, not crash the process.
- Event names are the real wwebjs ones (`call`, `code`, `change_battery`, …); there is no incoming-typing event in the library.
- **The repository is PUBLIC (`eosmin/wwebjs-gateway`)**: everything committed is world-readable forever. Never commit real phone numbers, message text, session data, hostnames or secrets; fixtures are redacted first (TDD §10). The production instance is private: no live demo, no screenshots, `ENABLE_DOCS=false` in production (intentional deviation from the root standards). The license is "all rights reserved" (root `LICENSE`; never add an open-source license). Open decisions (hosting, real test phones + ad message) are in TDD §11: ask the owner at the stated moment.
- Branch + PR only: push the feature branch, open the PR and enable auto-merge as above. Never touch `main` directly.

## Commands (once scaffolded)

`pnpm dev` · `pnpm type-check` · `pnpm lint` · `pnpm format:check` · `pnpm test` · `pnpm test:cov` · `pnpm test:integration` · `pnpm validate:all` · `pnpm validate:deprecations` · `pnpm docs:gen` · `pnpm db:generate` · `pnpm db:migrate` · `pnpm infra:up` · `pnpm bootstrap`. Package manager is pnpm 11 (corepack), Node 24.20.0, TypeScript 5.9.3, Jest 30 — mirror of `omnichannel-platform`; the full toolchain spec is TDD §2.6 and it is installed in Phase 0 before any feature code.

## Verify before presenting

Run `pnpm lint`, `pnpm type-check` and `pnpm test` after every change (`pnpm validate:all` before proposing a commit); fix before showing results. Real-WhatsApp behavior can't be tested in CI — keep the adapter thin and document the manual smoke test.

## How to work (every session)

1. Open `docs/IMPLEMENTATION_PLAN.md` ("Progress tracking" table) and find the first step that is not `done`; steps are numbered `<phase>.<n>` and are worked strictly in order.
2. Re-read the TDD sections that the step cites before implementing it.
3. Implement the step's files in dependency order, with its tests and its documentation (docs ship in the same PR as the behavior).
4. Verify the step's "Done when" (below) for real: run it, do not assume it.
5. Tick the step's checkbox and update its row in the progress table, as the last change of the step's PR.
6. Commit, push, open the PR and run `gh pr merge --auto --squash` (see Authorization and Merge above); then wait for the merge before the next step.
7. Move to the next step.

## Definition of done for any step

- [ ] `pnpm type-check` and `pnpm lint` (zero warnings) pass
- [ ] Unit tests for new logic; integration tests when the step touches Postgres, Redis, an endpoint or a queue
- [ ] Documentation written/updated (guide, ADR if it is a decision) and `pnpm validate:docs` green
- [ ] Parity expected-failures list updated (it only shrinks)
- [ ] The step's own "Done when" verified, not assumed
- [ ] `pnpm validate:all` green; in the PR, all CI jobs that exist at that point are green
- [ ] Checkbox and progress row updated

## Code review of a step

This part applies to the `/code-review` skill, which reports at most 10 findings per run, even when asked for more (the `code-reviewer` subagent below has no such cap). A run that returns 10 has **not** run out of findings.

- Review in small batches (one library, or at most 8 to 10 files), never the whole step at once.
- Give each pass one lens: correctness, security (secrets, permissions, WhatsApp credentials, personal data), tests, or configuration/CI/Docker.
- **One pass per PR.** Run the review once per batch and lens, at `/code-review medium`. Fix what is real and verifiable, drop the rest, and do not run the same batch again. A run that returns 10 findings does not oblige another run.
- **Repeat only on critical code:** security, personal data, money, credentials, the adapter boundary, the send queue and policy. CI, tests and docs get one pass.
- **New findings that are not bugs** (hardening, style, extra tests for unlikely cases) go to a backlog issue, not into this PR.
- **"Done" is decided by green CI** (`pnpm validate:all` and the required jobs), not by the number of findings.
- Check every finding by running the code before changing anything. Some are false positives, and a fix without a test that fails first proves nothing.
- Read the riskiest code yourself (the adapter boundary, the send queue and policy, the order buffer, auth, SSRF guard, anything touching credentials). The tool says where to look first, not that the rest is fine.
- The mechanical gates have no cap and run on every step: `tsc`, ESLint, the tests (run Jest with `--no-cache` so a cached success cannot hide a failure), the parity and docs tests, the integration suites and Trivy.
- At the end say which files were read in full, which were only run or tested, and how many files were touched.

### Using the `code-reviewer` subagent (`.claude/agents/code-reviewer.md`)

The subagent gives independent, fresh-eyes findings; it never replaces the mechanical gates or reading the riskiest code yourself, and it never fixes anything. The agent launches it itself, once per PR, for the critical code of a step (security, data, money, the WhatsApp adapter), and not for the rest.

1. **Gates first:** `pnpm validate:all` (Jest with `--no-cache`) must be green before any review.
2. **Pick a batch and a lens:** at most 10 files, one lens (correctness, security, tests, config-ci-docker). Every step gets correctness and tests; steps 3.5–3.10, 4.1, 4.2, 5.1, 5.2, 7.4 and 8.3 also get security; steps that touch CI, Docker, hooks or env get config-ci-docker.
3. **Launch** with the step number, the exact file list, the lens and the TDD sections that apply.
4. **Verify every finding** by running or reading the code before changing anything. A real bug gets a failing test first, then the fix. A false positive is dropped with a one-line reason.
5. **No second round by default.** After fixing the real findings, move on. Repeat the batch and lens only when the code is critical (see above) and a BLOCKER/HIGH was fixed; stop after 2 rounds and record what is left in a backlog issue. Non-bug findings go to a backlog issue.
6. **Report to the owner:** findings (real / false positive / unverified), files read in full vs only run, files touched.
7. **Then commit and open the PR** (Authorization rule).

<!-- code-review-graph MCP tools -->

## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore the codebase.** The graph is faster, cheaper (fewer tokens), and gives you structural context (callers, dependents, test coverage) that file scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool                        | Use when                                               |
| --------------------------- | ------------------------------------------------------ |
| `detect_changes`            | Reviewing code changes — gives risk-scored analysis    |
| `get_review_context`        | Need source snippets for review — token-efficient      |
| `get_impact_radius`         | Understanding blast radius of a change                 |
| `get_affected_flows`        | Finding which execution paths are impacted             |
| `query_graph`               | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes`     | Finding functions/classes by name or keyword           |
| `get_architecture_overview` | Understanding high-level codebase structure            |
| `refactor_tool`             | Planning renames, finding dead code                    |

### Workflow

1. The graph auto-updates on file changes (via the hooks of `.claude/settings.json`).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
