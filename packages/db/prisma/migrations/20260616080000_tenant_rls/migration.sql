-- Tenant isolation backstop via Postgres Row-Level Security (AF-SEC M4).
--
-- Policies fail closed for organization-owned rows when `agentforge.current_org`
-- is unset. Rows with a NULL organizationId (pre-mapping webhook deliveries,
-- unattributed export jobs) remain accessible so ingestion and status updates are
-- never blocked; callers must bind an organization before accessing tenant rows.
--
-- FORCE is required so the policy also applies to the table owner (the application
-- connection). This is a defense-in-depth backstop; the application still enforces
-- tenant authorization at the route layer.

CREATE OR REPLACE FUNCTION agentforge_current_org() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT current_setting('agentforge.current_org', true) $$;

CREATE OR REPLACE FUNCTION agentforge_system_task() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT current_setting('agentforge.system_task', true) = 'true' $$;

-- Organization and installation identity rows are tenant-scoped directly.
ALTER TABLE "Organization" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Organization" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "Organization" FOR ALL
  USING (agentforge_system_task() OR "id" = agentforge_current_org())
  WITH CHECK (agentforge_system_task() OR "id" = agentforge_current_org());

ALTER TABLE "GitHubInstallation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GitHubInstallation" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "GitHubInstallation" FOR ALL
  USING (agentforge_system_task() OR "organizationId" IS NULL OR "organizationId" = agentforge_current_org())
  WITH CHECK (agentforge_system_task() OR "organizationId" IS NULL OR "organizationId" = agentforge_current_org());

-- Repository
ALTER TABLE "Repository" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Repository" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "Repository" FOR ALL
  USING (
    agentforge_system_task()
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  )
  WITH CHECK (
    agentforge_system_task()
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  );

-- PolicyVersion
ALTER TABLE "PolicyVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PolicyVersion" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "PolicyVersion" FOR ALL
  USING (
    agentforge_system_task()
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  )
  WITH CHECK (
    agentforge_system_task()
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  );

-- AuditEvent
ALTER TABLE "AuditEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "AuditEvent" FOR ALL
  USING (
    agentforge_system_task()
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  )
  WITH CHECK (
    agentforge_system_task()
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  );

-- UsageEvent
ALTER TABLE "UsageEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UsageEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "UsageEvent" FOR ALL
  USING (
    agentforge_system_task()
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  )
  WITH CHECK (
    agentforge_system_task()
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  );

-- OwnerMapping
ALTER TABLE "OwnerMapping" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OwnerMapping" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "OwnerMapping" FOR ALL
  USING (
    agentforge_system_task()
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  )
  WITH CHECK (
    agentforge_system_task()
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  );

-- Tables that inherit tenancy through Repository/PullRequest/Evaluation also
-- need direct policies: callers can query these models without traversing the
-- route-level repository checks. The subqueries are evaluated under the same
-- current_org context and deny all tenant rows when it is unset.
ALTER TABLE "PullRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PullRequest" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "PullRequest" FOR ALL
  USING (agentforge_system_task() OR EXISTS (SELECT 1 FROM "Repository" r WHERE r.id = "PullRequest"."repositoryId" AND r."organizationId" = agentforge_current_org()))
  WITH CHECK (agentforge_system_task() OR EXISTS (SELECT 1 FROM "Repository" r WHERE r.id = "PullRequest"."repositoryId" AND r."organizationId" = agentforge_current_org()));

ALTER TABLE "Evaluation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Evaluation" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "Evaluation" FOR ALL
  USING (agentforge_system_task() OR EXISTS (SELECT 1 FROM "PullRequest" p JOIN "Repository" r ON r.id = p."repositoryId" WHERE p.id = "Evaluation"."pullRequestId" AND r."organizationId" = agentforge_current_org()))
  WITH CHECK (agentforge_system_task() OR EXISTS (SELECT 1 FROM "PullRequest" p JOIN "Repository" r ON r.id = p."repositoryId" WHERE p.id = "Evaluation"."pullRequestId" AND r."organizationId" = agentforge_current_org()));

ALTER TABLE "VerifiedFactRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VerifiedFactRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "VerifiedFactRecord" FOR ALL
  USING (agentforge_system_task() OR EXISTS (SELECT 1 FROM "Evaluation" e JOIN "PullRequest" p ON p.id = e."pullRequestId" JOIN "Repository" r ON r.id = p."repositoryId" WHERE e.id = "VerifiedFactRecord"."evaluationId" AND r."organizationId" = agentforge_current_org()))
  WITH CHECK (agentforge_system_task() OR EXISTS (SELECT 1 FROM "Evaluation" e JOIN "PullRequest" p ON p.id = e."pullRequestId" JOIN "Repository" r ON r.id = p."repositoryId" WHERE e.id = "VerifiedFactRecord"."evaluationId" AND r."organizationId" = agentforge_current_org()));

