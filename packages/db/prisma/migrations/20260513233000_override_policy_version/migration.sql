ALTER TABLE "OverrideRecord" ADD COLUMN "policyVersion" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "OverrideRecord" ALTER COLUMN "policyVersion" DROP DEFAULT;
