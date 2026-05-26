ALTER TABLE "WebhookDelivery"
  ADD COLUMN "deliveryStatus" TEXT NOT NULL DEFAULT 'received',
  ADD COLUMN "queueJobId" TEXT,
  ADD COLUMN "queuedAt" TIMESTAMP(3),
  ADD COLUMN "processingStartedAt" TIMESTAMP(3),
  ADD COLUMN "completedAt" TIMESTAMP(3),
  ADD COLUMN "publishedCheckRunId" BIGINT,
  ADD COLUMN "checkConclusion" TEXT,
  ADD COLUMN "checkPublishedAt" TIMESTAMP(3),
  ADD COLUMN "lastEnqueueFailureClass" TEXT,
  ADD COLUMN "lastEnqueueFailureMessage" TEXT,
  ADD COLUMN "lastEnqueueFailedAt" TIMESTAMP(3);

UPDATE "WebhookDelivery"
SET
  "deliveryStatus" = CASE
    WHEN "enqueued" = true THEN 'queued'
    ELSE 'received'
  END,
  "queuedAt" = CASE
    WHEN "enqueued" = true THEN "createdAt"
    ELSE NULL
  END;

CREATE INDEX "WebhookDelivery_deliveryStatus_createdAt_idx"
  ON "WebhookDelivery"("deliveryStatus", "createdAt");

WITH ranked AS (
  SELECT
    ctid,
    ROW_NUMBER() OVER (
      PARTITION BY "evaluationId"
      ORDER BY "updatedAt" DESC NULLS LAST, "id" DESC
    ) AS rn
  FROM "CheckRun"
)
DELETE FROM "CheckRun"
WHERE ctid IN (SELECT ctid FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX "CheckRun_evaluationId_key"
  ON "CheckRun"("evaluationId");
