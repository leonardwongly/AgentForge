import { afterEach, describe, expect, it } from "vitest";
import { apiActorHeaders } from "./api-actor-headers";
import type { DashboardActorContext } from "./actor-context";

const mutableEnvKeys = [
  "NODE_ENV",
  "AGENTFORGE_API_TRUST_PROXY_HEADERS",
  "AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS",
  "AGENTFORGE_API_PROXY_SECRET"
] as const;
const originalEnv = new Map<string, string | undefined>(
  mutableEnvKeys.map((key) => [key, process.env[key]])
);
const mutableEnv = process.env as Record<string, string | undefined>;

const sessionActor: DashboardActorContext = {
  login: "octocat",
  role: "platform_admin",
  organizationId: "org-a",
  source: "session"
};

describe("apiActorHeaders", () => {
  afterEach(() => {
    for (const key of mutableEnvKeys) {
      const originalValue = originalEnv.get(key);
      if (originalValue === undefined) {
        delete mutableEnv[key];
      } else {
        mutableEnv[key] = originalValue;
      }
    }
  });

  it("requires explicit local API header mode before forwarding raw actor headers", () => {
    mutableEnv.NODE_ENV = "development";
    mutableEnv.AGENTFORGE_API_TRUST_PROXY_HEADERS = "false";
    delete mutableEnv.AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS;

    expect(() => apiActorHeaders(sessionActor)).toThrow(
      "AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS=true is required"
    );

    mutableEnv.AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS = "true";

    expect(apiActorHeaders(sessionActor)).toEqual({
      "x-agentforge-actor": "octocat",
      "x-agentforge-role": "platform_admin",
      "x-agentforge-organization": "org-a"
    });
  });

  it("uses signed authenticated headers when API proxy header trust is enabled", () => {
    process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS = "true";
    process.env.AGENTFORGE_API_PROXY_SECRET = "test-proxy-secret";

    expect(apiActorHeaders(sessionActor)).toEqual(
      expect.objectContaining({
        "x-agentforge-authenticated-actor": "octocat",
        "x-agentforge-authenticated-role": "platform_admin",
        "x-agentforge-authenticated-organization": "org-a",
        "x-agentforge-signature-timestamp": expect.any(String),
        "x-agentforge-signature": expect.stringMatching(/^[a-f0-9]{64}$/u)
      })
    );
  });
});
