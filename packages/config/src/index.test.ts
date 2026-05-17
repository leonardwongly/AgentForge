import { describe, expect, it } from "vitest";
import { loadConfig } from "./index.js";

const productionBaseEnv = {
  NODE_ENV: "production",
  GITHUB_WEBHOOK_SECRET: "production-secret",
  SOURCE_CODE_STORAGE: "false",
  REDACT_SECRETS: "true",
  ALLOW_UNSIGNED_GITHUB_WEBHOOKS: "false"
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
    ["redaction disabled", { REDACT_SECRETS: "false" }, "REDACT_SECRETS"]
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
});
