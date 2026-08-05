ALTER TABLE "ChangeControlRecord"
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "WebhookDelivery"
  ADD COLUMN "checkPublicationState" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "checkPublicationClaimId" TEXT,
  ADD COLUMN "checkPublicationClaimedAt" TIMESTAMP(3),
  ADD COLUMN "checkExternalId" TEXT;

-- A stored GitHub id proves publication completed. The old timestamp-only
-- lease is externally ambiguous and must never be reclaimed as safe to create.
UPDATE "WebhookDelivery"
SET "checkPublicationState" = CASE
  WHEN "publishedCheckRunId" IS NOT NULL THEN 'published'
  WHEN "checkPublishedAt" IS NOT NULL THEN 'ambiguous'
  ELSE 'pending'
END,
"checkPublicationClaimedAt" = CASE
  WHEN "publishedCheckRunId" IS NULL AND "checkPublishedAt" IS NOT NULL
    THEN "checkPublishedAt"
  ELSE NULL
END,
"checkPublishedAt" = CASE
  WHEN "publishedCheckRunId" IS NOT NULL THEN "checkPublishedAt"
  ELSE NULL
END;

CREATE UNIQUE INDEX "WebhookDelivery_checkExternalId_key"
  ON "WebhookDelivery"("checkExternalId");

CREATE INDEX "WebhookDelivery_checkPublicationState_checkPublicationClaimedAt_idx"
  ON "WebhookDelivery"("checkPublicationState", "checkPublicationClaimedAt");
