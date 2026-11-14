# ADR 0014: the WhatsApp Web build and the library are pinned, and a pinned build that cannot load stops the start

Status: Accepted (2026-10-28)

## Context

`whatsapp-web.js` drives the real WhatsApp Web page, and WhatsApp changes that page without notice. A
build can remove a module, move a function from positional arguments to an object, or change what a
field holds. The typings of the library are not always what the page hands over (ADR 0006). A gateway that
follows the live page breaks on WhatsApp's schedule.

## Decision

Two things are pinned and a third is observed:

- **The library** is pinned to an exact version in `package.json`; a range is refused by
  `pnpm validate:pins`. Moving it is a reviewed change, with the checklist of `docs/upgrading.md`, and a
  scheduled check opens an issue when the pin is behind the latest version.
- **The WhatsApp Web build** can be pinned with `WWEB_VERSION`, with `WWEB_VERSION_CACHE_TYPE` (`local`, `remote` or
  `none`), `WWEB_VERSION_REMOTE_PATH` and `WWEB_VERSION_STRICT`. **Strict is the default:** a pinned build that
  cannot be loaded fails the start instead of running the live build without anyone noticing.
- **The build in use is observed:** `GET /v1/system/info` reports `wwebVersion` per session, and the gateway
  counts errors that look like a build change (drift) so a break is seen as a metric, not discovered by a
  user.

Calls into the page go through signatures the adapter checks first: a function WhatsApp Web no longer
exports answers a `502` naming the module, the function and the build before anything is sent.

## Consequences

- Production can stop following WhatsApp Web, after a build has passed the live checks, and rolls back by
  restoring the previous image tag or the previous variables.
- **The pin is partial today.** It keeps the entry page of a build (a small HTML file); the scripts are
  still downloaded from WhatsApp, so the pin only works while WhatsApp keeps serving that build. Saving a
  verified build whole is tracked in the plan (step 10.4).
- Real-WhatsApp behavior cannot be tested in CI, so the adapter stays thin and the manual smoke test is part
  of the upgrade runbook.

## Alternatives considered

- **Always follow the live build:** the gateway breaks whenever WhatsApp ships, with no warning and no
  rollback.
- **Fall back to the live build when the pinned one fails:** hides the problem and produces a gateway that
  runs on a build nobody checked. Failing the start is louder and safer.
- **Vendor and patch the library:** a patch of the library exists where a fix could not wait, but a fork
  to maintain is a larger cost than a pin and a reviewed bump.
