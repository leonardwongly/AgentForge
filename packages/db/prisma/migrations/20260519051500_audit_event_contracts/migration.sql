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

UPDATE "AuditEvent"
SET "metadataJson" = jsonb_strip_nulls(
  COALESCE("metadataJson", '{}'::jsonb) ||
  jsonb_build_object(
    'schemaVersion', "schemaVersion",
    'actorRole', "actorRole",
    'source', "source",
    'requestId', "requestId",
    'correlationId', "correlationId",
    'policyVersion', "policyVersion",
    'policyPackId', "policyPackId",
    'policyPackVersion', "policyPackVersion",
    'recordId', CASE WHEN "targetType" = 'change_control_record' THEN "targetId" ELSE "metadataJson"->>'recordId' END
  )
);
