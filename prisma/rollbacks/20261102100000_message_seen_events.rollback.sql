-- Undoes 20261102100000_message_seen_events: drops the column. Redis alone deduplicates again, so a
-- Redis that loses its keys can publish a message event a second time (delivery is at-least-once).
-- The _prisma_migrations table is not touched; to apply the migration again after this script,
-- delete its row first (DELETE FROM _prisma_migrations WHERE migration_name = '20261102100000_message_seen_events').

BEGIN;

ALTER TABLE "messages" DROP COLUMN "seenEvents";

COMMIT;
