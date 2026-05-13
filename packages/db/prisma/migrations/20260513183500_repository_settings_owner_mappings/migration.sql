-- CreateTable
CREATE TABLE "RepositorySetting" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "sourceCodeStorage" BOOLEAN NOT NULL DEFAULT false,
    "fullDiffRetention" TEXT NOT NULL DEFAULT 'disabled',
    "redactSecrets" BOOLEAN NOT NULL DEFAULT true,
    "llmFeatures" BOOLEAN NOT NULL DEFAULT false,
    "auditRecordRetentionDays" INTEGER NOT NULL DEFAULT 365,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepositorySetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnerMapping" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "repositoryId" TEXT,
    "ownerKey" TEXT NOT NULL,
    "reviewer" TEXT NOT NULL,
    "reviewerType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnerMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RepositorySetting_repositoryId_key" ON "RepositorySetting"("repositoryId");

-- CreateIndex
CREATE UNIQUE INDEX "OwnerMapping_organizationId_repositoryId_ownerKey_key" ON "OwnerMapping"("organizationId", "repositoryId", "ownerKey");

-- CreateIndex
CREATE INDEX "OwnerMapping_organizationId_repositoryId_idx" ON "OwnerMapping"("organizationId", "repositoryId");

-- AddForeignKey
ALTER TABLE "RepositorySetting" ADD CONSTRAINT "RepositorySetting_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnerMapping" ADD CONSTRAINT "OwnerMapping_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnerMapping" ADD CONSTRAINT "OwnerMapping_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
