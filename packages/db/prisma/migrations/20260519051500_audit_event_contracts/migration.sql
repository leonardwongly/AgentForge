ALTER TABLE "AuditEvent"
  ADD COLUMN "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "actorRole" TEXT NOT NULL DEFAULT 'system',
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'api',
  ADD COLUMN "requestId" TEXT,
  ADD COLUMN "correlationId" TEXT,
  ADD COLUMN "policyVersion" TEXT,
  ADD COLUMN "policyPackId" TEXT,
  ADD COLUMN "policyPackVersion" TEXT;

UPDATE "AuditEvent"
SET
  "actorRole" = COALESCE(NULLIF("metadataJson"->>'actorRole', ''), "actorRole"),
  "source" = COALESCE(NULLIF("metadataJson"->>'source', ''), "source"),
  "requestId" = COALESCE(NULLIF("metadataJson"->>'requestId', ''), "requestId"),
  "correlationId" = COALESCE(NULLIF("metadataJson"->>'correlationId', ''), "correlationId"),
  "policyVersion" = COALESCE(NULLIF("metadataJson"->>'policyVersion', ''), "policyVersion"),
  "policyPackId" = COALESCE(NULLIF("metadataJson"->>'policyPackId', ''), "policyPackId"),
  "policyPackVersion" = COALESCE(NULLIF("metadataJson"->>'policyPackVersion', ''), "policyPackVersion")
WHERE "metadataJson" IS NOT NULL;

CREATE INDEX "AuditEvent_targetType_targetId_createdAt_idx" ON "AuditEvent"("targetType", "targetId", "createdAt");
CREATE INDEX "AuditEvent_correlationId_idx" ON "AuditEvent"("correlationId");
