import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DASHBOARD_SESSION_COOKIE, createDashboardSessionCookie } from "../auth/session";
import { dashboardActorErrorMessage, resolveDashboardActorContext } from "./actor-context";

const DASHBOARD_PROXY_SECRET = "test-dashboard-proxy-secret";

function signedTrustedHeaders(
  identity: { login: string; role: string; organizationId: string },
  options: { secret?: string; timestamp?: number; nonce?: string } = {}
): Record<string, string> {
  const secret = options.secret ?? DASHBOARD_PROXY_SECRET;
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = options.nonce ?? randomBytes(8).toString("hex");
  const signature = createHmac("sha256", secret)
    .update([timestamp, nonce, identity.login, identity.role, identity.organizationId].join(":"))
    .digest("hex");
  return {
    "x-agentforge-authenticated-actor": identity.login,
    "x-agentforge-authenticated-role": identity.role,
    "x-agentforge-authenticated-organization": identity.organizationId,
    "x-agentforge-signature-timestamp": timestamp,
    "x-agentforge-signature-nonce": nonce,
    "x-agentforge-signature": signature
  };
}

function headers(values: Record<string, string | undefined>) {
  return {
    get(name: string) {
      return values[name.toLowerCase()] ?? undefined;
    }
  };
}

describe("dashboard actor context", () => {
  it("uses trusted authenticated headers when explicitly enabled and signed", () => {
    expect(
      resolveDashboardActorContext({
        env: {
          AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS: "true",
          AGENTFORGE_DASHBOARD_PROXY_SECRET: DASHBOARD_PROXY_SECRET
        },
        headers: headers(
          signedTrustedHeaders({
            login: "alex",
            role: "platform_admin",
            organizationId: "org-a"
          })
        ),
        nodeEnv: "production"
      })
    ).toEqual({
      login: "alex",
      role: "platform_admin",
      organizationId: "org-a",
      source: "trusted_headers"
    });
  });

  it("rejects unsigned trusted authenticated headers", () => {
    expect(
      resolveDashboardActorContext({
        env: {
          AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS: "true",
          AGENTFORGE_DASHBOARD_PROXY_SECRET: DASHBOARD_PROXY_SECRET
        },
        headers: headers({
          "x-agentforge-authenticated-actor": "alex",
          "x-agentforge-authenticated-role": "platform_admin",
          "x-agentforge-authenticated-organization": "org-a"
        }),
        nodeEnv: "production"
      })
    ).toBeUndefined();
  });

  it("rejects trusted headers signed with the wrong secret", () => {
    expect(
      resolveDashboardActorContext({
        env: {
          AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS: "true",
          AGENTFORGE_DASHBOARD_PROXY_SECRET: DASHBOARD_PROXY_SECRET
        },
        headers: headers(
          signedTrustedHeaders(
            { login: "alex", role: "platform_admin", organizationId: "org-a" },
            { secret: "attacker-secret" }
          )
        ),
        nodeEnv: "production"
      })
    ).toBeUndefined();
  });

  it("rejects trusted headers when no dashboard proxy secret is configured", () => {
    expect(
      resolveDashboardActorContext({
        env: { AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS: "true" },
        headers: headers(
          signedTrustedHeaders({
            login: "alex",
            role: "platform_admin",
            organizationId: "org-a"
          })
        ),
        nodeEnv: "production"
      })
    ).toBeUndefined();
  });

  it("rejects a replayed signed trusted-header request", () => {
    const env = {
      AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS: "true",
      AGENTFORGE_DASHBOARD_PROXY_SECRET: DASHBOARD_PROXY_SECRET
    };
    const signed = signedTrustedHeaders({
      login: "alex",
      role: "platform_admin",
      organizationId: "org-a"
    });
    expect(
      resolveDashboardActorContext({ env, headers: headers(signed), nodeEnv: "production" })
    ).toEqual({
      login: "alex",
      role: "platform_admin",
      organizationId: "org-a",
      source: "trusted_headers"
    });
    // Same signature replayed within the window is rejected.
    expect(
      resolveDashboardActorContext({ env, headers: headers(signed), nodeEnv: "production" })
    ).toBeUndefined();
  });

  it("requires trusted authenticated headers to include organization identity", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = "fixednonce";
    const signature = createHmac("sha256", DASHBOARD_PROXY_SECRET)
      .update([timestamp, nonce, "alex", "platform_admin"].join(":"))
      .digest("hex");
    expect(
      resolveDashboardActorContext({
        env: {
          AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS: "true",
          AGENTFORGE_DASHBOARD_PROXY_SECRET: DASHBOARD_PROXY_SECRET
        },
        headers: headers({
          "x-agentforge-authenticated-actor": "alex",
          "x-agentforge-authenticated-role": "platform_admin",
          "x-agentforge-signature-timestamp": timestamp,
          "x-agentforge-signature-nonce": nonce,
          "x-agentforge-signature": signature
        }),
        nodeEnv: "production"
      })
    ).toBeUndefined();
  });

  it("does not trust incoming actor headers unless proxy header trust is enabled", () => {
    expect(
      resolveDashboardActorContext({
        env: {},
        headers: headers({
          "x-agentforge-authenticated-actor": "alex",
          "x-agentforge-authenticated-role": "platform_admin"
        }),
        nodeEnv: "production"
      })
    ).toBeUndefined();
  });

  it("uses a signed GitHub OAuth session when trusted proxy headers are absent", () => {
    const session = createDashboardSessionCookie(
      {
        login: "octocat",
        role: "platform_admin",
        organizationId: "org-a",
        provider: "github"
      },
      "test-session-secret"
    );

    expect(
      resolveDashboardActorContext({
        env: { SESSION_SECRET: "test-session-secret" },
        headers: headers({
          cookie: `${DASHBOARD_SESSION_COOKIE}=${session}`
        }),
        nodeEnv: "production"
      })
    ).toEqual({
      login: "octocat",
      role: "platform_admin",
      organizationId: "org-a",
      source: "session"
    });
  });

  it("rejects tampered GitHub OAuth session cookies", () => {
    const session = createDashboardSessionCookie(
      {
        login: "octocat",
        role: "platform_admin",
        organizationId: "org-a",
        provider: "github"
      },
      "test-session-secret"
    );

    expect(
      resolveDashboardActorContext({
        env: { SESSION_SECRET: "test-session-secret" },
        headers: headers({
          cookie: `${DASHBOARD_SESSION_COOKIE}=${session}x`
        }),
        nodeEnv: "production"
      })
    ).toBeUndefined();
  });

  it("does not treat raw actor headers as trusted proxy identity", () => {
    expect(
      resolveDashboardActorContext({
        env: { AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS: "true" },
        headers: headers({
          "x-agentforge-actor": "alex",
          "x-agentforge-role": "platform_admin"
        }),
        nodeEnv: "production"
      })
    ).toBeUndefined();
  });

  it("requires explicit local actor fallback outside production", () => {
    expect(
      resolveDashboardActorContext({
        env: {
          AGENTFORGE_DASHBOARD_ACTOR: "dashboard-local",
          AGENTFORGE_DASHBOARD_ROLE: "engineering_manager",
          AGENTFORGE_DASHBOARD_ORGANIZATION: "org-dev"
        },
        nodeEnv: "development"
      })
    ).toBeUndefined();

    expect(
      resolveDashboardActorContext({
        env: {
          AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR: "true",
          AGENTFORGE_DASHBOARD_ACTOR: "dashboard-local",
          AGENTFORGE_DASHBOARD_ROLE: "engineering_manager",
          AGENTFORGE_DASHBOARD_ORGANIZATION: "org-dev"
        },
        nodeEnv: "development"
      })
    ).toEqual({
      login: "dashboard-local",
      role: "engineering_manager",
      organizationId: "org-dev",
      source: "local_environment"
    });
  });

  it("uses a non-admin local actor by default", () => {
    expect(
      resolveDashboardActorContext({
        env: {
          AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR: "true",
          AGENTFORGE_DASHBOARD_ACTOR: "dashboard-local"
        },
        nodeEnv: "development"
      })
    ).toEqual({
      login: "dashboard-local",
      role: "developer",
      organizationId: "org_local",
      source: "local_environment"
    });
  });

  it("allows an explicit admin local actor override", () => {
    expect(
      resolveDashboardActorContext({
        env: {
          AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR: "true",
          AGENTFORGE_DASHBOARD_ACTOR: "dashboard-local",
          AGENTFORGE_DASHBOARD_ROLE: "platform_admin"
        },
        nodeEnv: "production"
      })
    ).toEqual({
      login: "dashboard-local",
      role: "platform_admin",
      organizationId: "org_local",
      source: "local_environment"
    });
  });

  it("rejects invalid actor and role values", () => {
    expect(
      resolveDashboardActorContext({
        env: {
          AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR: "true",
          AGENTFORGE_DASHBOARD_ACTOR: "bad\r\nactor",
          AGENTFORGE_DASHBOARD_ROLE: "owner"
        },
        nodeEnv: "production"
      })
    ).toBeUndefined();
  });

  it("provides an actionable missing-auth message", () => {
    expect(dashboardActorErrorMessage()).toContain("Authenticated dashboard actor context");
  });
});
