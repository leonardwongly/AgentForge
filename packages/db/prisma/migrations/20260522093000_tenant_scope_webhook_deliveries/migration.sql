ALTER TABLE "WebhookDelivery"
  ADD COLUMN "organizationId" TEXT,
  ADD COLUMN "repositoryId" TEXT;

CREATE INDEX "WebhookDelivery_organizationId_createdAt_idx"
  ON "WebhookDelivery"("organizationId", "createdAt");

CREATE INDEX "WebhookDelivery_repositoryId_pullRequestNumber_idx"
  ON "WebhookDelivery"("repositoryId", "pullRequestNumber");
