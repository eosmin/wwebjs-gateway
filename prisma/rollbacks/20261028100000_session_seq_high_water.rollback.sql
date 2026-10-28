-- Undoes 20261028100000_session_seq_high_water: the reserved seq blocks are lost, so the next start
-- of each session begins from whatever Redis still holds.
-- The _prisma_migrations table is not touched; to apply the migration again after this script,
-- delete its row first (DELETE FROM _prisma_migrations WHERE migration_name = '20261028100000_session_seq_high_water').

BEGIN;

ALTER TABLE "sessions" DROP COLUMN "seqHighWater";

COMMIT;
