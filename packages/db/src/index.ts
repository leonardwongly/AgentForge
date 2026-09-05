import { AsyncLocalStorage } from "node:async_hooks";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "./generated/prisma/client.js";

export { Prisma, PrismaClient };

/**
 * Per-request/per-job tenant context. When set, the Prisma client below binds a
 * transaction-local `agentforge.current_org` GUC on every operation so Postgres
 * Row-Level Security policies scope reads/writes to that organization. For
 * organization-owned rows, the migration denies access when this context is
 * unset; only explicitly nullable, pre-attribution rows remain available to
 * ingestion/system workflows (AF-SEC M4).
 */
const orgContextStore = new AsyncLocalStorage<string>();
const systemContextStore = new AsyncLocalStorage<true>();

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

/** Run trusted webhook/system reconciliation with an explicit RLS system marker. */
export function runWithSystemContext<T>(callback: () => Promise<T> | T): Promise<T> {
  return systemContextStore.run(true, async () => await callback());
}

/**
 * Creates a Prisma 7 client backed by the node-postgres driver adapter, extended
 * to apply the tenant org GUC for RLS when an org context is active.
 *
 * The org binding and the operation run in a single sequential transaction so the
 * `set_config(..., true)` (transaction-local) and the query share one pooled
 * connection -- for a STANDALONE call (`prisma.model.op()` outside any outer
 * transaction). This is Prisma's own documented RLS extension pattern
 * (prisma.io/docs/orm/prisma-client/client-extensions/query#wrap-a-query-into-a-batch-transaction).
 *
 * That pattern is UNSAFE to apply automatically when the extended client's own
 * `$transaction(async (tx) => {...})` is used for an interactive transaction:
 * `tx` is itself the extended client, so every `tx.model.op()` call inside the
 * callback re-enters this same `$allOperations` hook. This hook has no way to
 * reach the outer transaction's actual connection from inside the hook -- so
 * wrapping `query(args)` in a SECOND `base.$transaction([...])` here would open
 * an unrelated transaction on a different connection, disconnected from `tx`.
 * This is a real, Prisma-acknowledged ("not planned" to fix at the extension
 * layer) limitation: github.com/prisma/prisma/issues/23583 (interactive
 * transactions with an extended client cause blocking/non-atomic queries in
 * Postgres when the extension wraps each operation in its own transaction).
 *
 * `guardedOrgContextStore` distinguishes the two cases: `runWithOrgContext` /
 * `enterOrgContext` set the PLAIN org id in `orgContextStore` for the common,
 * standalone-call case (this hook applies its own wrap-in-transaction binding,
 * unchanged). Callers that need RLS scoping INSIDE an interactive transaction
 * must bind the GUC themselves, as the transaction's own first statement, on the
 * real `tx` handle (`await tx.$executeRaw\`SELECT set_config('agentforge.current_org', ${orgId}, true)\``)
 * -- see `apps/worker/src/index.ts`'s `runAuditRecordRetentionSweep` and
 * `apps/api/src/app.ts`'s `saveActivePolicy` for the two call sites that do
 * this. Because that raw `set_config` call is a `tx.$executeRaw` operation, it
 * ALSO re-enters this hook; `bypassOrgBindingStore` is set for the duration of
 * that specific call in each of those two call sites (via `withUnmanagedOrgBinding`)
 * so this hook does not try to wrap or gate it, and instead simply forwards it to
 * `query(args)` on the real `tx` connection.
 */
const bypassOrgBindingStore = new AsyncLocalStorage<true>();

/**
 * Run `callback` (which must issue exactly the caller's own `tx.$executeRaw`
 * GUC-binding statement, followed by the rest of an interactive transaction's
 * work) without the `$allOperations` hook attempting its own standalone
 * wrap-in-transaction binding. Use this to wrap an interactive transaction
 * callback when the caller is binding `agentforge.current_org` itself on the
 * real `tx` handle -- see the module doc comment on `createPrismaClient`.
 */
export function withUnmanagedOrgBinding<T>(callback: () => Promise<T> | T): Promise<T> {
  return bypassOrgBindingStore.run(true, async () => callback());
}

export function createPrismaClient(connectionString: string): PrismaClient {
  const base = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const extended = base.$extends({
    query: {
      async $allOperations({ args, query }) {
        if (bypassOrgBindingStore.getStore()) {
          return query(args);
        }
        const organizationId = orgContextStore.getStore();
        if (organizationId) {
          const [, result] = await base.$transaction([
            base.$executeRaw`SELECT set_config('agentforge.current_org', ${organizationId}, true)`,
            query(args)
          ]);
          return result;
        }
        if (systemContextStore.getStore()) {
          const [, result] = await base.$transaction([
            base.$executeRaw`SELECT set_config('agentforge.system_task', 'true', true)`,
            query(args)
          ]);
          return result;
        }
        return query(args);
      }
    }
  });
  return extended as unknown as PrismaClient;
}

type BypassRlsRoleCheckRow = {
  bypasses_rls: boolean;
};

/**
 * Verifies that the connected Postgres role is actually subject to Row-Level
 * Security -- i.e. is not a superuser and does not have `BYPASSRLS`. RLS is
 * **silently bypassed** for such roles (documented Postgres behavior), which
 * would make the tenant-isolation backstop described in
 * `docs/tenant-isolation-rls.md` completely inert without any error at
 * runtime. See that doc's "REQUIRED: run the application as a non-superuser
 * role" section for the role-provisioning step this check verifies.
 *
 * Fails closed (throws) when `nodeEnv` is `"production"` and the connected
 * role bypasses RLS, mirroring `validateProductionConfig`'s fail-closed
 * pattern in `@agentforge/config`. Outside production -- including local
 * Docker Compose, where the default `agentforge`/`agentforge` role is a
 * superuser by design (an accepted local-dev simplification) -- this only
 * logs a warning and does not throw, so local/test startup is unaffected.
 *
 * This requires a live DB round-trip, so unlike the rest of
 * `validateProductionConfig` (pure env-var validation) it cannot run inside
 * that synchronous check. Callers (`apps/api`, `apps/worker`) must invoke this
 * once at process startup, after constructing their `PrismaClient` via
 * `createPrismaClient` and before serving traffic or processing jobs.
 */
export async function assertOrgIsolationEnforced(
  prisma: PrismaClient,
  nodeEnv: "development" | "test" | "production"
): Promise<void> {
  const rows = await prisma.$queryRaw<
    BypassRlsRoleCheckRow[]
  >`SELECT (rolsuper OR rolbypassrls) AS bypasses_rls FROM pg_roles WHERE rolname = current_user`;
  const bypassesRls = rows[0]?.bypasses_rls ?? false;
  if (!bypassesRls) {
    return;
  }
  const message =
    "The connected Postgres role is a superuser or has BYPASSRLS, so the Row-Level " +
    "Security tenant-isolation backstop is silently inert for this connection. Connect " +
    "as a NOSUPERUSER NOBYPASSRLS role (see docs/tenant-isolation-rls.md and " +
    "docs/railway-deployment.md for the exact role-provisioning SQL).";
  if (nodeEnv === "production") {
    throw new Error(`Unsafe AgentForge production configuration: ${message}`);
  }
  console.warn(message);
}
