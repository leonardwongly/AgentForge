import { afterEach, describe, expect, it } from "vitest";
import { apiActorHeaders } from "./api-actor-headers";
import type { DashboardActorContext } from "./actor-context";

const sessionActor: DashboardActorContext = {
  login: "octocat",
  role: "platform_admin",
  organizationId: "org-a",
  source: "session"
};

describe("apiActorHeaders", () => {
  afterEach(() => {
    delete process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS;
    delete process.env.AGENTFORGE_API_PROXY_SECRET;
  });

  it("uses local actor headers when API proxy header trust is disabled", () => {
    process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS = "false";

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
