import { AsyncLocalStorage } from "node:async_hooks";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "./generated/prisma/client.js";

export { Prisma, PrismaClient };

/**
 * Per-request/per-job tenant context. When set, the Prisma client below binds a
 * transaction-local `agentforge.current_org` GUC on every operation so Postgres
 * Row-Level Security policies scope reads/writes to that organization. When unset
 * (ingestion, seed, migrations, system tasks) the RLS policies are permissive, so
 * behavior is unchanged — this is a defense-in-depth backstop, not the primary
 * authorization control (AF-SEC M4).
 */
const orgContextStore = new AsyncLocalStorage<string>();

/** Run `callback` with the tenant org bound for all Prisma operations it performs. */
export function runWithOrgContext<T>(
  organizationId: string,
  callback: () => Promise<T> | T
): Promise<T> {
  // Await inside the ALS context: a callback that merely RETURNS a lazy
  // PrismaPromise (e.g. `() => prisma.x.findMany()`) would otherwise be adopted
  // by a later microtask after run() exits, losing the org context. An explicit
  // `await` calls the promise's .then() synchronously while the context is active.
  return orgContextStore.run(organizationId, async () => {
    return await callback();
  });
}

/**
 * Bind the tenant org for the remainder of the current async context (e.g. from a
 * request hook). Prefer `runWithOrgContext` where a callback boundary exists.
 */
export function enterOrgContext(organizationId: string): void {
  orgContextStore.enterWith(organizationId);
}

export function getOrgContext(): string | undefined {
  return orgContextStore.getStore();
}

/**
 * Creates a Prisma 7 client backed by the node-postgres driver adapter, extended
 * to apply the tenant org GUC for RLS when an org context is active.
 *
 * The org binding and the operation run in a single sequential transaction so the
 * `set_config(..., true)` (transaction-local) and the query share one pooled
 * connection.
 */
export function createPrismaClient(connectionString: string): PrismaClient {
  const base = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const extended = base.$extends({
    query: {
      async $allOperations({ args, query }) {
        const organizationId = orgContextStore.getStore();
        if (!organizationId) {
          return query(args);
        }
        const [, result] = await base.$transaction([
          base.$executeRaw`SELECT set_config('agentforge.current_org', ${organizationId}, true)`,
          query(args)
        ]);
        return result;
      }
    }
  });
  return extended as unknown as PrismaClient;
}
