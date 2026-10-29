# Sessions

A session is one WhatsApp account linked to the gateway, with its own browser. The `SessionManager` owns the whole life of every session: it builds the client, follows the status, brings the session back after a drop and starts the linked sessions again when the gateway boots. The database says which sessions exist and what their last status was; the memory of the process says which ones are running.

## Status

```
created → starting → qr | pairing_code → authenticating → ready
```

Any status can move to `disconnected` or `failed`, and a stop moves it to `stopped`.

| Status           | Meaning                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `created`        | The row exists and was never started, or the account was logged out.                     |
| `starting`       | The browser is launching.                                                                |
| `qr`             | Waiting for a scan. The latest QR code is kept in memory only; it is never persisted.    |
| `pairing_code`   | A pairing code for a phone-number login was issued and is pending.                       |
| `authenticating` | WhatsApp accepted the login; waiting for `ready`.                                        |
| `ready`          | Usable.                                                                                  |
| `disconnected`   | The connection dropped; the manager is waiting to reconnect (see below).                 |
| `stopped`        | Stopped on purpose.                                                                      |
| `failed`         | It cannot recover alone and needs a person: a manual `start` is the only way out.        |

Every change of status is written to the `sessions` row and published as a `session_status` event (`status`, `previous`, `reason`). The event goes through the same queue as the rest of the events of the session, so it carries the next `seq` ([ordering](ordering.md)). A QR code that is replaced by a newer one is not a change of status and publishes nothing. Failing to save or publish a status is logged and never undoes the change: the client has already made it.

The `gw_sessions{status}` gauge counts the sessions of each status.

### What the events of the client do

| Event                          | Result                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `qr`                           | `qr`, with the code cached                                                                              |
| `code`                         | `pairing_code`                                                                                          |
| `authenticated`                | `authenticating`, the QR code is dropped                                                                |
| `ready`                        | `ready` (see below)                                                                                     |
| `auth_failure`                 | `failed`, no retry: the saved login was refused and a new QR is needed                                  |
| `disconnected` with `LOGOUT`   | `created`, no retry; the account, the name and `linkedAt` are cleared and `autoStart` is turned off     |
| `disconnected`, any other cause | reconnect                                                                                              |
| `session_error`                | reconnect                                                                                               |
| `change_state` `CONFLICT`      | `failed` unless `TAKEOVER_ON_CONFLICT=true`; with the takeover on, the adapter takes the session back   |

On `ready` the manager stores `phoneNumber`, `pushName` and `lastConnectedAt`, clears `lastError`, sets `linkedAt` the first time, resets the reconnect counter and applies the flags of the session settings that are set: `autoDownloadAudio`, `autoDownloadDocuments`, `autoDownloadPhotos`, `autoDownloadVideos` and `backgroundSync`. A call that fails is logged and skipped. The catch-up of missed messages listens to the `session_status` event with `ready`.

