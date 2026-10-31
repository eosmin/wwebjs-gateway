-- Undoes 20261031180000_message_policy_handled_at: drops the index and the columns. The record of
-- which incoming messages the send policy already saw (and the short texts pending for it) is lost; nothing else depends on it.
-- The _prisma_migrations table is not touched; to apply the migration again after this script,
-- delete its row first (DELETE FROM _prisma_migrations WHERE migration_name = '20261031180000_message_policy_handled_at').

BEGIN;

DROP INDEX "messages_sessionId_direction_policyHandledAt_idx";
ALTER TABLE "messages" DROP COLUMN "policyHandledAt", DROP COLUMN "policyText";

COMMIT;
