# Repository settings

What the GitHub repository (`eosmin/wwebjs-gateway`) has to be configured with, which part of that is
kept in this repository and which part only the owner can switch on. The reasoning is in
[`ADR 0003`](adr/0003-public-repository-and-protect-main.md).

## The repository is public

Everything committed is readable by anyone, for ever. The license is **all rights reserved** (`LICENSE`,
`"license": "UNLICENSED"` in `package.json`), and no open-source license is added anywhere. The production
instance is private: there is no live demo and no public API documentation, and `ENABLE_DOCS` is off
there. See [contributing](contributing.md) for what is never committed.

## The ruleset `protect-main`

`main` is protected by a repository **ruleset**, committed as `deploy/github-ruleset.json`. It is a file
in the repository, so a change to it is reviewed like code. What it says:

| Rule                              | Effect                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| Target: the default branch        | It applies to `main`                                                                 |
| `enforcement: active`, no bypass actors | Nobody bypasses it, the owner included                                         |
| `deletion`                        | `main` cannot be deleted                                                             |
| `non_fast_forward`                | No force push                                                                        |
| `required_linear_history`         | No merge commits                                                                     |
| `pull_request`                    | A change arrives through a pull request, merged **only by squash**; stale approvals are dismissed on a new push; every review conversation has to be resolved |
| `required_status_checks`          | `lint-and-types`, `unit-tests`, `integration-tests` and `security-scan` have to pass, and the branch has to be up to date with `main` (`strict`) |

The number of required approvals is **zero** on purpose: it is a one-person repository, and GitHub does
not let an author approve their own pull request. The pull request, the four checks, the resolved
conversations and the squash are the gate. The number goes to one when a second person joins.

### Applying it

Nothing is enforced until the owner applies the ruleset, once, **after the four checks have run at least
once** (a required check that has never reported cannot be selected):

```bash
gh api -X POST repos/eosmin/wwebjs-gateway/rulesets --input deploy/github-ruleset.json
```

When the file changes later, update the ruleset that already exists. A second `POST` fails on the repeated
name:

```bash
id=$(gh api repos/eosmin/wwebjs-gateway/rulesets --jq '.[] | select(.name == "protect-main") | .id')
gh api -X PUT "repos/eosmin/wwebjs-gateway/rulesets/$id" --input deploy/github-ruleset.json
```

The committed file and what GitHub enforces can drift if the step is forgotten. To see whether the
ruleset is in force:

```bash
gh api repos/eosmin/wwebjs-gateway/rulesets --jq '.[].name'
```

The answer has to list `protect-main`.

### The plan limitation

GitHub enforces rulesets and branch protection on **public** repositories, or on private ones with a
paid plan. On a free private repository the API answers `403 Upgrade to GitHub Pro or make this
repository public`. This is one of the reasons the repository is public: the protection of `main` would
not be enforced otherwise.

## Settings the owner switches on by hand

These are not in a file; they live in the settings of the repository:

- Dependabot alerts and security updates (the configuration of the updates themselves is
  `.github/dependabot.yml`).
- Secret scanning with push protection.
- Private vulnerability reporting, which `SECURITY.md` points reporters to.
- Automatic deletion of head branches after a merge.
- Squash merging as the only merge method (the ruleset already allows only squash).
- **Allow auto-merge**, which `gh pr merge --auto --squash` needs. With it, GitHub merges a pull request
  by itself when every check that the ruleset requires is green, and never before: the ruleset is the
  gate.

## The CI jobs the ruleset names

The four contexts of the ruleset are the four jobs of `.github/workflows/ci.yml`; renaming a job there
without changing the ruleset makes the check never report and the merge impossible. What each job does is
in [development](development.md).

## Secrets and permissions of the workflows

No workflow uses a repository secret: the only credential is the `github.token` that GitHub gives each
run, and each workflow asks for the least it needs.

- `ci.yml` has `contents: read`.
- `wwebjs release watch` has `contents: read` and `issues: write`: it opens one issue when
  `whatsapp-web.js` has a newer release ([upgrading](upgrading.md)).
- `WhatsApp Web build watch` starts with no permissions. Its job that opens a browser can only read the
  repository, and only the two jobs that report (one for a new build, one for a sweep that failed) can
  write issues; neither checks out the repository ([operations](operations.md)).

Actions are pinned by commit hash, and Dependabot updates them weekly.
Scheduled workflows are paused by GitHub after 60 days without activity in the repository: see
[upgrading](upgrading.md) for how to turn the release watch back on.

## Secrets of the application

The gateway's own secrets (`ADMIN_API_KEY`, `METRICS_TOKEN`, webhook secrets, the saved logins) are never
in the repository and never in a workflow. The pre-commit and pre-push hooks scan for them, and CI scans
the whole history ([development](development.md)).
