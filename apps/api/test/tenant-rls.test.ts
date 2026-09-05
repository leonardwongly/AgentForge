import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPrismaClient,
  runWithOrgContext,
  withUnmanagedOrgBinding,
  type PrismaClient
} from "@agentforge/db";

/**
 * Verifies the Postgres Row-Level Security tenant backstop (AF-SEC M4) end to end:
 * fail-closed when no org context is bound and strictly org-scoped (reads +
 * writes) when bound. RLS only applies to a NON-superuser / NON-BYPASSRLS role,
 * so this test provisions a restricted role and connects as it.
 *
 * Skips automatically when Postgres is not reachable (e.g. the default `pnpm test`
 * from a clean shell). Runs in CI's integration job and locally with Compose up.
 */
const superuserUrl =
  process.env.DATABASE_URL ?? "postgresql://agentforge:agentforge@localhost:15432/agentforge";
const RESTRICTED_ROLE = "agentforge_rls_test";
const RESTRICTED_PASSWORD = "rls_test_pw";

function restrictedUrl(): string {
  const url = new URL(superuserUrl);
  url.username = RESTRICTED_ROLE;
  url.password = RESTRICTED_PASSWORD;
  return url.toString();
}

let available = false;
let superuser: PrismaClient | undefined;
let app: PrismaClient | undefined;
const created = { orgA: "", orgB: "", repoA: "", repoB: "" };
const n = Date.now();

// Distinguishes "Postgres genuinely is not reachable" (acceptable to skip --
// this is the documented behavior for `pnpm test` from a clean shell with no
// Compose stack running) from any OTHER failure during setup (a real bug, a
// misconfigured CI Postgres service, or transient connection-pool contention
// under full-suite parallel execution). Silently swallowing every error into
// the same `available = false` skip path was a real, documented risk (a CI
// run that skips this file due to unrelated contention shows green, not red,
// hiding an actual regression). Only a genuine "nothing is listening" class
// of error is treated as skip-worthy; anything else re-throws so the test
// file fails loudly instead of silently vanishing from the report.
function isUnreachableConnectionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EPERM" ||
    code === "EACCES" ||
    code === "P1001" ||
    code === "P1017"
  );
}

// Bounded retry for the initial connectivity probe only. Running the full
// Vitest suite in parallel opens many concurrent Postgres connections across
// unrelated test files; a transient "too many clients" or connection-timing
// hiccup during that startup burst is not the same thing as "Postgres is not
// running" and should not cause this file's tests to silently vanish as
// skipped. Retries only the initial probe, not the DDL/setup that follows it.
async function withConnectionRetry<T>(operation: () => Promise<T>): Promise<T> {
  const maxAttempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !isTransientConnectionError(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  throw lastError;
}

function isTransientConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    isUnreachableConnectionError(error) ||
    /too many clients|connection terminated|timeout|tuple concurrently updated/iu.test(message)
  );
}

