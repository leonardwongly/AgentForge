import { afterEach, describe, expect, it } from "vitest";
import type { AgentForgeConfig } from "@agentforge/config";
import { hydrateApiAuthEnvironment } from "../src/runtime-env.js";

const envKeys = [
  "AGENTFORGE_API_TRUST_PROXY_HEADERS",
  "AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS",
  "AGENTFORGE_API_PROXY_SECRET"
];

describe("API runtime environment hydration", () => {
  const original = new Map(envKeys.map((key) => [key, process.env[key]]));

  afterEach(() => {
    for (const key of envKeys) {
      const value = original.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("hydrates auth flags from parsed config when process env is unset", () => {
    for (const key of envKeys) {
      delete process.env[key];
    }

    hydrateApiAuthEnvironment(configWithAuth({ apiAllowLocalActorHeaders: true }));

    expect(process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS).toBe("false");
    expect(process.env.AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS).toBe("true");
    expect(process.env.AGENTFORGE_API_PROXY_SECRET).toBe("proxy-secret");
  });

  it("does not override explicit process env values", () => {
    process.env.AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS = "false";

    hydrateApiAuthEnvironment(configWithAuth({ apiAllowLocalActorHeaders: true }));

    expect(process.env.AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS).toBe("false");
  });
});

function configWithAuth(auth: Partial<AgentForgeConfig["auth"]> = {}): AgentForgeConfig {
  return {
    databaseUrl: undefined,
    redisUrl: undefined,
    nodeEnv: "development",
    github: {
      appId: undefined,
      privateKey: undefined,
      installationId: undefined,
      webhookSecret: undefined,
      appSlug: undefined,
      allowUnsignedWebhooks: false,
      clientId: undefined,
      clientSecret: undefined,
      adminLogins: undefined,
      allowedLogins: undefined
    },
    appBaseUrl: "http://localhost:3000",
    apiBaseUrl: "http://localhost:4000",
    defaultPolicyMode: "observe",
    sourceCodeStorage: false,
    fullDiffRetention: "disabled",
    redactSecrets: true,
    llmFeatures: false,
    auditRecordRetentionDays: 365,
    exportStorageBucket: undefined,
    exportStorageRegion: undefined,
    sessionSecret: undefined,
    auth: {
      apiTrustProxyHeaders: false,
      apiAllowLocalActorHeaders: false,
      dashboardTrustProxyHeaders: false,
      dashboardAllowLocalActor: false,
      proxyStripsIdentityHeaders: false,
      apiProxySecret: "proxy-secret",
      ...auth
    },
    dashboard: {
      organizationId: undefined
    }
  };
}
