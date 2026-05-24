-- Make GitHub App installations explicitly approvable before they are trusted
-- by an AgentForge organization, and allow repositories removed from an
-- installation to be archived without deleting historical governance records.

ALTER TABLE "GitHubInstallation"
  ALTER COLUMN "organizationId" DROP NOT NULL,
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'pending_approval',
  ADD COLUMN "approvedBy" TEXT,
  ADD COLUMN "approvedAt" TIMESTAMP(3),
  ADD COLUMN "rejectedBy" TEXT,
  ADD COLUMN "rejectedAt" TIMESTAMP(3),
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "lastWebhookAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "GitHubInstallation"
  DROP CONSTRAINT "GitHubInstallation_organizationId_fkey",
  ADD CONSTRAINT "GitHubInstallation_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE "GitHubInstallation"
SET
  "status" = 'approved',
  "approvedBy" = 'migration',
  "approvedAt" = COALESCE("updatedAt", "createdAt")
WHERE "organizationId" IS NOT NULL;

CREATE INDEX "GitHubInstallation_status_updatedAt_idx"
  ON "GitHubInstallation"("status", "updatedAt");

ALTER TABLE "Repository"
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "archiveReason" TEXT;
