import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";
import {
  DASHBOARD_SESSION_COOKIE,
  createDashboardSessionCookie
} from "./apps/web/app/auth/session";

const appBaseUrl = process.env.APP_BASE_URL ?? "http://127.0.0.1:3100";
const apiBaseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:4100";
const appUrl = new URL(appBaseUrl);
const appPort = appUrl.port || "3000";
const apiPort = new URL(apiBaseUrl).port || "4000";
// Generate an isolated test secret once per Playwright invocation. Playwright
// reloads this config in worker processes, so persist the generated value in
// the inherited environment; otherwise the browser cookie and Next server can
// be signed with different secrets and every API-backed page appears logged
// out.
const e2eSessionSecret = (() => {
  const existing = process.env.E2E_SESSION_SECRET;
  if (existing) {
    return existing;
  }
  const generated = randomBytes(32).toString("base64url");
  process.env.E2E_SESSION_SECRET = generated;
  return generated;
})();
const e2eSessionCookie = createDashboardSessionCookie(
  {
    login: "playwright",
    role: "platform_admin",
    organizationId: "org_local",
    provider: "github"
  },
  e2eSessionSecret
);

export default defineConfig({
  testDir: "apps/web/e2e",
  timeout: 30_000,
  use: {
    baseURL: appBaseUrl,
    storageState: {
      cookies: [
        {
          name: DASHBOARD_SESSION_COOKIE,
          value: e2eSessionCookie,
          domain: appUrl.hostname,
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: appUrl.protocol === "https:",
          sameSite: "Lax"
        }
      ],
      origins: []
    },
    trace: "on-first-retry"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ],
  webServer: [
    {
      command:
        `NODE_ENV=test PORT=${apiPort} HOST=127.0.0.1 APP_BASE_URL=${appBaseUrl} ` +
        "GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= GITHUB_WEBHOOK_SECRET=e2e-secret " +
        "AGENTFORGE_API_TRUST_PROXY_HEADERS=false AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS=true " +
        "DATABASE_URL= REDIS_URL= pnpm dev:api",
      url: `${apiBaseUrl}/health`,
      reuseExistingServer: false,
      timeout: 120_000
    },
    {
      command:
        "pnpm exec tsx scripts/e2e-preflight.ts --require-build --skip-port-check --skip-e2e-lock-check && " +
        `API_BASE_URL=${apiBaseUrl} SESSION_SECRET=${e2eSessionSecret} ` +
        "GITHUB_CLIENT_ID= GITHUB_CLIENT_SECRET= " +
        // The session fixture uses the synthetic `playwright` login. Override
        // any developer .env allow-list so the production-style server accepts
        // only this intentionally scoped test identity.
        "AGENTFORGE_GITHUB_ADMIN_LOGINS=playwright,evidence-reviewer " +
        "AGENTFORGE_DASHBOARD_ORGANIZATION=org_local " +
        "AGENTFORGE_API_TRUST_PROXY_HEADERS=false " +
        "AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS=true " +
        "AGENTFORGE_ENABLE_SAMPLE_PREVIEW=true AGENTFORGE_SAMPLE_FIXTURE_ROOT=$PWD " +
        "pnpm --filter @agentforge/web exec next start " +
        `--hostname 127.0.0.1 --port ${appPort}`,
      url: appBaseUrl,
      reuseExistingServer: false,
      timeout: 120_000
    }
  ]
});
