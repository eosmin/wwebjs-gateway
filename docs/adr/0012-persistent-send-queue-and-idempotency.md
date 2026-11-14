# ADR 0012: a persistent send queue, an idempotency key, and no blind retry

Status: Accepted (2026-10-28)

## Context

The gateway sends from real accounts, so the two failures that matter are a message the API accepted and
then lost on a restart, and a message sent twice. WhatsApp gives no way to ask whether a send went out
after the call was made: when a call times out or the page dies with the call in flight, the outcome is
unknown.

## Decision

- **Every send goes through a persistent queue.** One BullMQ queue and one worker per session
  (`send-<sessionId>`, concurrency 1) in Redis with AOF, so the messages of a session leave in the order
  they were accepted and survive a restart. Waits (policy, session not ready, pacing, typing) happen
  inside the job, because a delayed job loses its place in line. A send that fails is a finished job with
  `ok: false`, not a failed BullMQ job, which BullMQ would retry.
- **The job is marked dispatched in Redis before the call to WhatsApp.** A failure proven to happen
  before the mark (the session was disconnected, the readiness check timed out) goes back to the line.
  Anything else after the mark is `UNKNOWN_OUTCOME` and is **never retried**. The gateway reports the
  uncertainty and the caller checks the chat.
- **Sends are idempotent.** An `Idempotency-Key` (scoped to the session, at most 128 characters) is
  claimed in Postgres with `INSERT ... ON CONFLICT DO NOTHING` together with a hash of the request, and the
  job id follows from the key. Same key and same request replays the stored outcome and queues nothing;
  same key and another request is `422 IDEMPOTENCY_KEY_REUSED`; a key that failed stays failed for 24 hours.
- **Admission is bounded and honest.** The queue has a limit per session and in total (`429
  SEND_QUEUE_FULL`), and with Redis not ready the answer is `503 QUEUE_UNAVAILABLE` at once instead of a
  wait that ends after the caller has given up and retried.
- **The caller gets the result or a job id.** A synchronous call that cannot finish in time answers `202`
  with the `jobId`; the result arrives as `message_sent` or `message_failed` and at
  `GET /v1/sessions/:id/send-jobs/:jobId`.

## Consequences

- A message accepted by the API is not lost by a restart of the gateway, and is not sent twice by it.
- An unknown outcome is a result the client has to resolve; the gateway does not guess in either
  direction. A key still `pending` five minutes with no job is closed as `UNKNOWN_OUTCOME` and not resent.
- Redis holds message text and chat ids for the lifetime of the jobs (one hour completed, 24 hours
  failed), so access to that Redis and to Bull Board is access to message content.
- A shutdown lets a job in the middle of a call finish within a bound and sends back to the queue a job
  that only waits.

## Alternatives considered

- **An in-memory queue:** loses accepted messages on every restart.
- **Retry every failure:** after an unknown outcome this sends a message twice, to a real person, from a
  real account. A duplicate is worse than a reported uncertainty.
- **A queue in Postgres:** possible, but BullMQ gives per-session lanes, delays and workers already, and
  Redis with AOF is already a dependency.
- **No idempotency key, leaving it to the client:** a client that retries after a timeout is exactly the
  caller that needs it.
