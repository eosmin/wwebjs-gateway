-- Undoes 20261030140000_message_ack_nullable: a message stored without an ack (unknown) gets 0
-- (pending), which is the closest value the old NOT NULL column allowed; that distinction is lost.
-- The _prisma_migrations table is not touched; to apply the migration again after this script,
-- delete its row first (DELETE FROM _prisma_migrations WHERE migration_name = '20261030140000_message_ack_nullable').

BEGIN;

UPDATE "messages" SET "ack" = 0 WHERE "ack" IS NULL;
ALTER TABLE "messages" ALTER COLUMN "ack" SET NOT NULL;

COMMIT;
