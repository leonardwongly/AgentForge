# Tenant Isolation: Postgres Row-Level Security

Tenant isolation has two layers:

1. **Application layer (primary).** Every tenant-scoped API route resolves an
   authenticated actor and calls `requireOrganizationAccess` before returning or
   mutating tenant data; list/export/dashboard routes filter by the actor's
   `organizationId`.
2. **Database layer (defense-in-depth backstop).** Postgres Row-Level Security
   scopes the tenant tables to the active organization, so a missing/incorrect
   application filter cannot read or write across tenants.

Plus referential integrity from the `tenant_fk_and_audit_restrict` migration:
`WebhookDelivery`/`ExportJob` have real FKs to `Organization`; `AuditEvent` and
`ChangeControlRecord` use `ON DELETE RESTRICT`.

## How RLS is wired (implemented)

- **Migration `20260616080000_tenant_rls`** enables + forces RLS on the direct-org
  tables (`Repository`, `PolicyVersion`, `AuditEvent`, `UsageEvent`, `OwnerMapping`,
  `WebhookDelivery`, `ExportJob`, `RetentionSetting`) with a `org_isolation`
  policy. The policy is **permissive when the `agentforge.current_org` GUC is
  unset** (`agentforge_current_org() IS NULL/'' OR organizationId IS NULL OR
organizationId = agentforge_current_org()`), so seeds, migrations, and webhook
  ingestion (which run without an org bound) behave exactly as before.
- **`@agentforge/db`** exposes `runWithOrgContext(orgId, cb)` and
  `enterOrgContext(orgId)` backed by `AsyncLocalStorage`. `createPrismaClient`
  returns a client extended so that, whenever an org is bound, every operation
  runs in a transaction that first sets `set_config('agentforge.current_org', …,
true)` — binding the GUC to the same connection as the query.
- **API** (`apps/api/src/app.ts`): an `onRequest` hook resolves the actor and
  binds its org for the request (fail-open: unauthenticated routes leave it unset).
- **Worker** (`apps/worker/src/index.ts`): record persistence runs inside
  `runWithOrgContext(repoOrg, …)` after the repository's org is resolved (the
  bootstrap lookup runs unbound/permissively to discover it).

This is verified end-to-end by `apps/api/test/tenant-rls.test.ts` (permissive when
unbound; reads scoped to the bound org; cross-tenant writes rejected by
`WITH CHECK`).

## REQUIRED: run the application as a non-superuser role

> RLS is **silently bypassed** for superusers and roles with `BYPASSRLS`. Postgres
> images created via `POSTGRES_USER` (and many default DB users) are superusers, so
> the backstop does nothing until the app connects as a restricted role.

Provision a dedicated, RLS-subject role and point `DATABASE_URL` at it:

```sql
CREATE ROLE agentforge_app WITH LOGIN PASSWORD '<strong-password>'
  NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO agentforge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO agentforge_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO agentforge_app;
GRANT EXECUTE ON FUNCTION agentforge_current_org() TO agentforge_app;
-- Apply migrations/seed as the owner/superuser; run the app as agentforge_app.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agentforge_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO agentforge_app;
```

Run `prisma migrate deploy` and `prisma db seed` as the owner/superuser; run the
API and worker as `agentforge_app`. Until this role split is in place, isolation
relies solely on the (already-enforced) application layer; once it is, the database
enforces it independently.

## Verifying

```bash
docker compose up -d postgres
pnpm db:deploy
DATABASE_URL=postgresql://agentforge:agentforge@localhost:15432/agentforge \
  pnpm vitest run apps/api/test/tenant-rls.test.ts
```

The test provisions its own restricted role, so it demonstrates real enforcement
even when `DATABASE_URL` points at the superuser.
