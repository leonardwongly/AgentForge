import { loadConfig } from "@agentforge/config";
import { assertOrgIsolationEnforced, createPrismaClient } from "@agentforge/db";
import { createApp } from "./app.js";
import { hydrateApiAuthEnvironment } from "./runtime-env.js";

const config = loadConfig();
hydrateApiAuthEnvironment(config);

// Verify the RLS tenant-isolation backstop is actually enforceable for the
// connected Postgres role before serving traffic. This is a separate,
// short-lived connection (not the pool `createApp` builds internally) purely
// for this one-time startup check, so it never affects createApp's own
// Prisma lifecycle or test behavior (tests call createApp directly and never
// exercise this file). Best-effort in non-production (a warning is logged by
// assertOrgIsolationEnforced itself); fails closed (throws, exits) in
// production, matching every other fail-closed production check in this
// codebase.
//
// Matches createApp's own `config.databaseUrl && config.nodeEnv !== "test"`
// guard exactly (apps/api/src/app.ts): loadConfig() synthesizes a local-dev
// default databaseUrl whenever NODE_ENV isn't "production", even if
// DATABASE_URL was explicitly blanked to force in-memory runtime mode (e.g.
// playwright.config.ts's E2E webServer sets NODE_ENV=test DATABASE_URL= to
// intentionally run the API without a database). Without the nodeEnv check
// here too, this would try to connect to the synthesized local-dev URL
// (a different port than any real database actually running) and crash
// the process at startup instead of skipping cleanly.
if (config.databaseUrl && config.nodeEnv !== "test") {
  const isolationCheckClient = createPrismaClient(config.databaseUrl);
  try {
    await assertOrgIsolationEnforced(isolationCheckClient, config.nodeEnv);
  } finally {
    await isolationCheckClient.$disconnect().catch(() => undefined);
  }
}

const app = createApp();
const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "0.0.0.0";

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
