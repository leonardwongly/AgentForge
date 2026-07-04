// Test environment guard.
//
// Tests must behave identically to CI, i.e. a clean shell with no AgentForge
// runtime configuration exported. Locally, developers commonly export the
// development-only variables documented in the README (NODE_ENV=development,
// empty DATABASE_URL/REDIS_URL, AGENTFORGE_*_ALLOW_LOCAL_ACTOR=true, the
// sample-preview flag, etc.). Without this guard those leak into the test
// process and silently change behavior:
//
//   - NODE_ENV=development makes apps/api/src/app.ts#createApp build a real
//     PrismaClient + Redis connection (config.databaseUrl falls back to the
//     local URL and `nodeEnv !== "test"`), so API tests hit a Postgres/Redis
//     that isn't running and fail with connection errors instead of using the
//     in-memory persistence port.
//   - AGENTFORGE_*_ALLOW_LOCAL_ACTOR=true makes the production-config tests
//     trip validateProductionConfig (these flags must be false in production).
//
// This file runs before every test file (see `setupFiles` in vitest.config.ts).
// It forces NODE_ENV=test and removes the AgentForge config variables so every
// run starts from the schema defaults. Tests that need a specific value set it
// explicitly (e.g. security-hardening.test.ts#setProductionProxyAuthEnv), so
// clearing the inherited baseline here is safe and deterministic.

const originalNodeEnv = process.env.NODE_ENV;

// Variables consumed by packages/config envSchema plus the local-only
// sample-preview flag. Clearing them yields the same baseline as CI.
const CONTAMINATING_ENV_KEYS = [
  "DATABASE_URL",
  "REDIS_URL",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_INSTALLATION_ID",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_APP_SLUG",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "ALLOW_UNSIGNED_GITHUB_WEBHOOKS",
  "AGENTFORGE_GITHUB_ADMIN_LOGINS",
  "AGENTFORGE_GITHUB_ALLOWED_LOGINS",
  "APP_BASE_URL",
  "API_BASE_URL",
  "DEFAULT_POLICY_MODE",
  "SOURCE_CODE_STORAGE",
  "FULL_DIFF_RETENTION",
  "REDACT_SECRETS",
  "LLM_FEATURES",
  "AUDIT_RECORD_RETENTION_DAYS",
  "EXPORT_STORAGE_BUCKET",
  "EXPORT_STORAGE_REGION",
  "SESSION_SECRET",
  "AGENTFORGE_API_PROXY_SECRET",
  "AGENTFORGE_API_TRUST_PROXY_HEADERS",
  "AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS",
  "AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS",
  "AGENTFORGE_DASHBOARD_PROXY_SECRET",
  "AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR",
  "AGENTFORGE_DASHBOARD_ORGANIZATION",
  "AGENTFORGE_AUTH_PROXY_STRIPS_HEADERS",
  "AGENTFORGE_ENABLE_SAMPLE_PREVIEW"
] as const;

const neutralized = CONTAMINATING_ENV_KEYS.filter((key) => process.env[key] !== undefined);
for (const key of neutralized) {
  delete process.env[key];
}

// Force the test runtime last so an exported NODE_ENV cannot win.
process.env.NODE_ENV = "test";

// Surface contamination loudly (without failing the run) so the underlying
// shell/.env leak gets noticed and fixed at the source. setupFiles runs once
// per test file, so keep this to a single concise line to avoid log spam.
if (neutralized.length > 0 || (originalNodeEnv && originalNodeEnv !== "test")) {
  const nodeEnvNote =
    originalNodeEnv && originalNodeEnv !== "test" ? `NODE_ENV ${originalNodeEnv}->test` : "";
  const clearedNote = neutralized.length > 0 ? `cleared ${neutralized.length} config var(s)` : "";
  const summary = [nodeEnvNote, clearedNote].filter(Boolean).join(", ");
  console.warn(
    `[vitest:env-guard] Neutralized contaminating environment for CI parity (${summary}).`
  );
}
