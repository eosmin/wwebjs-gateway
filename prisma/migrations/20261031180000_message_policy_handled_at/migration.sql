-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "policyHandledAt" TIMESTAMPTZ(3),
ADD COLUMN     "policyText" TEXT;

-- Rows stored before this migration were never seen by the policy; they are not replayed through
-- it (an old message must not suppress a chat now), so they count as handled.
UPDATE "messages" SET "policyHandledAt" = "createdAt" WHERE "direction" = 'in';

-- CreateIndex
CREATE INDEX "messages_sessionId_direction_policyHandledAt_idx" ON "messages"("sessionId", "direction", "policyHandledAt");
