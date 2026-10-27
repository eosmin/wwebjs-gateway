# Security policy

## Reporting a vulnerability

Please report it **privately**, not in a public issue or pull request.

Use GitHub's private vulnerability reporting: open the **Security** tab of the repository and choose
**Report a vulnerability**
(<https://github.com/eosmin/wwebjs-gateway/security/advisories/new>).

Include what you found, how to reproduce it, which version or commit it affects and what an attacker
gains from it. Do not include real phone numbers, message text, WhatsApp session data or
credentials of a real deployment: placeholders are enough to show the problem.

This is a one-person project, so replies are best effort. A confirmed vulnerability is fixed on
`main` first, and the report stays private until the fix is published.

## Supported versions

Only the latest commit of `main`. There are no maintained release branches.

## Scope

In scope: the code in this repository, its container image and its CI configuration.

Out of scope: the production instance (it is private and not open to testing), `whatsapp-web.js` and
the other dependencies (report those upstream), and WhatsApp itself.

## Contributors: configuration that runs on your machine

`.claude/` and `.mcp.json` configure tools that execute on the machine of whoever opens the
repository: hooks that run after every edit, and an MCP server started with `uvx`, pinned to an
exact version. Review a change to either as you would review code, and read the prompt when Claude
Code asks to approve a project MCP server.

## What the project already does about it

- Secrets are scanned on every commit and on every push (gitleaks, in the Git hooks) and across the
  whole history in CI.
- The container image is built and scanned in CI; a critical or high vulnerability that has a fix
  fails the build.
- The image runs as a non-root user.
- Dependencies are pinned to exact versions and updated on purpose. A check in the Git hooks and in
  CI fails when `package.json` holds a range.
