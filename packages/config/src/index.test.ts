import { describe, expect, it } from "vitest";
import { loadConfig } from "./index.js";

const productionBaseEnv = {
  NODE_ENV: "production",
  GITHUB_WEBHOOK_SECRET: "production-secret",
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY: [
    ["-----BEGIN", "PRIVATE", "KEY-----"].join(" "),
    "test",
    ["-----END", "PRIVATE", "KEY-----"].join(" ")
  ].join("\n"),
  GITHUB_APP_SLUG: "agentforge-test",
  GITHUB_CLIENT_ID: "Iv1.test",
  GITHUB_CLIENT_SECRET: "github-client-secret",
  SESSION_SECRET: "session-secret-32-characters-long",
  SOURCE_CODE_STORAGE: "false",
  REDACT_SECRETS: "true",
  ALLOW_UNSIGNED_GITHUB_WEBHOOKS: "false",
  AGENTFORGE_API_TRUST_PROXY_HEADERS: "true",
  AGENTFORGE_API_PROXY_SECRET: "test-proxy-secret-987654",
  AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS: "true",
  AGENTFORGE_AUTH_PROXY_STRIPS_HEADERS: "true"
};

describe("AgentForge runtime config", () => {
  it("does not inject local database or Redis defaults in production", () => {
    const config = loadConfig(productionBaseEnv);

    expect(config.databaseUrl).toBeUndefined();
    expect(config.redisUrl).toBeUndefined();
  });

  it.each([
    ["missing webhook secret", { GITHUB_WEBHOOK_SECRET: "" }, "GITHUB_WEBHOOK_SECRET"],
    ["missing GitHub App id", { GITHUB_APP_ID: "" }, "GITHUB_APP_ID"],
    ["missing GitHub App private key", { GITHUB_APP_PRIVATE_KEY: "" }, "GITHUB_APP_PRIVATE_KEY"],
    ["missing GitHub OAuth client id", { GITHUB_CLIENT_ID: "" }, "GITHUB_CLIENT_ID"],
    ["missing GitHub OAuth client secret", { GITHUB_CLIENT_SECRET: "" }, "GITHUB_CLIENT_SECRET"],
    ["missing session secret", { SESSION_SECRET: "" }, "SESSION_SECRET"],
    ["unsigned webhooks enabled", { ALLOW_UNSIGNED_GITHUB_WEBHOOKS: "true" }, "ALLOW_UNSIGNED"],
    ["source storage enabled", { SOURCE_CODE_STORAGE: "true" }, "SOURCE_CODE_STORAGE"],
    ["redaction disabled", { REDACT_SECRETS: "false" }, "REDACT_SECRETS"],
    [
      "API trusted proxy headers disabled",
      { AGENTFORGE_API_TRUST_PROXY_HEADERS: "false" },
      "AGENTFORGE_API_TRUST_PROXY_HEADERS"
    ],
    [
      "dashboard trusted proxy headers disabled",
      { AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS: "false" },
      "AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS"
    ],
    [
      "API local actor headers enabled",
      { AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS: "true" },
      "AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS"
    ],
    [
      "dashboard local actor enabled",
      { AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR: "true" },
      "AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR"
    ],
    [
      "auth proxy header stripping not acknowledged",
      { AGENTFORGE_AUTH_PROXY_STRIPS_HEADERS: "false" },
      "AGENTFORGE_AUTH_PROXY_STRIPS_HEADERS"
    ],
    [
      "API proxy secret is missing",
      { AGENTFORGE_API_PROXY_SECRET: "" },
      "AGENTFORGE_API_PROXY_SECRET"
    ]
  ])("fails closed in production when %s", (_name, override, message) => {
    expect(() => loadConfig({ ...productionBaseEnv, ...override })).toThrow(message);
  });

  it("allows trusted-proxy-only production deployments without optional dashboard OAuth", () => {
    const config = loadConfig({
      ...productionBaseEnv,
      GITHUB_APP_SLUG: "",
      GITHUB_CLIENT_ID: "",
      GITHUB_CLIENT_SECRET: "",
      SESSION_SECRET: ""
    });

    expect(config.github.appSlug).toBeUndefined();
    expect(config.github.clientId).toBeUndefined();
    expect(config.github.clientSecret).toBeUndefined();
    expect(config.sessionSecret).toBeUndefined();
  });

  it("keeps local runtime defaults for development setup", () => {
    const config = loadConfig({ NODE_ENV: "development" });

    expect(config.databaseUrl).toBe(
      "postgresql://agentforge:agentforge@localhost:15432/agentforge"
    );
    expect(config.redisUrl).toBe("redis://localhost:6379");
  });

  it("loads optional GitHub installation id for local smoke tests", () => {
    const config = loadConfig({
      NODE_ENV: "development",
      GITHUB_INSTALLATION_ID: "12345"
    });

    expect(config.github.installationId).toBe("12345");
  });

  it("rejects local actor modes on non-loopback URLs", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "development",
        APP_BASE_URL: "https://dashboard.example.com",
        API_BASE_URL: "http://localhost:4000",
        AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR: "true"
      })
    ).toThrow("Unsafe AgentForge local actor configuration");

    expect(() =>
      loadConfig({
        NODE_ENV: "development",
        APP_BASE_URL: "http://localhost:3000",
        API_BASE_URL: "https://api.example.com",
        AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS: "true"
      })
    ).toThrow("API_BASE_URL must use localhost");
  });

  it("allows local actor modes on loopback URLs", () => {
    const config = loadConfig({
      NODE_ENV: "development",
      APP_BASE_URL: "http://127.0.0.1:3000",
      API_BASE_URL: "http://[::1]:4000",
      AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR: "true",
      AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS: "true"
    });

    expect(config.auth.dashboardAllowLocalActor).toBe(true);
    expect(config.auth.apiAllowLocalActorHeaders).toBe(true);
  });

  it("loads built-in GitHub OAuth authorization settings", () => {
    const config = loadConfig({
      NODE_ENV: "development",
      GITHUB_CLIENT_ID: "Iv1.local",
      GITHUB_CLIENT_SECRET: "github-client-secret",
      SESSION_SECRET: "session-secret",
      AGENTFORGE_GITHUB_ADMIN_LOGINS: "octocat",
      AGENTFORGE_GITHUB_ALLOWED_LOGINS: "hubot",
      AGENTFORGE_DASHBOARD_ORGANIZATION: "org-dev"
    });

    expect(config.github).toMatchObject({
      clientId: "Iv1.local",
      clientSecret: "github-client-secret",
      adminLogins: "octocat",
      allowedLogins: "hubot"
    });
    expect(config.sessionSecret).toBe("session-secret");
    expect(config.dashboard.organizationId).toBe("org-dev");
  });

  it("loads the explicit proxy-only auth boundary flags", () => {
    const config = loadConfig(productionBaseEnv);

    expect(config.auth).toMatchObject({
      apiTrustProxyHeaders: true,
      dashboardTrustProxyHeaders: true,
      proxyStripsIdentityHeaders: true,
      apiAllowLocalActorHeaders: false,
      dashboardAllowLocalActor: false
    });
  });
});