// Wraps the ENTIRE role-provisioning sequence (DROP OWNED BY / DROP ROLE /
// CREATE ROLE / GRANT ...), not just the initial connectivity probe. Postgres
// legitimately raises "tuple concurrently updated" (XX000) when two sessions
// concurrently modify the same system catalog rows (e.g. two test files each
// running GRANT ... ON ALL TABLES IN SCHEMA public at the same time) -- this is
// expected, standard behavior under concurrent DDL, not a bug in the grants
// themselves, and the correct response is to retry the whole provisioning
// sequence, not to treat it as either a real failure or a silent skip.
async function provisionRestrictedRole(client: PrismaClient): Promise<void> {
  // Provision a restricted (RLS-subject) role. DROP OWNED BY first so a
  // leftover role (which still holds table privileges) can be dropped.
  await client.$executeRawUnsafe(
    `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${RESTRICTED_ROLE}') THEN EXECUTE 'DROP OWNED BY ${RESTRICTED_ROLE}'; EXECUTE 'DROP ROLE ${RESTRICTED_ROLE}'; END IF; END $$;`
  );
  await client.$executeRawUnsafe(
    `CREATE ROLE ${RESTRICTED_ROLE} WITH LOGIN PASSWORD '${RESTRICTED_PASSWORD}' NOSUPERUSER NOBYPASSRLS`
  );
  await client.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${RESTRICTED_ROLE}`);
  await client.$executeRawUnsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RESTRICTED_ROLE}`
  );
  await client.$executeRawUnsafe(
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RESTRICTED_ROLE}`
  );
  await client.$executeRawUnsafe(
    `GRANT EXECUTE ON FUNCTION agentforge_current_org() TO ${RESTRICTED_ROLE}`
  );
}

// Deliberately NOT retried as a unit with provisionRestrictedRole: unlike the
// role DDL above (idempotent by its own DROP-then-CREATE guard, and the
// actual target of the "tuple concurrently updated" contention this retry
// exists for), these org/repo inserts use a fixed slug/fullName derived from
// `n` (captured once at module load). A retry of THIS function after a
// transient failure that occurred just after a prior attempt's inserts had
// already committed would hit a duplicate-key violation on that same
// slug/fullName -- a different, confusing error masking the original
// transient one. Ordinary DML inserts are also far less likely to hit the
// shared-system-catalog-row contention class the DDL retry defends against.
async function createRlsFixtures(client: PrismaClient): Promise<void> {
  const orgA = await client.organization.create({
    data: { name: "RLS A", slug: `rls-a-${n}` }
  });
  const orgB = await client.organization.create({
    data: { name: "RLS B", slug: `rls-b-${n}` }
  });
  const repoA = await client.repository.create({
    data: {
      organizationId: orgA.id,
      githubRepositoryId: BigInt(n),
      fullName: `a/${n}`,
      owner: "a",
      name: String(n),
      defaultBranch: "main"
    }
  });
  const repoB = await client.repository.create({
    data: {
      organizationId: orgB.id,
      githubRepositoryId: BigInt(n + 1),
      fullName: `b/${n}`,
      owner: "b",
      name: String(n),
      defaultBranch: "main"
    }
  });
  created.orgA = orgA.id;
  created.orgB = orgB.id;
  created.repoA = repoA.id;
  created.repoB = repoB.id;
}

describe("tenant isolation via Postgres RLS", () => {
  beforeAll(async () => {
    try {
      superuser = createPrismaClient(superuserUrl);
      await withConnectionRetry(() => superuser!.$queryRaw`SELECT 1`);
      await withConnectionRetry(() => provisionRestrictedRole(superuser!));
      await createRlsFixtures(superuser!);
      app = createPrismaClient(restrictedUrl());
      await withConnectionRetry(() => app!.$queryRaw`SELECT 1`);
      available = true;
    } catch (error) {
      if (isUnreachableConnectionError(error)) {
        available = false;
        return;
      }
      // A real error occurred (bad grants, a broken CREATE ROLE, a DDL
      // conflict, etc.) while Postgres itself was reachable. Surface it
      // rather than silently skipping every test in this file.
      throw error;
    }
  });

  afterAll(async () => {
    try {
      if (superuser) {
        await superuser.repository.deleteMany({
          where: { id: { in: [created.repoA, created.repoB].filter(Boolean) } }
        });
        await superuser.organization.deleteMany({
          where: { id: { in: [created.orgA, created.orgB].filter(Boolean) } }
        });
      }
      await app?.$disconnect();
      if (superuser) {
        await superuser
          .$executeRawUnsafe(
            `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${RESTRICTED_ROLE}') THEN EXECUTE 'DROP OWNED BY ${RESTRICTED_ROLE}'; EXECUTE 'DROP ROLE ${RESTRICTED_ROLE}'; END IF; END $$;`
          )
          .catch(() => undefined);
        await superuser.$disconnect();
      }
    } catch {
      // best-effort cleanup
    }
  });

  it("denies organization-owned rows when no org context is bound", async (ctx) => {
    if (!available || !app) {
      ctx.skip();
      return;
    }
    const rows = await app.repository.findMany({
      where: { id: { in: [created.repoA, created.repoB] } }
    });
    expect(rows).toHaveLength(0);
  });

  it("scopes reads to the bound organization", async (ctx) => {
    if (!available || !app) {
      ctx.skip();
      return;
    }
    const client = app;
    const ctxA = await runWithOrgContext(created.orgA, () =>
      client.repository.findMany({ where: { id: { in: [created.repoA, created.repoB] } } })
    );
    expect(ctxA.map((r) => r.organizationId)).toEqual([created.orgA]);

    const ctxB = await runWithOrgContext(created.orgB, () =>
      client.repository.findMany({ where: { id: { in: [created.repoA, created.repoB] } } })
    );
    expect(ctxB.map((r) => r.organizationId)).toEqual([created.orgB]);
  });

  it("blocks cross-tenant writes via WITH CHECK", async (ctx) => {
    if (!available || !app) {
      ctx.skip();
      return;
    }
    const client = app;
    await expect(
      runWithOrgContext(created.orgA, () =>
        client.repository.update({
          where: { id: created.repoB },
          data: { defaultBranch: "tampered" }
        })
      )
    ).rejects.toThrow();
  });

  it("still scopes reads correctly when the org GUC is bound manually via withUnmanagedOrgBinding inside an interactive transaction", async (ctx) => {
    if (!available || !app) {
      ctx.skip();
      return;
    }
    // Regression test for a real defect (flagged by an automated PR review and
    // confirmed against github.com/prisma/prisma/issues/23583): the RLS
    // extension's automatic wrap-in-transaction binding is only correct for a
    // STANDALONE `prisma.model.op()` call. When invoked from inside the
    // extended client's OWN `$transaction(async (tx) => {...})`, every
    // `tx.model.op()` call re-enters the extension and would otherwise try to
    // open a second, disconnected transaction. The three real call sites that
    // need RLS scoping inside an interactive transaction
    // (apps/worker/src/index.ts's runAuditRecordRetentionSweep and
    // persistWorkerEvaluationSnapshot, apps/api/src/app.ts's saveActivePolicy)
    // now bind the GUC themselves as the transaction's first statement via
    // `withUnmanagedOrgBinding` + `tx.$executeRaw`. This test proves that
    // pattern actually scopes correctly on a real Postgres connection, not just
    // that it type-checks or satisfies a mock.
    const client = app;
    const rowsForOrgA = await withUnmanagedOrgBinding(() =>
      client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('agentforge.current_org', ${created.orgA}, true)`;
        return tx.repository.findMany({
          where: { id: { in: [created.repoA, created.repoB] } }
        });
      })
    );
    expect(rowsForOrgA.map((r) => r.organizationId)).toEqual([created.orgA]);

    const rowsForOrgB = await withUnmanagedOrgBinding(() =>
      client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('agentforge.current_org', ${created.orgB}, true)`;
        return tx.repository.findMany({
          where: { id: { in: [created.repoA, created.repoB] } }
        });
      })
    );
    expect(rowsForOrgB.map((r) => r.organizationId)).toEqual([created.orgB]);
  });

  it("blocks cross-tenant writes via WITH CHECK inside an interactive transaction bound with withUnmanagedOrgBinding", async (ctx) => {
    if (!available || !app) {
      ctx.skip();
      return;
    }
    const client = app;
    await expect(
      withUnmanagedOrgBinding(() =>
        client.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('agentforge.current_org', ${created.orgA}, true)`;
          return tx.repository.update({
            where: { id: created.repoB },
            data: { defaultBranch: "tampered-in-tx" }
          });
        })
      )
    ).rejects.toThrow();
  });
});
