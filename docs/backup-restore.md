# Backup and restore

What holds state, what is lost if each piece is lost, and how to copy and restore it with the standard
tools. **The backup script of the project and the verification of a restore on a real deployment are not
available yet: they come with step 11.5 of the plan.** What follows uses `pg_dump`, `pg_restore` and `tar`
directly, and it has not been run as a drill on a production deployment. The requirements of the
deployment are in [deploy-vps](deploy-vps.md) and [deploy-railway](deploy-railway.md).

**A backup of the saved logins is a copy of the WhatsApp accounts.** Whoever holds it can use them. Encrypt
it, keep it where only the operator can read it, never put it in the repository, in a chat or in a
ticket, and delete the copies you no longer need.

## What holds what

| Where                              | What it holds                                                                  | If it is lost                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `WWEBJS_DATA_PATH` (`/data/wwebjs_auth` in the image) | One folder per session, `session-<id>`: the saved login. A `.quarantine` folder holds the logins the gateway moved aside ([sessions](sessions.md)) | **Every session asks for a QR code again.** There is no way to recover a login that was never copied |
| `WWEB_CACHE_PATH` (`/data/wwebjs_cache`) | The saved WhatsApp Web pages, among them the one you pinned with `WWEB_VERSION` ([upgrading](upgrading.md)) | Nothing is lost that cannot be made again, except a pinned page that is no longer served by WhatsApp |
| PostgreSQL                         | Sessions (status, `linkedAt`, `seqHighWater`, settings), API keys (hashes), webhooks and their secrets, the delivery history, inbound hooks, the stored messages, idempotency keys, the **suppression list** | See below |
| Redis                              | The send queue, the delivery queue, the retention jobs, the dedupe keys, the `seq` counters, the replay stream of the events, the caches | See below |
| `ADMIN_API_KEY`, `METRICS_TOKEN`   | The environment of the deployment, never the repository                          | Set new ones; database keys keep working                           |

### If PostgreSQL is lost

The gateway starts on an empty database after the migrations, but everything it knew is gone:

- **API keys** stop working (only `ADMIN_API_KEY` does), and every application has to receive a new one
  ([authentication](authentication.md)).
- **Webhooks** and their secrets are gone: every receiver needs a new webhook and a new secret
  ([webhooks](webhooks.md)).
- **The suppression list** is gone, which includes people who asked not to be contacted
  ([safety](safety.md)). This is the loss with consequences for them, so restore it before you send
  again.
- Stored messages, the delivery history and the idempotency keys are gone, and the warm-up of the send
  policy starts again, because it counts from `linkedAt` of the session.
- The saved logins on disk are untouched, and a session created again with **the same id** reuses the
  login of its folder ([sessions](sessions.md)).

### If Redis is lost

Sessions, keys and webhooks are intact, because they live in Postgres. What is lost is what was in flight:

- **Queued sends** disappear. Their `Idempotency-Key` rows in Postgres stay `pending` and close as
  `UNKNOWN_OUTCOME` after five minutes: the caller has to look at the chat before it sends again
  ([send-queue](send-queue.md)).
- **Deliveries that were waiting for a retry** lose their job; the sweep (every 10 minutes) moves them to
  the dead letters, from where `retry-failed` sends them ([webhooks](webhooks.md)).
- **`seq` does not go back.** The counter is lifted above the bound reserved in Postgres when a session
  starts, so a restore of Redis from an older copy cannot make an event reuse a number
  ([sessions](sessions.md)). It can skip.
- The replay stream is gone: a socket that reconnects cannot replay what it missed
  ([websocket](websocket.md)).
- The Redis dedupe keys are gone. `message` and `message_create` have a durable twin in Postgres; the
  other events are published at least once and may repeat after a reconnect ([ordering](ordering.md)).

Redis runs with AOF so that a restart of Redis alone loses almost nothing. A backup of Redis is rarely
worth restoring: a copy that is hours old holds queues that are stale.

## Taking a backup

**Stop the gateway first and take both copies in the same stopped window**, so that the database and the
logins describe the same moment and the profiles of the browsers are not being written. Stopping the
gateway destroys the clients **without logging out**: the sessions keep their login
([sessions](sessions.md)). Postgres and Redis keep running.

**1. PostgreSQL.**

```bash
pg_dump --format=custom --file=gateway.dump "$DATABASE_URL"
```

The dump includes the table of applied migrations, so the gateway sees them as applied on restore.

**2. The saved logins**, with `/data` as the volume of the image:

```bash
tar -czf wwebjs_auth.tgz -C /data wwebjs_auth
```

Add `wwebjs_cache` if you pinned a WhatsApp Web build. Start the gateway again when the copies are
done. Encrypt the archives before they leave the host, and copy them **off the machine**: a backup on
the same disk is lost with it.

**3. How often.** The interval between backups is how much you can lose. An old copy of a login can be
refused by WhatsApp, so take the copy of the logins and the database dump at the same time. The project makes no promise about recovery point or recovery time: they
are the ones of your schedule and your restore procedure.

## Restoring

Restore into an **empty** database and an **empty** data folder, with the gateway stopped.

**1. PostgreSQL.**

```bash
pg_restore --no-owner --exit-on-error --single-transaction --dbname "$DATABASE_URL" gateway.dump
```

Check that it finished without an error **before** you start the gateway: a half restored database
looks healthy and can be missing rows, the suppression list among them.

**2. The saved logins.**

```bash
tar -xzf wwebjs_auth.tgz -C /data
```

The folder has to belong to the user the gateway runs as (`node` in the image).

**3. Start the gateway.** The entrypoint applies any migration that the dump did not have, the gateway
listens, and the sessions with `autoStart` on that were linked before come back one after another
(`SESSION_START_STAGGER_MS`). Check `/ready` and the status of each session.

What to expect:

- A session whose copy of the login is **current** returns to `ready` with no QR code. If WhatsApp
  refuses an old copy (the device was unlinked on the phone, or the login moved on), the session
  fails to start (`initialize failed`), and the account may have to be linked again with a QR code: what
  the gateway does with a login that WhatsApp refuses, including moving it to `.quarantine`, is in
  [sessions](sessions.md).
- **Never run a restored copy while the original still runs.** Two clients on one login
  conflict: WhatsApp Web reports the `CONFLICT` state ([sessions](sessions.md)).
- A migration is undone, if you must, with the script of the same name in `prisma/rollbacks/`, run
  against the database by hand and newest first.

## Not available yet

| Missing                                                                       | Step |
| ----------------------------------------------------------------------------- | ---- |
| The backup script of the project (database and saved logins) and its schedule  | 11.5 |
| This procedure verified end to end, with a restore on a real deployment        | 11.5 |
| An off-box copy configured by the project                                      | 11.5 |
| The choice of host and of its snapshot mechanism                               | The owner, `docs/TDD.md` §11 |
