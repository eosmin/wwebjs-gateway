# Operations

How to run the gateway with real accounts: what to watch, when to stop, and what to do when WhatsApp Web changes under it. The numbers of the metrics are in [`metrics.md`](metrics.md), the settings in [`config-reference.md`](config-reference.md), the session life cycle and the live checks of a new library version in [`sessions.md`](sessions.md).

## The risk, and the official path

This gateway automates **WhatsApp Web** with an unofficial library. Doing that to an account can break WhatsApp's Terms of Service, and WhatsApp can restrict or ban a number for it, without notice and without a way to appeal that this project controls. A restricted test account was already seen during the live checks (see `sessions.md`). Two consequences:

- **Treat every linked number as expendable.** Never link the number of something the business cannot lose; keep the phone near, with the app up to date; keep the saved logins (`WWEBJS_DATA_PATH`) as the credentials they are.
- **For what is critical, use the official route.** The WhatsApp Business Platform (the Cloud API of Meta) is the supported way to send and receive messages at scale and to reach customers outside a conversation window with approved templates. This gateway is for legitimate, consent-based conversations and chatbots where the risk of the unofficial route is accepted; it is not a replacement for the official API for notifications, billing, authentication codes or anything a customer must receive. Move such flows to the official API, and keep this gateway for the conversational part.

This is operational guidance, not legal advice: read the current WhatsApp terms for your case.

## Pilot rollout

The first weeks in production are a bounded pilot, not a launch. The aim is to find out how the real accounts behave before the volume is the real volume.

**Start small.**
1. One session, one number you can afford to lose, on the pinned build (see below). Keep `ENABLE_ADD_PARTICIPANTS=false` and `ALLOW_COLD_SENDS=false`.
2. A handful of chats that wrote to you first (people who expect the messages). No broadcasts, no first messages to strangers.
3. Leave the warm-up on (`WARMUP_DAYS=14`, `WARMUP_START_FRACTION=0.1`): a new session starts at a tenth of its limits and ramps up.
4. Load [`ops/prometheus-alerts.yml`](../ops/prometheus-alerts.yml) before the first message, and send its alerts to someone who will read them the same day.

**Grow only when a stage is clean.** A stage is a period (a few days) with no alert of severity critical, and with the checks below as expected. Then double one thing at a time: the number of chats, then the daily volume, then a second session. Never raise the policy limits (`SESSION_MAX_PER_*`, `PER_CHAT_*`) to make a queue shorter: a faster send rate is what gets a number restricted.

**What to look at, daily during the pilot.**
- `gw_sessions{status="ready"}` is as many as the sessions you linked; `GET /v1/system/info` shows `wwebVersion` for each (and `gw_wa_web_build_info` the build).
- `gw_logout_total` did not move. One logout is an event to understand, not to retry (see the alert).
- The replies of the chats: ask the owner of the test chats whether messages arrived once, in order, and not late.
- `gw_send_total` by `result`: nearly all `sent`; the refusals of the send policy (`gw_policy_decisions_total`) are expected and are the policy working.
- `gw_webhook_deliveries_total{result="failed"}` and the delivery list of each webhook: the consumer must keep up.
- On the phone of the number: the "linked devices" list, and whether WhatsApp showed any warning about the account.

**Stop criteria. Stop sending (`POST /v1/sessions/:id/stop`, or stop the consumer) and look before going on, when any of these happens.**
- The account is logged out (`GatewaySessionLoggedOut`) or the saved login is quarantined (`GatewayAuthQuarantined`). Do not link it again within the hour; find the reason first.
- WhatsApp shows a warning, a temporary restriction or a request to verify on the phone.
- Recipients report messages that arrive twice, late, or that they never asked for.
- More than a fifth of the sends fail in WhatsApp Web (`GatewaySendFailures`), or a `502` with `[signature]` or `[lazy-module]` appears (WhatsApp Web changed, see the next section).
- The queue keeps growing for 15 minutes (`GatewaySendQueueBacklog`): the session is not sending, and more traffic will not help.

**What the pilot answers before the full volume.** Whether the number survives two weeks at the warm-up pace; how often WhatsApp Web changes break something (and how long the repair takes); whether the consumer handles the events in order and without duplicates; and whether the alerts were useful or noisy. Adjust the alerts from that, not before.

## What to do when WhatsApp Web changes

WhatsApp Web is not a fixed program. It ships a new build every few hours (three on one day in November 2026), and the page can reload itself to take it. The library calls functions inside the page by name; a build can rename them, change their arguments or drop them. The gateway then answers errors although nothing changed on our side.

**Symptoms.**
- A `502` (`WHATSAPP_ERROR`) whose cause in the logs reads `[signature] <module>.<function> is not available in WhatsApp Web <build>`, or `[lazy-module] <module> is not available ...`, or a `TypeError` in `PAGE_ERROR`: a function the library calls is gone or has another shape.
- Sessions logged out (`gw_logout_total`, the `LOGOUT` warning with `logoutReason`), or a session that goes back to `created` without anyone asking.
- Events dropped (`gw_events_skipped_total`), a calls hook that stops reporting, media that fails.
- Two builds at once (`GatewayWhatsAppWebBuildsMixed`) or an unknown one (`GatewayWhatsAppWebBuildUnknown`).

