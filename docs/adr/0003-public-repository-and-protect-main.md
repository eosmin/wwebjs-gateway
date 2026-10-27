# ADR 0003: Public repository and the `protect-main` ruleset

Status: Accepted (2026-10-27)

## Context

`main` must only change through a pull request whose CI checks are green, squash-merged with a
linear history, and nobody, the owner included, should be able to push to it directly. GitHub
enforces rulesets and branch protection on public repositories, or on private ones with a paid
plan. On a free private repository the API answers `403 Upgrade to GitHub Pro or make this
repository public`, which is the situation of `omnichannel-platform` today.

The production instance of this gateway is private and handles real conversations, but the code
does not need to be.

## Decision

The repository is **public**, `eosmin/wwebjs-gateway`. The protection of `main` is a repository
ruleset named `protect-main`, committed as `deploy/github-ruleset.json` and applied by the owner
once the four CI checks have run at least once, because a required check that never reported cannot
be selected. It requires a pull request with squash as the only merge method, linear history,
resolved conversations, and `lint-and-types`, `unit-tests`, `integration-tests` and
`security-scan` green and up to date. It forbids deletion and force pushes, and has no bypass
actors.

It asks for **zero** required approvals on purpose: this is a one-person repository and GitHub does
not let an author approve their own pull request. The pull request, the four checks, the resolved
conversations and the squash are the gate. The number goes to one when a second person joins.

The license is "all rights reserved": a root `LICENSE` file, `"license": "UNLICENSED"` in
`package.json`, and no open-source license anywhere.

## Consequences

- Everything committed is world-readable, forever. The repository hygiene rules apply from the first
  commit: no phone numbers, message text, session data, hostnames or secrets, and redacted fixtures.
  Secrets are scanned on every commit and over the whole history in CI.
- There is no live demo, no public API documentation and no screenshots: the production instance
  stays private and `ENABLE_DOCS` is false there. This deviates on purpose from two of the
  portfolio-wide standards.
- `SECURITY.md` points to GitHub's private vulnerability reporting.
- The ruleset is a file in the repository, so a change to it is reviewed like code; applying it is a
  manual step, and the committed file and what GitHub enforces can drift if the step is forgotten.
  Until the owner applies it, which is the last act of Phase 0 once the four checks have run, `main`
  is public and unprotected. Whether it is in force is checked with
  `gh api repos/eosmin/wwebjs-gateway/rulesets --jq '.[].name'`, which must list `protect-main`.

## Alternatives considered

- **A private repository.** The ruleset would not be enforced on a free plan, which defeats the
  reason for having it.
- **Paying for GitHub Pro or Team.** It would make a private repository enforceable at a recurring
  cost, for code that has no reason to be secret.
- **Classic branch protection.** It has the same plan limitation and is the older mechanism.
- **No protection, relying on discipline.** The Git hooks and the CI checks would still run, but
  nothing would stop a direct push to `main` on a bad day.
