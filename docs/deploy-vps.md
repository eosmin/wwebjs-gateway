# Deploying on a VPS

What the gateway needs from a server, and what the repository provides for it today. **The production
deployment files and their verification are not available yet: they come with step 11 of the plan** (see
"Not available yet" below). This guide does not describe files, scripts or commands that do not exist, and
it does not choose a host: the hosting is an open decision of the owner (`docs/TDD.md` §11). For the same
requirements on a managed platform, read [deploy-railway](deploy-railway.md); for what to keep and how to
restore it, read [backup-restore](backup-restore.md).

## What the gateway needs

| Need           | Detail                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| One process    | **Exactly one replica**: a session's browser and saved login belong to one Node process ([limits](limits.md)) |
| PostgreSQL     | `DATABASE_URL`. The development stack uses PostgreSQL 18 (`docker-compose.yml`). The migrations are applied by the entrypoint before the gateway starts |
| Redis          | `REDIS_URL`, with **persistence on (AOF)** and **no eviction** (`--appendonly yes --maxmemory-policy noeviction` in `docker-compose.yml`): BullMQ keeps the send queue, the delivery queue and the retention jobs there, and an eviction policy would delete jobs without a word |
| A disk that survives | `WWEBJS_DATA_PATH` holds the saved login of every session, which is an account credential; `WWEB_CACHE_PATH` holds the saved WhatsApp Web pages. In the image both are under `/data` (`/data/wwebjs_auth`, `/data/wwebjs_cache`) and have to be a **persistent volume** |
| A browser      | Each started session is its own Chromium, and the gateway needs `PUPPETEER_EXECUTABLE_PATH` to find it. Memory grows with the sessions you start: measure with your own sessions before you size the host (the TDD estimates 200 to 500 MB per session) |
| TLS and WebSocket | Put a reverse proxy in front: TLS ends there, and it has to pass WebSocket upgrades for `/socket.io` ([websocket](websocket.md)) |
| Outbound access | To WhatsApp Web, and to the hosts of your webhooks and media URLs |

## The image

The `Dockerfile` builds a Debian (`bookworm-slim`) image with Node 24.20.0, runs as the non-root user
`node`, listens on port 3000 and sets `NODE_ENV=production`. Its `HEALTHCHECK` calls `GET /health`.
`docker-entrypoint.sh` requires `DATABASE_URL`, runs `prisma migrate deploy`, and then starts the gateway
with `exec`, so the gateway is PID 1 and receives `SIGTERM`.

**The image does not include a browser yet** (the Dockerfile says so in its first lines; Chromium is part of
step 11.1). Until it does, a session started from this image cannot start.

## Configuration

The gateway starts in **production mode whenever `NODE_ENV` is unset or empty**, and in that mode it
refuses to start ([ADR 0007](adr/0007-production-is-the-default-and-fails-fast.md)):

- with the public placeholders of `.env.example` as `ADMIN_API_KEY` or `METRICS_TOKEN`;
- with `ENABLE_DOCS=true`, or `CORS_ORIGINS` containing `*`;
- with a `WEBHOOK_PRIVATE_HOST_ALLOWLIST` entry that has a `/0` prefix.

The variables with no default are `PUBLIC_BASE_URL`, `DATABASE_URL`, `REDIS_URL` and `ADMIN_API_KEY` (32
characters or more). Set `METRICS_TOKEN` (32 or more) if a scraper will read `/metrics`: without it only an
admin key can. All of them are in [config-reference](config-reference.md).

Behind a reverse proxy, `TRUST_PROXY_HOPS` is the number of proxies in front of the gateway, so the
client address (the allowlist of a key and the rate limit) is read from `X-Forwarded-For`. With a value
above `0` the address is whatever the header says, so **only the proxy may be able to reach the port of
the gateway**: publish it to the proxy's network or restrict it with a firewall, never to the internet
([authentication](authentication.md)).

## Probes, shutdown and restarts

- `GET /health` is liveness: `200` while the process runs, also during shutdown, and it does not look at
  Postgres or Redis. `GET /ready` is readiness: `503` when Postgres, Redis or the folder of the saved
  logins fail, or while the gateway shuts down ([system](system.md)).
- On `SIGTERM` the gateway shuts down in order and ends within **30 seconds** at most (a fixed limit of the code, not a variable);
  the supervisor's grace period has to be **longer than that**, or the container is killed in the middle
  of the shutdown ([sessions](sessions.md), [send-queue](send-queue.md)). A restart restores the sessions
  one after another (`SESSION_START_STAGGER_MS`), without a QR code when the volume is intact.
- Restart policy: let the supervisor restart the process when it exits. An invalid environment, or a
  Postgres or Redis that cannot be reached at start, ends the process with a message on stderr and exit code
  1.
- After the start: watch `/ready` and `gw_sessions{status="ready"}`, and load `ops/prometheus-alerts.yml`
  into Prometheus ([metrics](metrics.md), [operations](operations.md)).

## Updating

Build the new image, stop the gateway (the sessions keep their login; the shutdown does not log them
out), start it, and the entrypoint migrates the database. Before a change that carries a migration,
take a backup ([backup-restore](backup-restore.md)). The rollback of a migration is the script of the same
name in `prisma/rollbacks/`; the rollback of the gateway is the previous commit, built again
([upgrading](upgrading.md)).

## Not available yet

These are the pieces the plan assigns to step 11, and the reason this guide stays at requirements:

| Missing                                              | Step   |
| ---------------------------------------------------- | ------ |
| A browser in the image, and the hardened image        | 11.1   |
| `docker-compose.prod.yml` (the dev compose is for a development machine only: default credentials, ports on the loopback) | 11.4 |
| The `deploy/` files (reverse proxy configuration, backup script) and this guide verified end to end on a real server | 11.5 |
| Publishing the image from CI and tagging it            | 11.6   |
| The choice of host                                     | The owner, `docs/TDD.md` §11 |

Until those exist, do not put the gateway in front of real conversations from the development compose.
