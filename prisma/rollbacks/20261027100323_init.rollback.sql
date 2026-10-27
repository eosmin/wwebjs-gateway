-- Undoes 20261027100323_init: tables first (children before parents), then the enum types they used.
-- The _prisma_migrations table is not touched; to apply the migration again after this script,
-- delete its row first (DELETE FROM _prisma_migrations WHERE migration_name = '20261027100323_init').

BEGIN;

DROP TABLE "suppressions";
DROP TABLE "idempotency_keys";
DROP TABLE "messages";
DROP TABLE "inbound_hooks";
DROP TABLE "webhook_deliveries";
DROP TABLE "webhooks";
DROP TABLE "api_keys";
DROP TABLE "sessions";

DROP TYPE "SuppressionReason";
DROP TYPE "IdempotencyStatus";
DROP TYPE "MessageDirection";
DROP TYPE "DeliveryStatus";
DROP TYPE "WebhookMediaMode";
DROP TYPE "SessionStatus";

COMMIT;
