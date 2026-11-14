# ADR 0009: one instance, by design

Status: Accepted (2026-10-27)

## Context

Every session is a Chromium driven by `whatsapp-web.js` (ADR 0004). A browser and its saved login
(`LocalAuth`, a directory under `WWEB_DATA_PATH`) belong to one Node process: two processes on the same
login fight over the profile lock and over the WhatsApp Web session, and WhatsApp itself ends the
older of two connections. Beyond the browsers, the gateway keeps state in process memory on purpose:
the per-chat order buffers (ADR 0011), the circuit breaker of the send queue, the counters of the rate
limit and the in-process `EventBus` that feeds the sockets and the webhook dispatcher.

## Decision

The gateway runs as **one replica**, and the code is written for that:

- no Socket.IO Redis adapter: the sockets of a session live in the process that owns the session;
- no `RemoteAuth` (it exists to move a login between machines, which this design never does);
- the rate limit counters and the breaker state are in memory and reset on a restart;
- the guides say "never scale it horizontally" (the production deployment files are still to come, plan
  steps 11.4 and 11.5, and must set one replica).

Availability comes from a fast restart, not from a second copy. The process shuts down without logging
out, the logins are on a persistent volume, the send queue is in Redis (ADR 0012), held messages are
recovered from Postgres on `ready` (ADR 0011), and `seq` and the replay stream let a consumer pick up
what it missed.

## Consequences

- A restart is a short outage for every session; the sessions come back staggered so the browsers do
  not start together.
- Capacity is vertical: the host is sized from `MAX_SESSIONS` (a Chromium of a few hundred MB each).
- Nothing in the code has to be correct across processes. That removes a class of bugs (duplicate
  sends, split order buffers, two owners of one login) and also means the design does not scale out:
  a second instance would not add capacity, it would break sessions.

## Alternatives considered

- **Several replicas with sticky sessions and the Socket.IO Redis adapter:** each session would still
  need exactly one owner, which means leader election per session and a way to hand a browser over.
  That is a different product, and the failure it protects against (one process down) is covered by a
  restart.
- **`RemoteAuth`:** lets a login move between machines, but stores the login in a remote store, which
  widens the credential surface for a capability the single instance does not need.
- **Active/passive failover:** a second process that waits for the first to die needs a lock with a
  lifetime and gives the same recovery time as a supervised restart.
