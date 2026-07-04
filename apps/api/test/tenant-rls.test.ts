import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, runWithOrgContext, type PrismaClient } from "@agentforge/db";

/**
 * Verifies the Postgres Row-Level Security tenant backstop (AF-SEC M4) end to end:
 * permissive when no org context is bound, strictly org-scoped (reads + writes)
 * when bound. RLS only applies to a NON-superuser / NON-BYPASSRLS role, so this
 * test provisions a restricted role and connects as it.
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

describe("tenant isolation via Postgres RLS", () => {
  beforeAll(async () => {
    try {
      superuser = createPrismaClient(superuserUrl);
      await superuser.$queryRaw`SELECT 1`;
      // Provision a restricted (RLS-subject) role. DROP OWNED BY first so a
      // leftover role (which still holds table privileges) can be dropped.
      await superuser.$executeRawUnsafe(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${RESTRICTED_ROLE}') THEN EXECUTE 'DROP OWNED BY ${RESTRICTED_ROLE}'; EXECUTE 'DROP ROLE ${RESTRICTED_ROLE}'; END IF; END $$;`
      );
      await superuser.$executeRawUnsafe(
        `CREATE ROLE ${RESTRICTED_ROLE} WITH LOGIN PASSWORD '${RESTRICTED_PASSWORD}' NOSUPERUSER NOBYPASSRLS`
      );
      await superuser.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${RESTRICTED_ROLE}`);
      await superuser.$executeRawUnsafe(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RESTRICTED_ROLE}`
      );
      await superuser.$executeRawUnsafe(
        `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RESTRICTED_ROLE}`
      );
      await superuser.$executeRawUnsafe(
        `GRANT EXECUTE ON FUNCTION agentforge_current_org() TO ${RESTRICTED_ROLE}`
      );

      const orgA = await superuser.organization.create({
        data: { name: "RLS A", slug: `rls-a-${n}` }
      });
      const orgB = await superuser.organization.create({
        data: { name: "RLS B", slug: `rls-b-${n}` }
      });
      const repoA = await superuser.repository.create({
        data: {
          organizationId: orgA.id,
          githubRepositoryId: BigInt(n),
          fullName: `a/${n}`,
          owner: "a",
          name: String(n),
          defaultBranch: "main"
        }
      });
      const repoB = await superuser.repository.create({
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

      app = createPrismaClient(restrictedUrl());
      await app.$queryRaw`SELECT 1`;
      available = true;
    } catch {
      available = false;
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

  it("is permissive when no org context is bound", async (ctx) => {
    if (!available || !app) {
      ctx.skip();
      return;
    }
    const rows = await app.repository.findMany({
      where: { id: { in: [created.repoA, created.repoB] } }
    });
    expect(rows.length).toBe(2);
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
});
