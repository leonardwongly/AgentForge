import { describe, expect, it } from "vitest";
import { loadConfig } from "./index.js";

const productionBaseEnv = {
  NODE_ENV: "production",
  GITHUB_WEBHOOK_SECRET: "production-secret",
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
