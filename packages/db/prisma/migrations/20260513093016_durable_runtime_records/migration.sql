-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "action" TEXT,
    "repositoryFullName" TEXT,
    "pullRequestNumber" INTEGER,
    "headSha" TEXT,
    "enqueued" BOOLEAN NOT NULL DEFAULT false,
    "payloadJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExportJob" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "actor" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "recordCount" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExportJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_deliveryId_key" ON "WebhookDelivery"("deliveryId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_event_action_createdAt_idx" ON "WebhookDelivery"("event", "action", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_repositoryFullName_pullRequestNumber_idx" ON "WebhookDelivery"("repositoryFullName", "pullRequestNumber");

-- CreateIndex
CREATE INDEX "ExportJob_organizationId_createdAt_idx" ON "ExportJob"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "ExportJob_actor_createdAt_idx" ON "ExportJob"("actor", "createdAt");
