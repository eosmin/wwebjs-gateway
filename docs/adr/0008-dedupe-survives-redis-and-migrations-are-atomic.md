# ADR 0008: the event dedupe survives a Redis that loses its keys, and every migration is atomic

Status: Accepted (2026-11-12)

## Context

The QA of milestones 0 to 7 found three places where an ordinary failure left the data in a worse
state than the failure itself:

- The dedupe of inbound events lived only in Redis (`SET dedupe:... NX EX 600`). A Redis that
  restarts without persistence or evicts keys forgets what was published, and wwebjs re-emits
  messages after a reconnect, so consumers saw the same `message` twice.
- A migration that fails halfway must leave the schema as it was. Postgres runs the statements Prisma
  sends in one call as a single implicit transaction, so the five migrations that exist are atomic,
  but nothing required that of the next one, and a migration with `CREATE INDEX CONCURRENTLY` or
  several `COMMIT`s would not be.
- A late copy of a message could lower its stored ack (the upsert wrote whatever ack the copy
  carried), and database errors that waiting would cure (a connection reset, a deadlock, a server
  that is shutting down) were not all classified as transient.

## Decision

1. **The dedupe has a durable half in Postgres.** `messages.seenEvents` lists the events already
   handled for a message. After a message is stored, `message` and `message_create` are recorded with
   one conditional `UPDATE` (`WHERE NOT seenEvents @> ARRAY[event]`), so the first copy wins however
   many race and a copy that finds its name there is dropped. The Redis claim stays as the fast
   path; the row is what survives it. A database that does not answer lets the event through
   (at-least-once, as when Redis is down). The other events keep the Redis dedupe only.
2. **Every new migration is one `BEGIN; ... COMMIT;`**, or carries a line
   `-- no-transaction: <reason>` for the statements Postgres cannot run in a transaction
   (`CREATE INDEX CONCURRENTLY`, `VACUUM`), and then contains no
   `BEGIN`. `pnpm validate:migrations` (CI, `pre-push`, lint-staged) enforces it. The five migrations
   that already ran are listed in `scripts/lib/migration-transactions.ts` and are not edited: their
   checksum is recorded in the databases where they ran, and they are atomic already.
3. **The ack only moves forward in every path.** The upsert of a repeated message does not write the
   ack; it goes through `updateAck`, which is one conditional statement. The reserved `seq` bound
   already only rose (`raiseSeqHighWater`); the one place that lowers it is the shutdown flush, which
   sets it to the last `seq` handed out, never below it.
4. **Transient database errors are recognised by their Postgres code too** (SQLSTATE `08000`, `08001`, `08003`, `08006`, `08007`,
   `40001`, `40P01`, `53300`, `55P03`, `57P01`-`57P03`) and by the socket errors of Node
   (`ECONNRESET`, `ETIMEDOUT`, ...), wherever the driver adapter puts them (`meta.code`,
   `meta.driverAdapterError.cause.originalCode`, `code`, a `cause` chain), besides the Prisma codes.
   Constraint and data errors stay non-transient.

## Consequences

- A flushed Redis no longer duplicates `message` or `message_create`. The cost is one `UPDATE` per
  such event, on the primary key of a row that was just written.
- Messages stored before the migration have an empty `seenEvents`: if Redis lost its keys right at
  the deploy, one repeat of an old message can still be published once.
- `message_ack`, `message_edit` and the other deduplicated events are still at-least-once when Redis
  loses its keys; their consumers already have to be idempotent (the ack only moves forward).
- A migration author who needs a statement outside a transaction has to say why, in the file.

## Alternatives considered

- **A `processed_events` table keyed by session and event key.** It would cover every event, but it
  needs its own retention job and a write per ack. The message row already exists, is already deleted
  by the retention and with its session, and the two events that matter (the ones that republish a
  message) are the ones that can be recorded on it.
- **Reconstructing the dedupe from `emittedAt`.** `message` and `message_create` are two real events
  of one message, published one after the other, so `emittedAt` cannot tell a twin from a repeat.
- **Editing the old migrations to add `BEGIN`/`COMMIT`.** Their recorded checksum would no longer
  match the databases where they ran, for no gain: Postgres already runs each as one transaction.
- **Making every Redis key durable (AOF).** It narrows the loss but does not remove it, and it makes
  the gateway depend on how Redis is configured.