**Steps.**
1. **Confirm the build.** `GET /ready` and `GET /v1/system/info` (the `wwebVersion` of each session) and `gw_wa_web_build_info`. Compare with `WWEB_VERIFIED_BUILD` if you set it: a session on another build logs a warning when it becomes ready. The last build checked live is in `sessions.md`.
2. **Do not retry blindly.** A failure after a send was dispatched has an unknown outcome; sends are idempotent with `Idempotency-Key`, so repeat only with the same key. After a logout, do not link the number again at once.
3. **Look at the release watch.** The job `wwebjs release watch` (`.github/workflows/wwebjs-watch.yml`) opens one issue when npm has a newer `whatsapp-web.js`. It does **not** look at the WhatsApp Web build: a break can come without any release. If a newer library exists, read its notes; fixes for new builds often arrive there first.
4. **Find what changed, without an account.** Follow the procedure of `sessions.md` ("Checking an upgrade of whatsapp-web.js with a real account", step 5 and the probe for modules): open WhatsApp Web in a browser of your own with a throwaway profile (never a profile of a session), without linking anything, and read the signature of the functions in the `[signature]` message. Compare with what `node_modules/whatsapp-web.js/src` passes. The findings of earlier rounds are in the plan (`IMPLEMENTATION_PLAN.md`, 10.4) and in the patch (`patches/whatsapp-web.js@1.34.8.patch`): a function that changed from positional arguments to one object is fixed there, with a test that uses a fake `window`.
5. **Put the fix in the patch, test it, verify it live.** Change the patch with `pnpm patch whatsapp-web.js@<version>` and `pnpm patch-commit`, add the test, and run the live checks of `sessions.md` with a test account before it reaches production.
6. **Meanwhile, stop the damage.** Stop sending on the sessions that fail, and keep the rest. For a feature that is known to be risky, use its flag (`ENABLE_ADD_PARTICIPANTS`).
7. **Pin a build that was checked, to stop moving.** See the next part.

### Pinning a WhatsApp Web build

`WWEB_VERSION=<build>` with `WWEB_VERSION_CACHE_TYPE=local` and `WWEB_VERSION_STRICT=true` makes the gateway load the saved HTML of that build instead of the live one. Read these limits before you rely on it:

- **What is saved is the entry page of that build** (a small HTML file with the addresses of its scripts), kept as `<WWEB_CACHE_PATH>/<build>.html`. The scripts themselves are still downloaded from WhatsApp's servers. The pin works **only while WhatsApp keeps serving the files of that build**. When it retires them, or expires an old client, the pinned build stops loading (with `STRICT` the session fails to start, which is what you want: it says so), and the pin must move to a newer build.
- **There is no saved page of the build that was checked best today.** The first live pass of F9b (media, groups, restarts, relogin) ran on build 2.3000.1054292354, and nobody kept `2.3000.1054292354.html`. It cannot be rebuilt from this repository, and WhatsApp serves another build by now. The builds after it were seen with problems (sessions logged out after `participants add`, no cause proven). So today there is **no good snapshot to pin**: the first one has to be made from a build that passes the live checks.
- **How a snapshot is made.** Start the gateway without `WWEB_VERSION` and with `WWEB_VERSION_CACHE_TYPE=local` (the default). When the session is ready, the library has saved the page it loaded as `<WWEB_CACHE_PATH>/<build>.html`, named by the build (read from the source of `whatsapp-web.js` 1.34.8, `LocalWebCache`; check that the file is there and that its name matches `wwebVersion`). Run the live checks of `sessions.md` on that build. If they pass, copy the file to a place that is backed up (not into the repository: it is WhatsApp's page, and the repository is public) and set `WWEB_VERSION` to that build, `WWEB_VERSION_STRICT=true`, and `WWEB_VERIFIED_BUILD` to the same value. Record the build in the pull request that moves the pin.
- **Do not use the remote cache of a third party** (`WWEB_VERSION_CACHE_TYPE=remote`, for example a public list of saved WhatsApp Web pages). The page it serves runs **inside the browser that is linked to the account**: whoever controls that host controls the account. If you need remote snapshots, host them yourself.
- **Moving the pin is a change like any other**: take the new live build, run the checks, save its page, change the three values, restart (the sessions of the volume come back without a QR code), and keep the previous page for a rollback. The rollback of an image is the previous tag.

### What the logs and metrics say

| Where | What | Meaning |
| --- | --- | --- |
| warn | `WhatsApp Web build changed from X to Y` | A session became ready on a build different from the last one seen |
| warn | `WhatsApp Web build X is not the verified build Y` | `WWEB_VERIFIED_BUILD` is set and this session runs another build (once per build) |
| warn | `WhatsApp Web reported a LOGOUT (…, logoutReason=N)` | WhatsApp Web logged the session out; `0` fatal failure of the page, `1` sync failure, `2` initial history sync timeout, `3` account locked, none: unlinked on the phone or revoked |
| debug | `WhatsApp Web page: …`, `…page before the logout: …` | The few fixed console lines about a reload or logout (numbers and addresses masked) |
| metric | `gw_wa_web_build_info{version}` | Sessions per build; more than one version is a mixed fleet |
| metric | `gw_logout_total{reason}` | Logouts by reason |

## Alerts

[`ops/prometheus-alerts.yml`](../ops/prometheus-alerts.yml) holds the rules. Put it under `rule_files:` of Prometheus and set the `job` of the `GatewayDown` rule to the name of your scrape job. Each rule has a `description` (what fires it and why that threshold) and an `action` (what to do first). The thresholds are small because the gateway is one instance with a few sessions; raise them with your volume. A test (`tests/ops/prometheus-alerts.spec.ts`) fails when a rule cites a series or label that [`metrics.md`](metrics.md) does not have, so a renamed metric cannot leave an alert that never fires.

Two series are defined but not written by the code yet (`gw_wa_call_duration_seconds`, `gw_wa_call_errors_total`); no alert uses them (plan 10.4).
