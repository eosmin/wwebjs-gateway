# ADR 0007: production is the default mode, and a bad production setup stops the start

Status: Accepted (2026-11-12)

## Context

The QA of milestones 0 to 7 found that the production guards could be walked around or were missing:

- `NODE_ENV` unset or empty fell back to `development`, and the "no placeholders" check only runs in
  production, so a deployment that forgot the variable accepted the public keys of `.env.example`
  (the repository is public). The error details of the HTTP filter and the large-body check also
  read `NODE_ENV === 'production'`.
- Production accepted `ENABLE_DOCS=true`, `CORS_ORIGINS=*` and a webhook allowlist of `0.0.0.0/0`.
- `docker compose up` left the API down: `.env.example` sets `NODE_ENV=development`, which asked for
  `pino-pretty`, a development dependency that the image does not have.
- With Redis unreachable at start the process stayed silent for a minute or more; with Redis lost
  while running, `SIGTERM` took 30 s (the hard exit) because the BullMQ closes wait for a connection
  that does not come back, and because the shutdown re-sent the signal to itself.

## Decision

1. **`NODE_ENV` unset or empty is `production`.** A mistake in the environment must land on the
   strict side. Local runs say `NODE_ENV=development` (`.env.example` does); the image sets
   `production`. Only an explicit `development` or `test` relaxes the checks. The alternative,
   rejecting an empty value, was dropped: it would break every deployment that never needed the
   variable, with no safety gain over the strict default.
2. **In production the start is refused (a message per variable) for** `ENABLE_DOCS=true`,
   `CORS_ORIGINS` containing `*`, and `WEBHOOK_PRIVATE_HOST_ALLOWLIST` with an entry that has a `/0`
   prefix (`0.0.0.0/0`, `::/0`). Narrow ranges (`10.0.0.0/8`) stay allowed.
3. **`pino-pretty` is used only in development and only when it can be resolved**, so the compose
   stack (development values, production image) writes JSON.
4. **Redis is waited for at start for `REDIS_CONNECT_TIMEOUT_MS` (15 s)**, then the process writes
   one `fatal` line naming host and port (never the URL) and exits with code 1. A lost connection
   after the start is still retried without limit (`maxRetriesPerRequest: null` stays, BullMQ needs it).
5. **The shutdown ends with `process.exit(0)` after the hooks** (`useProcessExit`), and with Redis down
   the BullMQ workers and queues are closed with a 1 s bound (`closeWorker`, `closeQueue`). Measured with
   the real image: `SIGTERM` with Redis stopped went from 30 s (hard exit, code 1) to 1 s. The hard exit
   (`HARD_EXIT_MS`, 30 s) stays as the bound for anything else that hangs, for example a browser that
   will not close; the supervisor's grace period must be at least that.

## Consequences

- A `.env` without `NODE_ENV` now needs real secrets. The error says which variable is at fault.
- The CI smoke of the image keeps `NODE_ENV=production` with the narrow values of `.env.example` and
  random secrets; it is the proof that the guards let a correct production start through.
- The production compose and guides (plan steps 11.4 and 11.5) must set the variables explicitly and a
  `stop_grace_period` above the hard exit.

## Alternatives considered

- Reject an empty `NODE_ENV` instead of reading it as production: breaks every deployment that never
  set it, with no safety gain over the strict default.
- Install `pino-pretty` in the image: grows the production image for a development convenience.
- Wait for Redis for ever at start: the supervisor never learns that the gateway cannot work.
