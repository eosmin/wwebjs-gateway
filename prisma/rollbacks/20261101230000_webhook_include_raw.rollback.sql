-- Undoes 20261101230000_webhook_include_raw: drops the column. The per-webhook choice of
-- carrying the raw WhatsApp data is lost; every webhook then follows INCLUDE_RAW again.
-- The _prisma_migrations table is not touched; to apply the migration again after this script,
-- delete its row first (DELETE FROM _prisma_migrations WHERE migration_name = '20261101230000_webhook_include_raw').

BEGIN;

ALTER TABLE "webhooks" DROP COLUMN "includeRaw";

COMMIT;
