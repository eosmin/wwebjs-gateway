# Deploying on a managed container platform (Railway)

The requirements of the gateway when it runs as a single service on a platform such as Railway, and what
the repository provides today. **The deployment files and their verification are not available yet: they
come with step 11 of the plan** (see "Not available yet"). This guide does not describe a Railway
feature, a command or a setting that the repository has not checked, and it does not choose the host: the
hosting is an open decision of the owner (`docs/TDD.md` §11). The requirements are the same ones as for a
server of your own, with more detail in [deploy-vps](deploy-vps.md); what to keep is in
[backup-restore](backup-restore.md).

## The shape of the deployment

One service built from the repository's `Dockerfile`, plus a PostgreSQL and a Redis. The service has to
satisfy these, whatever the platform calls them:

| Requirement                | Why                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| **Replicas = 1**           | A session's browser and login belong to one process. A platform setting that runs a second copy (a scaled service, or an old and a new deployment alive at once) breaks the sessions ([limits](limits.md)) |
| A **persistent volume mounted at `/data`** | `/data/wwebjs_auth` holds the saved logins and `/data/wwebjs_cache` the WhatsApp Web pages (`WWEBJS_DATA_PATH` and `WWEB_CACHE_PATH` already point there in the image). Without a volume, every redeploy loses the logins and every session asks for a QR code again |
| PostgreSQL                 | `DATABASE_URL`. The entrypoint applies the migrations before the gateway starts                  |
| Redis with **persistence on** and **no eviction** | The queues live there (`docker-compose.yml` runs Redis with `--appendonly yes --maxmemory-policy noeviction`); a Redis that evicts keys deletes queued sends and deliveries silently |
| Health check on **`/ready`** (liveness on `/health`) | `/ready` answers `503` when Postgres, Redis or the folder of the logins fail, or while the gateway shuts down ([system](system.md)). The image has its own `HEALTHCHECK` on `/health` |
| A grace period above **30 s** | The shutdown can take up to 30 seconds before the process forces its exit (a fixed limit of the code, not a variable)       |
| Memory for the sessions    | Each started session is its own Chromium: measure with your sessions before you size the service  |

## Variables

The same as everywhere ([config-reference](config-reference.md)); the platform's variables replace
`.env.local`. The image sets `NODE_ENV=production`, so the production checks apply
([ADR 0007](adr/0007-production-is-the-default-and-fails-fast.md)):

- Required, with no default: `PUBLIC_BASE_URL`, `DATABASE_URL`, `REDIS_URL` and `ADMIN_API_KEY` (32
  characters or more, never the placeholder of `.env.example`).
- `METRICS_TOKEN` (32 or more) if something scrapes `/metrics`.
- `ENABLE_DOCS` stays off, `CORS_ORIGINS` has to list real origins (a `*` is refused), and a webhook
  allowlist cannot have a `/0` entry.
- The platform's proxy sits in front of the gateway: set `TRUST_PROXY_HOPS` to the number of proxies, and
  make sure the gateway is not reachable except through them ([authentication](authentication.md)).
- The connection strings of the database and Redis that the platform gives you go in `DATABASE_URL` and
  `REDIS_URL`. Keep them in the platform's secret store, never in the repository.

## Restarts and deploys

A deploy restarts the process: it stops accepting traffic, ends within 30 seconds, and the new process
runs the migrations, listens and restores the sessions one after another
(`SESSION_START_STAGGER_MS`), with no QR code when the volume is intact ([sessions](sessions.md)). Sends
accepted before the restart wait in Redis and continue ([send-queue](send-queue.md)). A deploy that
starts the new copy **before** the old one has stopped runs two replicas for a moment: configure the
platform to stop the old one first.

## Snapshots

Take a copy of the volume and a database backup before a change that carries a migration, and before you
move a WhatsApp Web pin ([backup-restore](backup-restore.md), [upgrading](upgrading.md)). Whether the
platform offers snapshots of a volume, and how to restore them, is something to check on the platform:
the repository has not verified any.

## Not available yet

| Missing                                                                    | Step                         |
| -------------------------------------------------------------------------- | ---------------------------- |
| A browser in the image, and the hardened image                              | 11.1                         |
| The deployment files and this guide verified end to end on a real deployment | 11.5                        |
| Publishing the image from CI                                               | 11.6                         |
| The choice of host                                                         | The owner, `docs/TDD.md` §11 |

Until the image has a browser, a session started from it cannot start.
