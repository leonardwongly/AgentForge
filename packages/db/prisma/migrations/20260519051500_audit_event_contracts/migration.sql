ALTER TABLE "AuditEvent"
  ADD COLUMN "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "actorRole" TEXT NOT NULL DEFAULT 'system',
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'api',
  ADD COLUMN "requestId" TEXT,
  ADD COLUMN "correlationId" TEXT,
  ADD COLUMN "policyVersion" TEXT,
  ADD COLUMN "policyPackId" TEXT,
  ADD COLUMN "policyPackVersion" TEXT;

UPDATE "AuditEvent" AS audit
SET
  "actorRole" = COALESCE(NULLIF(audit."metadataJson"->>'actorRole', ''), audit."actorRole"),
  "source" = COALESCE(
    NULLIF(audit."metadataJson"->>'source', ''),
    CASE
      WHEN audit."actor" = 'system' AND audit."action" = 'check_published' THEN 'worker'
      ELSE audit."source"
    END
  ),
  "requestId" = COALESCE(NULLIF(audit."metadataJson"->>'requestId', ''), audit."requestId"),
  "correlationId" = COALESCE(NULLIF(audit."metadataJson"->>'correlationId', ''), audit."correlationId"),
  "policyVersion" = COALESCE(
    NULLIF(audit."metadataJson"->>'policyVersion', ''),
    audit."policyVersion",
    (
      SELECT ccr."policyVersion"
      FROM "ChangeControlRecord" AS ccr
      WHERE ccr."id" = audit."targetId"
      LIMIT 1
    ),
    (
      SELECT pv."version"
      FROM "PolicyVersion" AS pv
      WHERE pv."contentHash" = audit."targetId"
        AND (audit."repositoryId" IS NULL OR pv."repositoryId" = audit."repositoryId")
      ORDER BY pv."createdAt" DESC
      LIMIT 1
    )
  ),
  "policyPackId" = COALESCE(
    NULLIF(audit."metadataJson"->>'policyPackId', ''),
    audit."policyPackId",
    (
      SELECT ccr."policyPackId"
      FROM "ChangeControlRecord" AS ccr
      WHERE ccr."id" = audit."targetId"
      LIMIT 1
    ),
    (
      SELECT pv."policyPackId"
      FROM "PolicyVersion" AS pv
      WHERE pv."contentHash" = audit."targetId"
        AND (audit."repositoryId" IS NULL OR pv."repositoryId" = audit."repositoryId")
      ORDER BY pv."createdAt" DESC
      LIMIT 1
    )
  ),
  "policyPackVersion" = COALESCE(
    NULLIF(audit."metadataJson"->>'policyPackVersion', ''),
    audit."policyPackVersion",
    (
      SELECT ccr."policyPackVersion"
      FROM "ChangeControlRecord" AS ccr
      WHERE ccr."id" = audit."targetId"
      LIMIT 1
    ),
    (
      SELECT pp."version"
      FROM "PolicyVersion" AS pv
      JOIN "PolicyPack" AS pp ON pp."id" = pv."policyPackId"
      WHERE pv."contentHash" = audit."targetId"
        AND (audit."repositoryId" IS NULL OR pv."repositoryId" = audit."repositoryId")
      ORDER BY pv."createdAt" DESC
      LIMIT 1
    )
  );

UPDATE "AuditEvent" AS audit
SET "metadataJson" = jsonb_strip_nulls(
  COALESCE(audit."metadataJson", '{}'::jsonb) ||
  jsonb_build_object(
    'schemaVersion', audit."schemaVersion",
    'actorRole', audit."actorRole",
    'source', audit."source",
    'requestId', audit."requestId",
    'correlationId', audit."correlationId",
    'policyVersion', audit."policyVersion",
    'policyPackId', audit."policyPackId",
    'policyPackVersion', audit."policyPackVersion",
    'recordId', COALESCE(
      audit."metadataJson"->>'recordId',
      CASE WHEN audit."targetType" = 'change_control_record' THEN audit."targetId" END,
      CASE
        WHEN audit."targetType" = 'evidence_requirement' THEN (
          SELECT ccr."id"
          FROM "EvidenceRequirementRecord" AS evidence
          JOIN "Evaluation" AS evaluation ON evaluation."id" = evidence."evaluationId"
          JOIN "ChangeControlRecord" AS ccr ON ccr."pullRequestId" = evaluation."pullRequestId"
          WHERE evidence."id" = audit."targetId"
          LIMIT 1
        )
      END,
      CASE
        WHEN audit."targetType" = 'reviewer_requirement' THEN (
          SELECT ccr."id"
          FROM "ReviewerRequirementRecord" AS reviewer
          JOIN "Evaluation" AS evaluation ON evaluation."id" = reviewer."evaluationId"
          JOIN "ChangeControlRecord" AS ccr ON ccr."pullRequestId" = evaluation."pullRequestId"
          WHERE reviewer."id" = audit."targetId"
          LIMIT 1
        )
      END
    )
  )
);
