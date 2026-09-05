-- Re-apply tenant RLS with fail-closed defaults for databases that already
-- applied 20260616080000_tenant_rls before the policy backstop was expanded.
-- Keep the explicit system marker narrowly scoped to trusted webhook/system
-- reconciliation; request paths must bind agentforge.current_org.

CREATE OR REPLACE FUNCTION agentforge_current_org() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT current_setting('agentforge.current_org', true) $$;

CREATE OR REPLACE FUNCTION agentforge_system_task() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT current_setting('agentforge.system_task', true) = 'true' $$;

DROP POLICY IF EXISTS org_isolation ON "Organization";
ALTER TABLE "Organization" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Organization" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "Organization" FOR ALL
  USING (agentforge_system_task() OR "id" = agentforge_current_org())
  WITH CHECK (agentforge_system_task() OR "id" = agentforge_current_org());

DROP POLICY IF EXISTS org_isolation ON "GitHubInstallation";
ALTER TABLE "GitHubInstallation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GitHubInstallation" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "GitHubInstallation" FOR ALL
  USING (agentforge_system_task() OR "organizationId" IS NULL OR "organizationId" = agentforge_current_org())
  WITH CHECK (agentforge_system_task() OR "organizationId" IS NULL OR "organizationId" = agentforge_current_org());

DROP POLICY IF EXISTS org_isolation ON "Repository";
ALTER TABLE "Repository" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Repository" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "Repository" FOR ALL
  USING (agentforge_system_task() OR "organizationId" IS NULL OR "organizationId" = agentforge_current_org())
  WITH CHECK (agentforge_system_task() OR "organizationId" IS NULL OR "organizationId" = agentforge_current_org());

DROP POLICY IF EXISTS org_isolation ON "PolicyVersion";
ALTER TABLE "PolicyVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PolicyVersion" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "PolicyVersion" FOR ALL
  USING (agentforge_system_task() OR "organizationId" IS NULL OR "organizationId" = agentforge_current_org())
  WITH CHECK (agentforge_system_task() OR "organizationId" IS NULL OR "organizationId" = agentforge_current_org());

DROP POLICY IF EXISTS org_isolation ON "AuditEvent";
ALTER TABLE "AuditEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "AuditEvent" FOR ALL
  USING (agentforge_system_task() OR "organizationId" IS NULL OR "organizationId" = agentforge_current_org())
  WITH CHECK (agentforge_system_task() OR "organizationId" IS NULL OR "organizationId" = agentforge_current_org());

DROP POLICY IF EXISTS org_isolation ON "UsageEvent";
ALTER TABLE "UsageEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UsageEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "UsageEvent" FOR ALL
  USING (agentforge_system_task() OR "organizationId" IS NULL OR "organizationId" = agentforge_current_org())
  WITH CHECK (agentforge_system_task() OR "organizationId" IS NULL OR "organizationId" = agentforge_current_org());

DROP POLICY IF EXISTS org_isolation ON "OwnerMapping";
ALTER TABLE "OwnerMapping" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OwnerMapping" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "OwnerMapping" FOR ALL
  USING (agentforge_system_task() OR "organizationId" IS NULL OR "organizationId" = agentforge_current_org())
  WITH CHECK (agentforge_system_task() OR "organizationId" IS NULL OR "organizationId" = agentforge_current_org());

DROP POLICY IF EXISTS org_isolation ON "PullRequest";
ALTER TABLE "PullRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PullRequest" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "PullRequest" FOR ALL
  USING (agentforge_system_task() OR EXISTS (SELECT 1 FROM "Repository" r WHERE r.id = "PullRequest"."repositoryId" AND r."organizationId" = agentforge_current_org()))
  WITH CHECK (agentforge_system_task() OR EXISTS (SELECT 1 FROM "Repository" r WHERE r.id = "PullRequest"."repositoryId" AND r."organizationId" = agentforge_current_org()));

DROP POLICY IF EXISTS org_isolation ON "Evaluation";
ALTER TABLE "Evaluation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Evaluation" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "Evaluation" FOR ALL
  USING (agentforge_system_task() OR EXISTS (SELECT 1 FROM "PullRequest" p JOIN "Repository" r ON r.id = p."repositoryId" WHERE p.id = "Evaluation"."pullRequestId" AND r."organizationId" = agentforge_current_org()))
  WITH CHECK (agentforge_system_task() OR EXISTS (SELECT 1 FROM "PullRequest" p JOIN "Repository" r ON r.id = p."repositoryId" WHERE p.id = "Evaluation"."pullRequestId" AND r."organizationId" = agentforge_current_org()));

DROP POLICY IF EXISTS org_isolation ON "VerifiedFactRecord";
ALTER TABLE "VerifiedFactRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "VerifiedFactRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "VerifiedFactRecord" FOR ALL
  USING (agentforge_system_task() OR EXISTS (SELECT 1 FROM "Evaluation" e JOIN "PullRequest" p ON p.id = e."pullRequestId" JOIN "Repository" r ON r.id = p."repositoryId" WHERE e.id = "VerifiedFactRecord"."evaluationId" AND r."organizationId" = agentforge_current_org()))
  WITH CHECK (agentforge_system_task() OR EXISTS (SELECT 1 FROM "Evaluation" e JOIN "PullRequest" p ON p.id = e."pullRequestId" JOIN "Repository" r ON r.id = p."repositoryId" WHERE e.id = "VerifiedFactRecord"."evaluationId" AND r."organizationId" = agentforge_current_org()));

