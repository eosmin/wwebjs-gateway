# Upgrading and recovering from a library break

The runbook for the two things that make the gateway stop working without a change on your side: WhatsApp
Web changes under the library, and a new `whatsapp-web.js` is released. It has three levels, the fastest
first, and it says what to do when none of them is enough. How to read the signs of a break (the log
lines, the metrics, the alerts) and the procedure to pin or move a WhatsApp Web build are in
[operations](operations.md); the checks to run with a real account are in [sessions](sessions.md).

**Read this before anything else.** A send that failed after it was dispatched has an unknown outcome:
never repeat it with a new `Idempotency-Key` without looking at the chat ([send-queue](send-queue.md)).
After a logout, do not link the number again at once ([sessions](sessions.md)). And never run an experiment
on the number that production depends on.

## What can break

`whatsapp-web.js` drives WhatsApp Web inside Chromium by calling functions of the page by name. WhatsApp
ships a new build of the page every day or two. A build can rename a function, change its arguments or
drop it, and the library, which is patched by this repository (`patches/whatsapp-web.js@1.34.8.patch`,
applied by pnpm), fails until it is fixed. The signs are in [operations](operations.md): a `502
WHATSAPP_ERROR` whose cause starts with `[signature]`, sessions logged out, events dropped, or a session
in `failed` with `lastError: WhatsApp Web state DEPRECATED_VERSION` ([troubleshooting](troubleshooting.md)).

Two scheduled workflows tell you before a user does:

- **`wwebjs release watch`** (`.github/workflows/wwebjs-watch.yml`, daily and by hand) compares the
  pinned `whatsapp-web.js` with the latest version on npm and keeps one open issue, "whatsapp-web.js
  X is available", with a link to the release notes and the checklist of Level 2. Dependabot ignores
  this package on purpose: the issue is the notification, and the upgrade is a deliberate pull request.
- **`WhatsApp Web build watch`** (`.github/workflows/wa-web-watch.yml`) looks at the build WhatsApp
  serves now and opens one issue per build when its signature sweep finds a change that is not already
  tracked ([operations](operations.md)).

### When the watches go quiet

GitHub pauses scheduled workflows after 60 days without activity in the repository, and then no issue
comes. If the issues stop, open the **Actions** tab, choose the workflow and re-enable it, or run it by
hand with **Run workflow** (both have `workflow_dispatch`). Do it also when you suspect a missing issue.
An issue that is closed by hand while the pin is still behind is opened again by the next run: close it
with the upgrade, not before.

## Level 1: change the WhatsApp Web version, with no rebuild (minutes)

The library loads a build of WhatsApp Web that you can name. The gateway reads these variables
([config-reference](config-reference.md)), so changing them in the deployment environment and restarting
is enough; the sessions on the volume come back without a QR code:

| Variable                   | Meaning                                                                         |
| -------------------------- | ------------------------------------------------------------------------------- |
| `WWEB_VERSION`             | The build to load, unset to follow the live one                                 |
| `WWEB_VERSION_CACHE_TYPE`  | `local` (the saved page of that build, in `WWEB_CACHE_PATH`), `remote` or `none` |
| `WWEB_VERSION_REMOTE_PATH` | An https address with `{version}`, required for `remote`                         |
| `WWEB_VERSION_STRICT`      | `true` (the default): a pinned build that cannot be loaded fails the start instead of silently running the live one |

**What this level can and cannot do today.** The pin keeps the **entry page** of a build (a small HTML
file); the scripts are still downloaded from WhatsApp, so the pin works only while WhatsApp keeps serving
that build. And **there is no saved page of a build that was checked well**: the first one has to be made
from a build that passes the live checks. [operations](operations.md) ("Pinning a WhatsApp Web build")
holds the procedure, the limits, and why the `remote` cache of a third party is not recommended: the page
it serves runs inside the browser that is linked to the account. The plan tracks what is still open
(`docs/IMPLEMENTATION_PLAN.md`, 10.4, the pin of a verified build).

To go back, set the variables to their previous values and restart. If you never had a pin, unset
`WWEB_VERSION` to follow the live build again.

## Level 2: change the library or its patch (the time of CI plus a deploy)

