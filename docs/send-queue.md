# The send queue

Every message the gateway sends goes through a persistent queue (TDD §6.8). The goal: **a message the API accepted is not lost on a restart, and is never sent twice.**

## How it is built

- One BullMQ queue and one worker per session, named `send-<sessionId>` (BullMQ rejects a colon in a queue name, so the TDD's `send:<sessionId>` is written with a hyphen). The prefix is fixed, so two ids never give the same name.
- The worker has concurrency 1, so the messages of a session leave in the order they were accepted. A wait (policy delay, session not ready, pacing, typing) is done **inside** the job and never by moving the job to the delayed set, because a delayed job loses its place in the line.
- A job holds everything the send needs (chat, content, options, `humanize`, `Idempotency-Key`), and Redis keeps it on disk (AOF). On boot every session gets its worker back, so the jobs the last run left start draining as soon as the session is ready.
- `removeOnComplete` keeps a finished job for 1 h and `removeOnFail` for 24 h, which is how long `GET /v1/sessions/:id/send-jobs/:jobId` can answer.

A send that fails is a **finished** job (its result says `ok: false` and the error), not a failed BullMQ job: BullMQ would retry the second kind.

## What a job goes through

1. **Not ready.** While the session is not `ready` the job waits and looks again every `SEND_NOT_READY_RETRY_MS`. It gives up with `SESSION_NOT_READY` once `SEND_MAX_WAIT_MS` has passed since it was queued.
2. **Send policy.** `SendPolicyService.admit` answers `allow` (the budgets are spent), `delay` (the worker waits and asks again) or `reject` (the job ends with that code and `details.rule`). A delay beyond `SEND_POLICY_MAX_WAIT_MS` ends as `POLICY_DELAY_EXCEEDED`. See [safety.md](safety.md).
3. **Pacing.** At least `SEND_MIN_INTERVAL_MS` plus a random part up to `SEND_JITTER_MS` between two sends of the session.
4. **Humanize** (only when the request has it): `markSeenFirst`, then the typing or recording state for the requested time (at least `HUMANIZE_MIN_REPLY_DELAY_MS`), renewed every 20 s, and always cleared afterwards, even if the send is given up.
5. **Dispatch.** The job is marked as dispatched in Redis **before** the call to WhatsApp, then `sendMessage` runs.

## When the outcome is unknown

Only a failure *proven* to happen before the dispatch is retried: `WaDisconnectedError` or a timeout whose `dispatched` is false (the readiness check failed before the call). The job goes back to step 1.

Anything else after the dispatch mark is **`UNKNOWN_OUTCOME`** and is never retried: a timeout after dispatch, the page dying with the call in flight, an error nobody expected. The same holds across a restart: if the process dies while a job is marked as dispatched, the next run of that job finds the mark and ends it as `UNKNOWN_OUTCOME` without calling WhatsApp. Before sending such a message again, check the chat or `GET …/messages/:messageId` (`getMessageById`).

A job interrupted by a shutdown while it only waits (not dispatched) goes to the delayed set with the time it had already waited, and the next boot continues it. So that the chat keeps its order, a job that finds an older one delayed makes way (it goes to the delayed set for 1 s; the older job is promoted behind the waiting ones once it is due, so every job looks at the waiting and the delayed list before it goes). The look reads the ids of those jobs and one field of each, the stamp that BullMQ keeps as the job's timestamp, never their data (a backlog of media would otherwise be loaded on every turn). If the job cannot be put aside it is sent anyway: late is better than lost. Two sends accepted at the same moment by different requests may reach Redis in the opposite order of their stamps; the order of simultaneous requests is arbitrary anyway, and the stamp decides it and the older one runs first.

If the worker itself throws (Postgres or Redis failing in the middle of a job), the caller still gets an answer: `INTERNAL` when nothing was dispatched, `UNKNOWN_OUTCOME` when the call may have gone out. The order between jobs rests on a stamp taken when each send is accepted (the clock in milliseconds, forced to grow by at least 1 per call), so two sends in the same millisecond still have an order. A failure of the gateway is not a failure of WhatsApp, so neither the health throttle nor the breaker counts it as bad.

## Results

- **Sync caller** (`wait=true`): `submit` waits up to the time the caller gives (`SEND_SYNC_TIMEOUT_MS` for the API) and returns the outcome. No event is published for it, because the caller already has it.
- **Async or timed-out caller**: the result arrives as `message_sent` or `message_failed` (with the `jobId` and the `idempotencyKey`). The event is published after BullMQ has recorded the job as completed, so a client that reacts to it finds the same answer at `GET …/send-jobs/:jobId`. A crash between the two loses the event, never the result.

## Idempotency

`IdempotentSendService.send` is the entry point for every send that can carry an `Idempotency-Key` (at most 128 characters; the key is scoped to the session). Without a key it queues the send as it is.

- **First use**: the key is claimed in Postgres (`INSERT … ON CONFLICT DO NOTHING`, so two concurrent requests cannot both win) with a hash of the request: chat, content, options and `humanize`, with the keys sorted, so the order of the fields does not matter. The job gets an id that follows from the key, so even a second add would not queue a second message.
- **Same key, same request**: nothing is queued. A finished send answers with the stored outcome (`sent` or `failed`, the same one the first caller got); one still queued or active answers with its `jobId` and no outcome, to be read at `GET …/send-jobs/:jobId` or from `message_sent` / `message_failed`. A replay never waits.
- **Same key, other request**: `422 IDEMPOTENCY_KEY_REUSED`, also after the first send ended.
- **The result is stored when the job ends**, by the send queue, so a replay still gets it after BullMQ has dropped the job (completed jobs are kept one hour, the key 24 hours). A key ends once: a `done` key never turns `failed`.
- **A process that died**: a key still `pending` for 5 minutes with no job in the queue is closed as `failed` with `UNKNOWN_OUTCOME`. It is never sent again; the client checks the chat and uses a new key. A younger `pending` key without a job is taken as a send being queued right now (the replay answers with a `jobId` that may not exist yet).
- **A failed key is final**: even when the failure is certain and nothing was sent (policy refusal, session not ready), the key keeps answering with that failure for 24 hours; the client uses a new key to try again.
- **A send refused before the queue** because the session does not exist releases its key. Any other error while queueing (Redis down, a lost reply) keeps the key `pending`, because the job may be in Redis: the replay finds it, or closes the key as `UNKNOWN_OUTCOME` after the margin above.
- **Limit**: the result is written to Postgres when the job ends. If that write fails and the job is dropped by BullMQ (one hour) before any replay, the key closes as `UNKNOWN_OUTCOME` although the message went out. Nothing is ever resent.
- A row older than 24 hours still counts until the purge runs.
- Keys older than 24 hours are purged by the retention job (step 7.5; until it exists they stay).

## Failure handling

- **Health throttle.** Every outcome goes to `SendPolicyService.recordOutcome`: a WhatsApp error, an `UNKNOWN_OUTCOME` or an ack of -1 counts as bad. When the bad ratio passes `HEALTH_MAX_BAD_RATIO` the budgets are halved for `HEALTH_COOLDOWN_MIN` and `session_error` (`SEND_HEALTH_DEGRADED`) is published.
- **Circuit breaker.** `SEND_BREAKER_THRESHOLD` hard failures in a row pause the queue of that session for `SEND_BREAKER_COOLDOWN_MS` and publish `session_error` (`SEND_BREAKER_OPEN`). A send that works resets the count. The state is in memory: a restart starts with the queue running.
- The accounting around a job (metrics, health, breaker, event) never loses the outcome: if any of it fails, the failure is logged and the result stays in the job.

## What Redis holds

A job keeps the chat id (a phone number), the message text, caption and options, and, once finished, the returned message, for 1 h (completed) or 24 h (failed). Whoever can read that Redis, or sees Bull Board, sees them. A deleted session loses its whole queue.

## Metrics

`gw_send_total{result}` (`sent` or the error code), `gw_send_duration_seconds`, `gw_send_queue_depth{session}`.

## Bull Board

With `BULL_BOARD_ENABLED=true` the dashboard is served at `/admin/queues`, with one queue per session (they appear and disappear with the sessions). It is off by default and then the route answers 404.

- **Login:** HTTP Basic, user `admin`, password the value of `ADMIN_API_KEY` from the environment. Admin keys created or revoked through the API do not change it. A browser cannot send `X-API-Key`, which is why this route has its own login.
- **Brute force:** this route does not go through the guards of the API, so it counts failures itself: ten wrong attempts from one client address (the one `TRUST_PROXY_HOPS` resolves, like the rest of the API) in a minute answer `429` for the rest of that minute. A good login does not clear the count.
- **Headers:** the dashboard needs inline scripts and styles, so its responses (and only its responses) carry a relaxed `Content-Security-Policy`, plus `Cache-Control: no-store` because the job data holds message text.
- The dashboard can retry, clean and delete jobs. Treat the admin key accordingly, and keep the flag off in production unless you are looking at something.

## Memory guard

`MEMORY_RESTART_THRESHOLD_MB` (0 = off) is checked by the watchdog on each pass. It adds the memory of the gateway process and of the browser of every session (Chromium and all the processes it started, read with `ps`, which the Docker image gets from `procps`; a browser whose memory cannot be read counts as zero and is logged once). Shared pages are counted per process, so the figure is an upper bound. Above the limit, the **ready session with the biggest browser that is not sending** is restarted through the normal reconnect path (`session_error` code `WATCHDOG_MEMORY`). After one restart the guard waits 10 minutes, so a gateway that is big on its own does not restart session after session. If every ready session is sending, or the gateway process alone is over the limit (a browser restart cannot fix that), nothing is restarted and a warning is logged.

The check that a session is sending asks the queue, which is true from the dispatch mark until the job is accounted for. A send that starts between the check and the restart ends as `UNKNOWN_OUTCOME`, never as a lost or double message.

## Callers that wait

When the session is deleted, the callers still waiting for one of its jobs are answered at once with `NOT_FOUND`.


`submit(job, { waitMs })` answers its caller from an in-process waiter. If the caller goes away (an aborted HTTP request) the result is handed to nobody and no event is published; the job's result stays available at `GET …/send-jobs/:jobId`. The messages controller (step 5.5) must therefore answer `202` with the `jobId` when it cannot deliver the result, never drop the connection silently.

## Shutdown

`SendQueueService` closes before the sessions are stopped and before Redis closes. Each worker is asked to stop: a job that is only waiting yields (see above), a job in the middle of a call finishes it (bounded by the call timeout, with a 15 s ceiling after which the worker is closed by force). A call that outlives the 15 s ceiling continues against closed connections: the job stays marked as dispatched and the next boot reports `UNKNOWN_OUTCOME` for it, which is safe (no double send) but may hide a message that was in fact delivered.