DROP POLICY IF EXISTS org_isolation ON "EvidenceRequirementRecord";
ALTER TABLE "EvidenceRequirementRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EvidenceRequirementRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "EvidenceRequirementRecord" FOR ALL
  USING (agentforge_system_task() OR EXISTS (SELECT 1 FROM "Evaluation" e JOIN "PullRequest" p ON p.id = e."pullRequestId" JOIN "Repository" r ON r.id = p."repositoryId" WHERE e.id = "EvidenceRequirementRecord"."evaluationId" AND r."organizationId" = agentforge_current_org()))
  WITH CHECK (agentforge_system_task() OR EXISTS (SELECT 1 FROM "Evaluation" e JOIN "PullRequest" p ON p.id = e."pullRequestId" JOIN "Repository" r ON r.id = p."repositoryId" WHERE e.id = "EvidenceRequirementRecord"."evaluationId" AND r."organizationId" = agentforge_current_org()));

DROP POLICY IF EXISTS org_isolation ON "ReviewerRequirementRecord";
ALTER TABLE "ReviewerRequirementRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReviewerRequirementRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "ReviewerRequirementRecord" FOR ALL
  USING (agentforge_system_task() OR EXISTS (SELECT 1 FROM "Evaluation" e JOIN "PullRequest" p ON p.id = e."pullRequestId" JOIN "Repository" r ON r.id = p."repositoryId" WHERE e.id = "ReviewerRequirementRecord"."evaluationId" AND r."organizationId" = agentforge_current_org()))
  WITH CHECK (agentforge_system_task() OR EXISTS (SELECT 1 FROM "Evaluation" e JOIN "PullRequest" p ON p.id = e."pullRequestId" JOIN "Repository" r ON r.id = p."repositoryId" WHERE e.id = "ReviewerRequirementRecord"."evaluationId" AND r."organizationId" = agentforge_current_org()));

DROP POLICY IF EXISTS org_isolation ON "OverrideRecord";
ALTER TABLE "OverrideRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OverrideRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "OverrideRecord" FOR ALL
  USING (agentforge_system_task() OR EXISTS (SELECT 1 FROM "PullRequest" p JOIN "Repository" r ON r.id = p."repositoryId" WHERE p.id = "OverrideRecord"."pullRequestId" AND r."organizationId" = agentforge_current_org()))
  WITH CHECK (agentforge_system_task() OR EXISTS (SELECT 1 FROM "PullRequest" p JOIN "Repository" r ON r.id = p."repositoryId" WHERE p.id = "OverrideRecord"."pullRequestId" AND r."organizationId" = agentforge_current_org()));

DROP POLICY IF EXISTS org_isolation ON "CheckRun";
ALTER TABLE "CheckRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CheckRun" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "CheckRun" FOR ALL
  USING (agentforge_system_task() OR EXISTS (SELECT 1 FROM "Evaluation" e JOIN "PullRequest" p ON p.id = e."pullRequestId" JOIN "Repository" r ON r.id = p."repositoryId" WHERE e.id = "CheckRun"."evaluationId" AND r."organizationId" = agentforge_current_org()))
  WITH CHECK (agentforge_system_task() OR EXISTS (SELECT 1 FROM "Evaluation" e JOIN "PullRequest" p ON p.id = e."pullRequestId" JOIN "Repository" r ON r.id = p."repositoryId" WHERE e.id = "CheckRun"."evaluationId" AND r."organizationId" = agentforge_current_org()));

DROP POLICY IF EXISTS org_isolation ON "ChangeControlRecord";
ALTER TABLE "ChangeControlRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChangeControlRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "ChangeControlRecord" FOR ALL
  USING (agentforge_system_task() OR EXISTS (SELECT 1 FROM "PullRequest" p JOIN "Repository" r ON r.id = p."repositoryId" WHERE p.id = "ChangeControlRecord"."pullRequestId" AND r."organizationId" = agentforge_current_org()))
  WITH CHECK (agentforge_system_task() OR EXISTS (SELECT 1 FROM "PullRequest" p JOIN "Repository" r ON r.id = p."repositoryId" WHERE p.id = "ChangeControlRecord"."pullRequestId" AND r."organizationId" = agentforge_current_org()));

DROP POLICY IF EXISTS org_isolation ON "RepositorySetting";
ALTER TABLE "RepositorySetting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RepositorySetting" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "RepositorySetting" FOR ALL
  USING (agentforge_system_task() OR EXISTS (SELECT 1 FROM "Repository" r WHERE r.id = "RepositorySetting"."repositoryId" AND r."organizationId" = agentforge_current_org()))
  WITH CHECK (agentforge_system_task() OR EXISTS (SELECT 1 FROM "Repository" r WHERE r.id = "RepositorySetting"."repositoryId" AND r."organizationId" = agentforge_current_org()));

DROP POLICY IF EXISTS org_isolation ON "WebhookDelivery";
ALTER TABLE "WebhookDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WebhookDelivery" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "WebhookDelivery" FOR ALL
  USING (agentforge_system_task() OR "organizationId" IS NULL OR "organizationId" = agentforge_current_org())
  WITH CHECK (agentforge_system_task() OR "organizationId" IS NULL OR "organizationId" = agentforge_current_org());

DROP POLICY IF EXISTS org_isolation ON "ExportJob";
ALTER TABLE "ExportJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExportJob" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "ExportJob" FOR ALL
  USING (agentforge_system_task() OR "organizationId" IS NULL OR "organizationId" = agentforge_current_org())
  WITH CHECK (agentforge_system_task() OR "organizationId" IS NULL OR "organizationId" = agentforge_current_org());

DROP POLICY IF EXISTS org_isolation ON "RetentionSetting";
ALTER TABLE "RetentionSetting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RetentionSetting" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "RetentionSetting" FOR ALL
  USING (agentforge_system_task() OR "organizationId" = agentforge_current_org())
  WITH CHECK (agentforge_system_task() OR "organizationId" = agentforge_current_org());
