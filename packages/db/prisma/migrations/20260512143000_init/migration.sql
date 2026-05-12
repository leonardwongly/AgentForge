-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "PolicyMode" AS ENUM ('observe', 'warn', 'enforce');

-- CreateEnum
CREATE TYPE "EvaluationStatus" AS ENUM ('pass', 'warn', 'block');

-- CreateEnum
CREATE TYPE "FactConfidence" AS ENUM ('verified', 'observed', 'inferred', 'attested');

-- CreateEnum
CREATE TYPE "FindingSeverity" AS ENUM ('critical', 'high', 'medium', 'low');

-- CreateEnum
CREATE TYPE "LifecycleState" AS ENUM ('opened', 'evaluated', 'blocked', 'warned', 'passed', 'overridden', 'merged', 'closed');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitHubInstallation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "githubInstallationId" BIGINT NOT NULL,
    "accountLogin" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitHubInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Repository" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "githubRepositoryId" BIGINT NOT NULL,
    "fullName" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL,
    "protected" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "currentPolicyVersionId" TEXT,
    "mode" "PolicyMode",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Repository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PullRequest" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "githubPullRequestId" BIGINT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "authorLogin" TEXT NOT NULL,
    "baseBranch" TEXT NOT NULL,
    "headBranch" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "mergedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PullRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyPack" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "builtIn" BOOLEAN NOT NULL DEFAULT true,
    "defaultMode" "PolicyMode" NOT NULL,
    "contentYaml" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PolicyPack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyVersion" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "repositoryId" TEXT,
    "policyPackId" TEXT,
    "version" TEXT NOT NULL,
    "mode" "PolicyMode" NOT NULL,
    "contentYaml" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evaluation" (
    "id" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "policyVersionId" TEXT NOT NULL,
    "mode" "PolicyMode" NOT NULL,
    "status" "EvaluationStatus" NOT NULL,
    "headSha" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "explanationJson" JSONB NOT NULL,

    CONSTRAINT "Evaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerifiedFactRecord" (
    "id" TEXT NOT NULL,
    "evaluationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "path" TEXT,
    "evidence" TEXT NOT NULL,
    "confidence" "FactConfidence" NOT NULL,
    "severity" "FindingSeverity",
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerifiedFactRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceRequirementRecord" (
    "id" TEXT NOT NULL,
    "evaluationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "source" TEXT,
    "requiredByFindingId" TEXT NOT NULL,
    "providedBy" TEXT,
    "providedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "contentSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvidenceRequirementRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewerRequirementRecord" (
    "id" TEXT NOT NULL,
    "evaluationId" TEXT NOT NULL,
    "reviewer" TEXT NOT NULL,
    "reviewerType" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "triggeredByFindingId" TEXT NOT NULL,
    "clearsWhen" TEXT,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewerRequirementRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OverrideRecord" (
    "id" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "evaluationId" TEXT,
    "actor" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "visibleInPr" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OverrideRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckRun" (
    "id" TEXT NOT NULL,
    "evaluationId" TEXT NOT NULL,
    "githubCheckRunId" BIGINT,
    "conclusion" TEXT NOT NULL,
    "outputTitle" TEXT NOT NULL,
    "outputSummary" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeControlRecord" (
    "id" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "repositoryFullName" TEXT NOT NULL,
    "pullRequestNumber" INTEGER NOT NULL,
    "headSha" TEXT NOT NULL,
    "baseBranch" TEXT NOT NULL,
    "mode" "PolicyMode" NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "policyPackId" TEXT,
    "policyPackVersion" TEXT,
    "checkStatus" "EvaluationStatus" NOT NULL,
    "lifecycle" "LifecycleState" NOT NULL,
    "verifiedFindingsJson" JSONB NOT NULL,
    "requiredEvidenceJson" JSONB NOT NULL,
    "requiredReviewersJson" JSONB NOT NULL,
    "decisionJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChangeControlRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "repositoryId" TEXT,
    "pullRequestId" TEXT,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "repositoryId" TEXT,
    "eventType" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetentionSetting" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sourceCodeStorage" BOOLEAN NOT NULL DEFAULT false,
    "fullDiffRetention" TEXT NOT NULL DEFAULT 'disabled',
    "redactSecrets" BOOLEAN NOT NULL DEFAULT true,
    "llmFeatures" BOOLEAN NOT NULL DEFAULT false,
    "auditRecordRetentionDays" INTEGER NOT NULL DEFAULT 365,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RetentionSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE INDEX "Organization_slug_idx" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubInstallation_githubInstallationId_key" ON "GitHubInstallation"("githubInstallationId");

-- CreateIndex
CREATE INDEX "GitHubInstallation_organizationId_idx" ON "GitHubInstallation"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_githubRepositoryId_key" ON "Repository"("githubRepositoryId");

-- CreateIndex
CREATE INDEX "Repository_organizationId_enabled_idx" ON "Repository"("organizationId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_organizationId_fullName_key" ON "Repository"("organizationId", "fullName");

-- CreateIndex
CREATE INDEX "PullRequest_repositoryId_headSha_idx" ON "PullRequest"("repositoryId", "headSha");

-- CreateIndex
CREATE UNIQUE INDEX "PullRequest_repositoryId_number_key" ON "PullRequest"("repositoryId", "number");

-- CreateIndex
CREATE INDEX "PolicyVersion_organizationId_repositoryId_createdAt_idx" ON "PolicyVersion"("organizationId", "repositoryId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyVersion_organizationId_repositoryId_version_key" ON "PolicyVersion"("organizationId", "repositoryId", "version");

-- CreateIndex
CREATE INDEX "Evaluation_pullRequestId_headSha_idx" ON "Evaluation"("pullRequestId", "headSha");

-- CreateIndex
CREATE INDEX "VerifiedFactRecord_evaluationId_type_idx" ON "VerifiedFactRecord"("evaluationId", "type");

-- CreateIndex
CREATE INDEX "EvidenceRequirementRecord_evaluationId_status_idx" ON "EvidenceRequirementRecord"("evaluationId", "status");

-- CreateIndex
CREATE INDEX "ReviewerRequirementRecord_evaluationId_tier_approved_idx" ON "ReviewerRequirementRecord"("evaluationId", "tier", "approved");

-- CreateIndex
CREATE INDEX "OverrideRecord_pullRequestId_createdAt_idx" ON "OverrideRecord"("pullRequestId", "createdAt");

-- CreateIndex
CREATE INDEX "CheckRun_evaluationId_idx" ON "CheckRun"("evaluationId");

-- CreateIndex
CREATE UNIQUE INDEX "ChangeControlRecord_pullRequestId_key" ON "ChangeControlRecord"("pullRequestId");

-- CreateIndex
CREATE INDEX "ChangeControlRecord_repositoryFullName_pullRequestNumber_idx" ON "ChangeControlRecord"("repositoryFullName", "pullRequestNumber");

-- CreateIndex
CREATE INDEX "ChangeControlRecord_checkStatus_lifecycle_idx" ON "ChangeControlRecord"("checkStatus", "lifecycle");

-- CreateIndex
CREATE INDEX "AuditEvent_organizationId_action_createdAt_idx" ON "AuditEvent"("organizationId", "action", "createdAt");

-- CreateIndex
CREATE INDEX "UsageEvent_organizationId_eventType_createdAt_idx" ON "UsageEvent"("organizationId", "eventType", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RetentionSetting_organizationId_key" ON "RetentionSetting"("organizationId");

-- AddForeignKey
ALTER TABLE "GitHubInstallation" ADD CONSTRAINT "GitHubInstallation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Repository" ADD CONSTRAINT "Repository_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Repository" ADD CONSTRAINT "Repository_currentPolicyVersionId_fkey" FOREIGN KEY ("currentPolicyVersionId") REFERENCES "PolicyVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullRequest" ADD CONSTRAINT "PullRequest_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyVersion" ADD CONSTRAINT "PolicyVersion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyVersion" ADD CONSTRAINT "PolicyVersion_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyVersion" ADD CONSTRAINT "PolicyVersion_policyPackId_fkey" FOREIGN KEY ("policyPackId") REFERENCES "PolicyPack"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evaluation" ADD CONSTRAINT "Evaluation_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evaluation" ADD CONSTRAINT "Evaluation_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "PolicyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerifiedFactRecord" ADD CONSTRAINT "VerifiedFactRecord_evaluationId_fkey" FOREIGN KEY ("evaluationId") REFERENCES "Evaluation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceRequirementRecord" ADD CONSTRAINT "EvidenceRequirementRecord_evaluationId_fkey" FOREIGN KEY ("evaluationId") REFERENCES "Evaluation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewerRequirementRecord" ADD CONSTRAINT "ReviewerRequirementRecord_evaluationId_fkey" FOREIGN KEY ("evaluationId") REFERENCES "Evaluation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OverrideRecord" ADD CONSTRAINT "OverrideRecord_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OverrideRecord" ADD CONSTRAINT "OverrideRecord_evaluationId_fkey" FOREIGN KEY ("evaluationId") REFERENCES "Evaluation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckRun" ADD CONSTRAINT "CheckRun_evaluationId_fkey" FOREIGN KEY ("evaluationId") REFERENCES "Evaluation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeControlRecord" ADD CONSTRAINT "ChangeControlRecord_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetentionSetting" ADD CONSTRAINT "RetentionSetting_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
