BEGIN;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "seenEvents" TEXT[] DEFAULT ARRAY[]::TEXT[];

COMMIT;
