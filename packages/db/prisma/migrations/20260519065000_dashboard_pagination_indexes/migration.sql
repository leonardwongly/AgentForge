-- Dashboard pagination and filter indexes.
CREATE INDEX "Repository_organizationId_mode_updatedAt_idx"
  ON "Repository"("organizationId", "mode", "updatedAt");

CREATE INDEX "PullRequest_repositoryId_number_updatedAt_idx"
  ON "PullRequest"("repositoryId", "number", "updatedAt");

CREATE INDEX "ChangeControlRecord_checkStatus_updatedAt_idx"
  ON "ChangeControlRecord"("checkStatus", "updatedAt");

CREATE INDEX "ChangeControlRecord_lifecycle_updatedAt_idx"
  ON "ChangeControlRecord"("lifecycle", "updatedAt");

CREATE INDEX "ChangeControlRecord_mode_updatedAt_idx"
  ON "ChangeControlRecord"("mode", "updatedAt");

CREATE INDEX "ChangeControlRecord_policyVersion_updatedAt_idx"
  ON "ChangeControlRecord"("policyVersion", "updatedAt");

CREATE INDEX "ChangeControlRecord_pullRequestNumber_updatedAt_idx"
  ON "ChangeControlRecord"("pullRequestNumber", "updatedAt");

-- Rollback reference:
-- DROP INDEX IF EXISTS "ChangeControlRecord_pullRequestNumber_updatedAt_idx";
-- DROP INDEX IF EXISTS "ChangeControlRecord_policyVersion_updatedAt_idx";
-- DROP INDEX IF EXISTS "ChangeControlRecord_mode_updatedAt_idx";
-- DROP INDEX IF EXISTS "ChangeControlRecord_lifecycle_updatedAt_idx";
-- DROP INDEX IF EXISTS "ChangeControlRecord_checkStatus_updatedAt_idx";
-- DROP INDEX IF EXISTS "PullRequest_repositoryId_number_updatedAt_idx";
-- DROP INDEX IF EXISTS "Repository_organizationId_mode_updatedAt_idx";