Use it when the release notes or the sweep show that the fix is in a new `whatsapp-web.js`, or when the
fix has to go into the patch. This is a pull request, never an automatic update. The checklist of the
issue that the release watch opens is this one:

1. **Branch** from `main` (`chore/bump-wwebjs`) and change the **exact** pin of `whatsapp-web.js` in
   `package.json` (a range is refused by `pnpm validate:pins`). Run `pnpm install`.
2. **Read the release notes.** Re-check the event names in the library's `Constants.js` and the
   compatibility notes of `docs/TDD.md` §2.5.
3. **The patch.** `pnpm-workspace.yaml` names the patch with the version (`patchedDependencies`). For a
   new version, regenerate it: `pnpm patch whatsapp-web.js@<version>`, apply the changes that are still
   needed, then `pnpm patch-commit <the folder that pnpm printed>`, and update the name in `patchedDependencies`. If the release fixes
   a defect that the patch worked around, remove that part of the patch and its test. The image build
   greps the installed library for a line that only the patch has and fails without it, so a patch that
   does not apply cannot reach production unnoticed. A freshly published version can also be held back by
   the release-age gate of pnpm: `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` is how a version
   that was reviewed by hand is let through, and its entry is removed once the gate has passed.
4. **Parity.** Run `pnpm test`. The parity test fails on every symbol that the new version added or
   removed until it is mapped to an operation, an event or a field, or listed as unsupported with a reason
   in `src/parity/overrides.ts` ([parity-matrix](parity-matrix.md)).
5. **Typings against the runtime.** The typings of the library are not always what WhatsApp Web hands
   over at run time (ids typed as strings that are objects, the shape of poll options, the `event*`
   fields of a message, and others listed in TDD §2.5). Compare the runtime shapes of the new version
   with its typings again; the mappers accept both forms, and their specs have to keep passing.
6. **Run everything.** `pnpm validate:all`, and the integration suites with `pnpm infra:up` and
   `pnpm test:integration`.
7. **Check it with a real account.** CI cannot reach WhatsApp. Follow "Checking an upgrade of
   whatsapp-web.js with a real account" in [sessions](sessions.md) with a disposable test account and a
   second phone, never a production number, and record the WhatsApp Web build that was used
   (`wwebVersion` of `GET /v1/system/info`) in the pull request. Space the actions out and stop at the
   first restriction notice: a live pass can cost the account.
8. **Open the pull request**, let CI go green and merge it ([contributing](contributing.md)), then deploy.
   If a new build is now the one you checked, move the verified build in the same flow
   ([operations](operations.md), "Moving the verified build").
9. **Rollback.** Redeploy the previous version of the gateway (the previous commit of `main`, built into
   its image). Tagging the images and publishing them from CI arrives with step 11.6 of the plan, so until
   then the rollback is a rebuild of the previous commit.

## Level 3: degrade safely

If neither level helps (the live build is broken and no fix exists yet), the gateway keeps what it can do
and loses nothing that WhatsApp will redeliver:

- The API, the queues, the webhooks and Socket.IO stay up. Sessions sit in `failed` or `disconnected`
  with the cause in `lastError` ([sessions](sessions.md)).
- **Accepted sends wait** in the persistent queue for a session that is not ready, up to
  `SEND_MAX_WAIT_MS` (5 minutes); then they fail with `SESSION_NOT_READY`, which reaches the consumer as
  a `message_failed` event, so it can retry or alert. Nothing is sent twice
  ([send-queue](send-queue.md)).
- **Nothing is lost on the inbound side that WhatsApp keeps.** When a session comes back to `ready` the
  reconciler fetches the recent incoming messages that the gateway never saw and publishes them as a burst
  ([ordering](ordering.md)), within its limits ([limits](limits.md)).
- **Meanwhile, stop the damage:** stop sending on the sessions that fail and leave the rest; switch off a
  feature that is known to be risky with its flag (`ENABLE_GROUP_WRITES` is already off by default);
  alert on `gw_wa_web_drift_errors_total` and the other rules of `ops/prometheus-alerts.yml`
  ([metrics](metrics.md), [operations](operations.md)).
- **If the break is a logout,** do not retry linking right away: read the `logoutReason` in the log first
  ([sessions](sessions.md)).

When the fix exists, go back to Level 1 or Level 2.
