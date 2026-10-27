-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('created', 'starting', 'qr', 'pairing_code', 'authenticating', 'ready', 'disconnected', 'stopped', 'failed');

-- CreateEnum
CREATE TYPE "WebhookMediaMode" AS ENUM ('none', 'reference', 'inline');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('pending', 'success', 'failed');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('in', 'out');

-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('pending', 'done', 'failed');

-- CreateEnum
CREATE TYPE "SuppressionReason" AS ENUM ('manual', 'opt_out');

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "status" "SessionStatus" NOT NULL DEFAULT 'created',
    "phoneNumber" TEXT,
    "pushName" TEXT,
    "autoStart" BOOLEAN NOT NULL DEFAULT true,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastConnectedAt" TIMESTAMPTZ(3),
    "lastEventAt" TIMESTAMPTZ(3),
    "linkedAt" TIMESTAMPTZ(3),
    "lastError" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "sessionId" TEXT,
    "scopes" TEXT[],
    "allowedCidrs" TEXT[],
    "expiresAt" TIMESTAMPTZ(3),
    "rotatedFromId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhooks" (
    "id" UUID NOT NULL,
    "sessionId" TEXT,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" TEXT[] DEFAULT ARRAY['*']::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "mediaMode" "WebhookMediaMode" NOT NULL DEFAULT 'reference',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "webhookId" UUID NOT NULL,
    "sessionId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastStatusCode" INTEGER,
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMPTZ(3),

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_hooks" (
    "id" UUID NOT NULL,
    "sessionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "inbound_hooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "fromMe" BOOLEAN NOT NULL,
    "type" TEXT NOT NULL,
    "body" TEXT,
    "hasMedia" BOOLEAN NOT NULL,
    "ack" INTEGER NOT NULL,
    "sentAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "emittedAt" TIMESTAMPTZ(3),
    "origin" JSONB,
    "dto" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("sessionId","id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "sessionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "messageId" TEXT,
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'pending',
    "response" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("sessionId","key")
);

-- CreateTable
CREATE TABLE "suppressions" (
    "sessionId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "reason" "SuppressionReason" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "suppressions_pkey" PRIMARY KEY ("sessionId","chatId")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_keyHash_key" ON "api_keys"("keyHash");

-- CreateIndex
CREATE INDEX "api_keys_sessionId_idx" ON "api_keys"("sessionId");

-- CreateIndex
CREATE INDEX "webhooks_sessionId_idx" ON "webhooks"("sessionId");

-- CreateIndex
CREATE INDEX "webhook_deliveries_webhookId_createdAt_idx" ON "webhook_deliveries"("webhookId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_idx" ON "webhook_deliveries"("status");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_hooks_tokenHash_key" ON "inbound_hooks"("tokenHash");

-- CreateIndex
CREATE INDEX "inbound_hooks_sessionId_idx" ON "inbound_hooks"("sessionId");

-- CreateIndex
CREATE INDEX "messages_sessionId_chatId_sentAt_idx" ON "messages"("sessionId", "chatId", "sentAt" DESC);

-- CreateIndex
CREATE INDEX "messages_sessionId_emittedAt_idx" ON "messages"("sessionId", "emittedAt");

-- CreateIndex
CREATE INDEX "idempotency_keys_createdAt_idx" ON "idempotency_keys"("createdAt");

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_hooks" ADD CONSTRAINT "inbound_hooks_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