ALTER TABLE "EvidenceRequirementRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EvidenceRequirementRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "EvidenceRequirementRecord" FOR ALL
  USING (agentforge_system_task() OR EXISTS (SELECT 1 FROM "Evaluation" e JOIN "PullRequest" p ON p.id = e."pullRequestId" JOIN "Repository" r ON r.id = p."repositoryId" WHERE e.id = "EvidenceRequirementRecord"."evaluationId" AND r."organizationId" = agentforge_current_org()))
  WITH CHECK (agentforge_system_task() OR EXISTS (SELECT 1 FROM "Evaluation" e JOIN "PullRequest" p ON p.id = e."pullRequestId" JOIN "Repository" r ON r.id = p."repositoryId" WHERE e.id = "EvidenceRequirementRecord"."evaluationId" AND r."organizationId" = agentforge_current_org()));

ALTER TABLE "ReviewerRequirementRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReviewerRequirementRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "ReviewerRequirementRecord" FOR ALL
  USING (agentforge_system_task() OR EXISTS (SELECT 1 FROM "Evaluation" e JOIN "PullRequest" p ON p.id = e."pullRequestId" JOIN "Repository" r ON r.id = p."repositoryId" WHERE e.id = "ReviewerRequirementRecord"."evaluationId" AND r."organizationId" = agentforge_current_org()))
  WITH CHECK (agentforge_system_task() OR EXISTS (SELECT 1 FROM "Evaluation" e JOIN "PullRequest" p ON p.id = e."pullRequestId" JOIN "Repository" r ON r.id = p."repositoryId" WHERE e.id = "ReviewerRequirementRecord"."evaluationId" AND r."organizationId" = agentforge_current_org()));

ALTER TABLE "OverrideRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OverrideRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "OverrideRecord" FOR ALL
  USING (agentforge_system_task() OR EXISTS (SELECT 1 FROM "PullRequest" p JOIN "Repository" r ON r.id = p."repositoryId" WHERE p.id = "OverrideRecord"."pullRequestId" AND r."organizationId" = agentforge_current_org()))
  WITH CHECK (agentforge_system_task() OR EXISTS (SELECT 1 FROM "PullRequest" p JOIN "Repository" r ON r.id = p."repositoryId" WHERE p.id = "OverrideRecord"."pullRequestId" AND r."organizationId" = agentforge_current_org()));

ALTER TABLE "CheckRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CheckRun" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "CheckRun" FOR ALL
  USING (agentforge_system_task() OR EXISTS (SELECT 1 FROM "Evaluation" e JOIN "PullRequest" p ON p.id = e."pullRequestId" JOIN "Repository" r ON r.id = p."repositoryId" WHERE e.id = "CheckRun"."evaluationId" AND r."organizationId" = agentforge_current_org()))
  WITH CHECK (agentforge_system_task() OR EXISTS (SELECT 1 FROM "Evaluation" e JOIN "PullRequest" p ON p.id = e."pullRequestId" JOIN "Repository" r ON r.id = p."repositoryId" WHERE e.id = "CheckRun"."evaluationId" AND r."organizationId" = agentforge_current_org()));

ALTER TABLE "ChangeControlRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChangeControlRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "ChangeControlRecord" FOR ALL
  USING (agentforge_system_task() OR EXISTS (SELECT 1 FROM "PullRequest" p JOIN "Repository" r ON r.id = p."repositoryId" WHERE p.id = "ChangeControlRecord"."pullRequestId" AND r."organizationId" = agentforge_current_org()))
  WITH CHECK (agentforge_system_task() OR EXISTS (SELECT 1 FROM "PullRequest" p JOIN "Repository" r ON r.id = p."repositoryId" WHERE p.id = "ChangeControlRecord"."pullRequestId" AND r."organizationId" = agentforge_current_org()));

ALTER TABLE "RepositorySetting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RepositorySetting" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "RepositorySetting" FOR ALL
  USING (agentforge_system_task() OR EXISTS (SELECT 1 FROM "Repository" r WHERE r.id = "RepositorySetting"."repositoryId" AND r."organizationId" = agentforge_current_org()))
  WITH CHECK (agentforge_system_task() OR EXISTS (SELECT 1 FROM "Repository" r WHERE r.id = "RepositorySetting"."repositoryId" AND r."organizationId" = agentforge_current_org()));

-- WebhookDelivery (organizationId nullable; null rows always accessible)
ALTER TABLE "WebhookDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WebhookDelivery" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "WebhookDelivery" FOR ALL
  USING (
    agentforge_system_task()
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  )
  WITH CHECK (
    agentforge_system_task()
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  );

-- ExportJob (organizationId nullable; null rows always accessible)
ALTER TABLE "ExportJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExportJob" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "ExportJob" FOR ALL
  USING (
    agentforge_system_task()
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  )
  WITH CHECK (
    agentforge_system_task()
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  );

-- RetentionSetting
ALTER TABLE "RetentionSetting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RetentionSetting" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "RetentionSetting" FOR ALL
  USING (
    agentforge_system_task()
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  )
  WITH CHECK (
    agentforge_system_task()
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  );
