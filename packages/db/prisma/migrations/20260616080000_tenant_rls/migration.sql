-- Tenant isolation backstop via Postgres Row-Level Security (AF-SEC M4).
--
-- Policies are PERMISSIVE WHEN THE GUC IS UNSET: with no `agentforge.current_org`
-- session setting (seed, migrations, webhook ingestion, system tasks) every row is
-- visible/writable exactly as before. When the application binds the GUC (via the
-- Prisma org-context extension on an authenticated request / worker job) the policy
-- restricts rows to that organization. Rows with a NULL organizationId (pre-mapping
-- webhook deliveries, unattributed export jobs) remain accessible so ingestion and
-- status updates are never blocked.
--
-- FORCE is required so the policy also applies to the table owner (the application
-- connection). This is a defense-in-depth backstop; the application still enforces
-- tenant authorization at the route layer.

CREATE OR REPLACE FUNCTION agentforge_current_org() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT current_setting('agentforge.current_org', true) $$;

-- Repository
ALTER TABLE "Repository" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Repository" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "Repository" FOR ALL
  USING (
    agentforge_current_org() IS NULL
    OR agentforge_current_org() = ''
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  )
  WITH CHECK (
    agentforge_current_org() IS NULL
    OR agentforge_current_org() = ''
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  );

-- PolicyVersion
ALTER TABLE "PolicyVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PolicyVersion" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "PolicyVersion" FOR ALL
  USING (
    agentforge_current_org() IS NULL
    OR agentforge_current_org() = ''
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  )
  WITH CHECK (
    agentforge_current_org() IS NULL
    OR agentforge_current_org() = ''
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  );

-- AuditEvent
ALTER TABLE "AuditEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "AuditEvent" FOR ALL
  USING (
    agentforge_current_org() IS NULL
    OR agentforge_current_org() = ''
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  )
  WITH CHECK (
    agentforge_current_org() IS NULL
    OR agentforge_current_org() = ''
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  );

-- UsageEvent
ALTER TABLE "UsageEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UsageEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "UsageEvent" FOR ALL
  USING (
    agentforge_current_org() IS NULL
    OR agentforge_current_org() = ''
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  )
  WITH CHECK (
    agentforge_current_org() IS NULL
    OR agentforge_current_org() = ''
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  );

-- OwnerMapping
ALTER TABLE "OwnerMapping" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OwnerMapping" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "OwnerMapping" FOR ALL
  USING (
    agentforge_current_org() IS NULL
    OR agentforge_current_org() = ''
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  )
  WITH CHECK (
    agentforge_current_org() IS NULL
    OR agentforge_current_org() = ''
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  );

-- WebhookDelivery (organizationId nullable; null rows always accessible)
ALTER TABLE "WebhookDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WebhookDelivery" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "WebhookDelivery" FOR ALL
  USING (
    agentforge_current_org() IS NULL
    OR agentforge_current_org() = ''
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  )
  WITH CHECK (
    agentforge_current_org() IS NULL
    OR agentforge_current_org() = ''
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  );

-- ExportJob (organizationId nullable; null rows always accessible)
ALTER TABLE "ExportJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExportJob" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "ExportJob" FOR ALL
  USING (
    agentforge_current_org() IS NULL
    OR agentforge_current_org() = ''
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  )
  WITH CHECK (
    agentforge_current_org() IS NULL
    OR agentforge_current_org() = ''
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  );

-- RetentionSetting
ALTER TABLE "RetentionSetting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RetentionSetting" FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "RetentionSetting" FOR ALL
  USING (
    agentforge_current_org() IS NULL
    OR agentforge_current_org() = ''
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  )
  WITH CHECK (
    agentforge_current_org() IS NULL
    OR agentforge_current_org() = ''
    OR "organizationId" IS NULL
    OR "organizationId" = agentforge_current_org()
  );
