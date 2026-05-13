import { defineConfig, devices } from "@playwright/test";

const appBaseUrl = process.env.APP_BASE_URL ?? "http://127.0.0.1:3100";
const apiBaseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:4100";
const appPort = new URL(appBaseUrl).port || "3000";
const apiPort = new URL(apiBaseUrl).port || "4000";

export default defineConfig({
  testDir: "apps/web/e2e",
  timeout: 30_000,
  use: {
    baseURL: appBaseUrl,
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
        "GITHUB_WEBHOOK_SECRET=e2e-secret DATABASE_URL= REDIS_URL= pnpm dev:api",
      url: `${apiBaseUrl}/health`,
      reuseExistingServer: false,
      timeout: 120_000
    },
    {
      command:
        "pnpm --filter @agentforge/web build && " +
        `API_BASE_URL=${apiBaseUrl} pnpm --filter @agentforge/web exec next start ` +
        `--hostname 127.0.0.1 --port ${appPort}`,
      url: appBaseUrl,
      reuseExistingServer: false,
      timeout: 120_000
    }
  ]
});
