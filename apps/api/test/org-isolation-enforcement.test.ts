import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertOrgIsolationEnforced, createPrismaClient, type PrismaClient } from "@agentforge/db";

/**
 * Verifies the runtime backstop for AF-SEC M4's RLS tenant-isolation guarantee:
 * `assertOrgIsolationEnforced` must detect a connected Postgres role that bypasses
 * RLS (superuser or BYPASSRLS) and fail closed in production, while only warning
 * outside production. RLS bypass is role-level Postgres behavior, so this needs a
 * real connection and a real superuser vs. restricted role to mean anything --
 * mirrors the live-DB-optional pattern in `apps/api/test/tenant-rls.test.ts`
 * (an `available` flag set in `beforeAll` after probing a real connection,
 * `ctx.skip()` in each test when unavailable).
 *
 * Skips automatically when Postgres is not reachable (e.g. the default `pnpm test`
 * from a clean shell). Runs in CI's integration job and locally with Compose up.
 */
const superuserUrl =
  process.env.DATABASE_URL ?? "postgresql://agentforge:agentforge@localhost:15432/agentforge";
const RESTRICTED_ROLE = "agentforge_orgcheck_test";
const RESTRICTED_PASSWORD = "orgcheck_test_pw";

function restrictedUrl(): string {
  const url = new URL(superuserUrl);
  url.username = RESTRICTED_ROLE;
  url.password = RESTRICTED_PASSWORD;
  return url.toString();
}

let available = false;
let superuser: PrismaClient | undefined;
let restricted: PrismaClient | undefined;

// See apps/api/test/tenant-rls.test.ts for the rationale: only a genuine
// "nothing is listening" class of error is skip-worthy. Any other failure
// during setup re-throws so this file fails loudly instead of silently
// reporting as skipped.
function isUnreachableConnectionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "P1001" || code === "P1017";
}

function isTransientConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    isUnreachableConnectionError(error) ||
    /too many clients|connection terminated|timeout|tuple concurrently updated/iu.test(message)
  );
}

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

async function provisionRestrictedRole(client: PrismaClient): Promise<void> {
  await client.$executeRawUnsafe(
    `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${RESTRICTED_ROLE}') THEN EXECUTE 'DROP OWNED BY ${RESTRICTED_ROLE}'; EXECUTE 'DROP ROLE ${RESTRICTED_ROLE}'; END IF; END $$;`
  );
  await client.$executeRawUnsafe(
    `CREATE ROLE ${RESTRICTED_ROLE} WITH LOGIN PASSWORD '${RESTRICTED_PASSWORD}' NOSUPERUSER NOBYPASSRLS`
  );
  await client.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${RESTRICTED_ROLE}`);
  await client.$executeRawUnsafe(
    `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${RESTRICTED_ROLE}`
  );
}

describe("assertOrgIsolationEnforced", () => {
  beforeAll(async () => {
    try {
      superuser = createPrismaClient(superuserUrl);
      await withConnectionRetry(() => superuser!.$queryRaw`SELECT 1`);
      // Provision a restricted (non-superuser, NOBYPASSRLS) role. The whole
      // sequence is retried as one unit: Postgres legitimately raises "tuple
      // concurrently updated" (XX000) when this file's GRANT/CREATE ROLE DDL
      // races against another test file's concurrent DDL on the same shared
      // system catalog rows (e.g. apps/api/test/tenant-rls.test.ts running at
      // the same time) -- expected under concurrency, not a real bug, and the
      // correct response is to retry, not to fail or silently skip.
      await withConnectionRetry(() => provisionRestrictedRole(superuser!));

      restricted = createPrismaClient(restrictedUrl());
      await withConnectionRetry(() => restricted!.$queryRaw`SELECT 1`);
      available = true;
    } catch (error) {
      if (isUnreachableConnectionError(error)) {
        available = false;
        return;
      }
      throw error;
    }
  });

  afterAll(async () => {
    try {
      await restricted?.$disconnect();
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

  it("identifies a superuser/BYPASSRLS role as bypassing RLS and throws in production", async (ctx) => {
    if (!available || !superuser) {
      ctx.skip();
      return;
    }
    // The default local/Compose role connects as a superuser (documented,
    // accepted local-dev simplification), so `superuser` here already
    // exercises the "bypasses RLS" branch of the check.
    await expect(assertOrgIsolationEnforced(superuser, "production")).rejects.toThrow(
      "Unsafe AgentForge production configuration"
    );
  });

  it("only warns (does not throw) for a superuser/BYPASSRLS role outside production", async (ctx) => {
    if (!available || !superuser) {
      ctx.skip();
      return;
    }
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      await expect(assertOrgIsolationEnforced(superuser, "development")).resolves.toBeUndefined();
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.length).toBeGreaterThan(0);
    expect(String(warnings[0]?.[0])).toContain("Row-Level Security");
  });

  it("passes for a role with neither rolsuper nor rolbypassrls, in production and non-production", async (ctx) => {
    if (!available || !restricted) {
      ctx.skip();
      return;
    }
    await expect(assertOrgIsolationEnforced(restricted, "production")).resolves.toBeUndefined();
    await expect(assertOrgIsolationEnforced(restricted, "development")).resolves.toBeUndefined();
  });
});
