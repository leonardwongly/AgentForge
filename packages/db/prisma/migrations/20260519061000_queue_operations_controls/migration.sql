ALTER TABLE "WebhookDelivery"
  ADD COLUMN "evaluationAttemptsMade" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "evaluationTerminalFailure" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "lastFailureClass" TEXT,
  ADD COLUMN "lastFailureMessage" TEXT,
  ADD COLUMN "lastFailureCorrelationId" TEXT,
  ADD COLUMN "lastFailedAt" TIMESTAMP(3),
  ADD COLUMN "replayCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastReplayedAt" TIMESTAMP(3),
  ADD COLUMN "lastReplayedBy" TEXT;

CREATE INDEX "WebhookDelivery_evaluationTerminalFailure_lastFailedAt_idx"
  ON "WebhookDelivery"("evaluationTerminalFailure", "lastFailedAt");