Once the session is `ready` the reconciler looks for messages that arrived while it was away (see [ordering](ordering.md#catch-up-reconciliation)).

`settings.ordering.enabled` is read when the client starts and decides whether the pipeline orders the inbound messages of that session.

## Reconnecting

After a `disconnected` (not `LOGOUT`), a `session_error` or a browser that does not start, the manager:

1. closes the pipeline of the session, so it flushes what it holds while the client still answers;
2. destroys the client (a destroy that hangs is given up after 15 s);
3. sets `disconnected` with the cause in `lastError`;
4. starts a new client after a wait.

The wait doubles with every attempt, from 5 s up to 5 min, and the gateway uses a random value between half of that and all of it, so a session that keeps failing never retries at once and sessions that dropped together do not come back together. The attempts count from the last `ready`.

`SESSION_RECONNECT_MAX_ATTEMPTS` limits them: `0` means unlimited, any other number ends in `failed` (`lastError: reconnect attempts exhausted`) once the attempts are spent.

A client that was replaced is ignored: whatever it still emits is dropped.

## Watchdog

The watchdog looks at every running session each `WATCHDOG_INTERVAL_MS` (30 s). A pass that finds the previous one still running does nothing. It only reads the state of a client; for a fix it asks the manager, which ignores a request about a run that has moved on (a reconnect, a stop or the next phase came first). The pass does not wait for the request, so a session with a slow teardown does not delay the checks of the others. Each reconnect it asks for counts in `gw_watchdog_restarts_total`, and every action starts with a `session_error` event (`WATCHDOG_START_TIMEOUT`, `WATCHDOG_HEALTH_CHECK` or `WATCHDOG_BLOCKED_STATE`, with the reason as `message`) that arrives before the `session_status` it causes.

| Finding                                                                                                               | What happens                                                                                           |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `starting` or `authenticating` for more than `SESSION_START_TIMEOUT_MS` (180 s)                                       | Reconnect, as after a drop (same wait, same attempt count)                                             |
| `ready` and `getState()` is not `CONNECTED`, throws or takes over 10 s, `WATCHDOG_MAX_FAILURES` (3) checks in a row   | Reconnect (`lastError: health check failed N times`)                                                   |
| `ready` and `getState()` is `UNPAIRED`, `UNPAIRED_IDLE`, `DEPRECATED_VERSION`, `TOS_BLOCK` or `PROXYBLOCK`            | `failed` when two checks in a row read it, `lastError: WhatsApp Web state <state>`; no retry while the gateway runs |
| `ready` and `getState()` is `CONFLICT`                                                                                | As the line above, unless `TAKEOVER_ON_CONFLICT=true`, where it counts as a failed check               |

The time limit counts from the start of the phase: `authenticating` starts when the code is scanned, so the time a person takes to scan is never counted. A session in `qr` or `pairing_code` is never restarted. One answer of `CONNECTED` resets the count of failed checks, and a session that came back with a new browser starts from zero.

A `failed` session keeps `autoStart` on, so the next boot of the gateway tries it once more (a `DEPRECATED_VERSION` is solved by an upgrade, which is a new boot). The second read of a blocking state is a debounce: one transient answer does not end the retries.

The memory guard (`MEMORY_RESTART_THRESHOLD_MB`, 0 = off) restarts the ready session with the biggest browser that is not sending when the gateway process plus the browsers of its sessions pass the limit, at most once every 10 minutes (`session_error` code `WATCHDOG_MEMORY`). How it measures and what "sending" means: [send-queue.md](send-queue.md#memory-guard).

## Commands

| Command        | What it does                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| `create`       | Makes the row (`created`). 409 `SESSION_ALREADY_EXISTS` if it exists, 409 `MAX_SESSIONS_REACHED` at the limit.  |
| `start`        | Builds the client and the pipeline and lets the browser start, and turns `autoStart` back on (a stop or a logout had turned it off). A session that already runs is left as it is. |
| `stop`         | Destroys the client without logging out, `stopped`, `autoStart` off: it does not come back at boot.            |
| `restart`      | `stop` then `start`, keeping `autoStart` as it was. A session that does not run is started without a stop.     |
| `logout`       | Logs the account out and ends as `created`, `autoStart` off. 409 `SESSION_NOT_READY` when there is no client.  |
| `remove`       | Logs out when it can, destroys the client, deletes the row (and with it the keys, hooks and messages) and the Redis keys `seq:<id>` and `dedupe:<id>:*`. |
| `resetState`   | Calls `resetState` of the client of a ready session.                                                           |
| `requireReady` | Gives the client of a ready session; 409 `SESSION_NOT_READY` otherwise, 404 when the session does not exist.   |

The commands and the events of one session run one at a time, so a stop cannot overlap a ready.

`MAX_SESSIONS` counts the sessions that run, including one that waits to reconnect. `create`, `start` and `restart` answer 409 `MAX_SESSIONS_REACHED` while that many run; a session that is stopped, failed or only created does not count.

## REST API

Every route is under `/v1/sessions` and needs an API key ([authentication](authentication.md)). The list and the creation touch every session, so they are `admin` (only admin keys). The routes with a `:sessionId` need the scope in the table, and a key limited to a session reaches only that session: any other id is `403 FORBIDDEN`, checked by the `ApiKeyGuard` for every route with a `:sessionId`.

| Route | Scope | Does |
| --- | --- | --- |
| `POST /v1/sessions` | `admin` | Creates the session as `created` (`id`, `name?`, `autoStart?`, `settings?`). Nothing runs until it is started. `201`. |
| `GET /v1/sessions` | `admin` | Every session, oldest first. |
| `GET /v1/sessions/:sessionId` | `read` | The row: configuration and status. |
| `PATCH /v1/sessions/:sessionId` | `manage` | `name`, `autoStart` and `settings`. It does not restart the session: a running one reads the new settings at its next start. |
| `DELETE /v1/sessions/:sessionId` | `manage` | `remove`. `204`. |
| `POST /v1/sessions/:sessionId/start` `/stop` `/restart` `/logout` | `manage` | The commands above; they answer the session. |
| `POST /v1/sessions/:sessionId/reset-state` | `manage` | `resetState`. `204`; `409 SESSION_NOT_READY` unless the session is ready. |
| `GET /v1/sessions/:sessionId/qr` | `manage` | `{ qr, status }`: the text WhatsApp encodes. `404` when the session shows no QR code. |
| `GET /v1/sessions/:sessionId/qr.png` | `manage` | The same QR code as a PNG (`image/png`). |
| `GET /v1/sessions/:sessionId/state` `/wweb-version` `/info` | `read` | What the client of a ready session answers: the connection state, the WhatsApp Web version and the linked account. `409 SESSION_NOT_READY` otherwise. |

The session DTO has the columns of the row except `seqHighWater`, an internal bigint that never leaves the gateway. `settings` accepts the keys `ordering.enabled`, `autoDownloadAudio`, `autoDownloadDocuments`, `autoDownloadPhotos`, `autoDownloadVideos` and `backgroundSync`, and nothing else; a `PATCH` replaces the keys it names as a whole (the `ordering` object is replaced, its keys are not merged) and keeps the others, including those that other services keep in the same column. The merge is one SQL statement (`jsonb ||`), so concurrent requests, or another service writing its own keys, never overwrite each other. A `PATCH` with no field is `400 VALIDATION_ERROR`. `settings` is returned whole to any key that can read the session, so it never holds a secret: those live in their own tables.

The QR code is a credential until it is scanned: whoever scans it links a device to the account and reads and sends as it, so both routes need `manage` and not `read`, which is in the default scopes of a key (a chatbot key must not be able to ask for it). Besides that, both routes answer `Cache-Control: no-store`, the code is kept in memory only, and it never reaches the logs or the database. WhatsApp renews it every few seconds, so read it again instead of keeping it.

Not part of this pass: the pairing-code routes (`POST` and `DELETE …/pairing-code`) and the battery of the account; the manager has no way yet to reach a client that is not ready.

## Boot and shutdown

When the gateway boots it does not wait for the sessions. In the background it:

1. loads the status of every session;
2. marks as `stopped` the sessions that say they are running (`starting`, `qr`, `ready`, ...) but will not start now: a crash left that status behind and nothing runs for them;
3. starts, one after another, every session with `autoStart` on that was linked before (`linkedAt` set). `SESSION_START_STAGGER_MS` is the wait between two starts, so the browsers do not launch together. A session that cannot start is logged and the next one goes on; one that would pass `MAX_SESSIONS` is skipped.

At shutdown every client is destroyed **without logging out** and the sessions keep the status they had, so the next boot finds them linked. The pending reconnects and the rest of the restore are cancelled, and a start that is in flight finishes up to the launch of the browser and the queued teardown destroys it right after: nothing starts a browser once the shutdown began. The teardown of each session goes through its queue; the manager then closes the pipelines and settles the `seq` bounds from `beforeApplicationShutdown`, while Postgres and Redis are still open.

## Redis restarts and `seq`

`seq` is a Redis counter ([ordering](ordering.md)). Redis runs with AOF `everysec`, so a crash of Redis can lose about one second of increments, and a counter that goes back would repeat numbers already delivered. Two guards keep `seq` strictly increasing:

- **A reserved bound in Postgres** (`sessions.seqHighWater`). Before the first `seq` above the bound is used, the gateway writes a new bound 100 numbers higher. When a session starts, the counter is lifted above the bound, so it starts above everything the session ever delivered, whatever Redis remembers.
- **The last `seq` in memory.** If Redis loses increments while the gateway runs, the next `seq` is taken above the last one and the counter in Redis is corrected. The memory keeps the count of a session until the session is deleted, also while it is stopped (its last `session_status` still needs a `seq`).

A **clean shutdown** of the gateway sets the bound to the last `seq` delivered, so the next boot leaves no gap (best effort: it needs Postgres to answer at that moment). After a crash the bound is still the reserved block, so the first `seq` of the next boot skips up to 100 numbers. `seq` never goes back, but it can skip; a consumer must not read a gap as a lost event.

If Postgres cannot be read when a session starts, the start fails and is retried like any other failure (no events flow without the bound). If a write of the bound fails while the session runs, it is logged and tried again after 5 s with a bound that covers what was delivered meanwhile; until a write succeeds the guarantee is best effort, since the events keep flowing. Writes of the reserved bound only ever raise it, so one that arrives late cannot lower a newer one; only the write of the shutdown lowers it.

The write of a status has the same 5 s limit. If it expires and the database later applies it after a newer status, the row can hold an older status than the process does until the next change of status; the process is always right, and the boot settles any status that says a session runs when it does not.
