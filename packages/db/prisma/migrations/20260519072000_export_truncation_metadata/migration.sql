ALTER TABLE "ExportJob"
  ADD COLUMN "totalMatchingRecords" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "truncated" BOOLEAN NOT NULL DEFAULT false;

UPDATE "ExportJob"
SET "totalMatchingRecords" = "recordCount"
WHERE "totalMatchingRecords" = 0;

DROP INDEX IF EXISTS "ChangeControlRecord_checkStatus_lifecycle_idx";

-- Rollback reference:
-- CREATE INDEX "ChangeControlRecord_checkStatus_lifecycle_idx"
--   ON "ChangeControlRecord"("checkStatus", "lifecycle");
-- ALTER TABLE "ExportJob"
--   DROP COLUMN IF EXISTS "truncated",
--   DROP COLUMN IF EXISTS "totalMatchingRecords";
