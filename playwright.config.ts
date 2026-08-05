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
const e2eSessionSecret = "vN4mQ8zK2rT7xP5cL9sD3fH6jW1yB0uG8aE4iO7pR2kM5qZ9nC6tV3xS1dF8hJ4";
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
