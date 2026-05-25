import { describe, expect, it } from "vitest";
import { DASHBOARD_SESSION_COOKIE, createDashboardSessionCookie } from "../auth/session";
import { dashboardActorErrorMessage, resolveDashboardActorContext } from "./actor-context";

function headers(values: Record<string, string | undefined>) {
  return {
    get(name: string) {
      return values[name.toLowerCase()] ?? undefined;
    }
  };
}

describe("dashboard actor context", () => {
  it("uses trusted authenticated headers when explicitly enabled", () => {
    expect(
      resolveDashboardActorContext({
        env: { AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS: "true" },
        headers: headers({
          "x-agentforge-authenticated-actor": "alex",
          "x-agentforge-authenticated-role": "platform_admin",
          "x-agentforge-authenticated-organization": "org-a"
        }),
        nodeEnv: "production"
      })
    ).toEqual({
      login: "alex",
      role: "platform_admin",
      organizationId: "org-a",
      source: "trusted_headers"
    });
  });

  it("requires trusted authenticated headers to include organization identity", () => {
    expect(
      resolveDashboardActorContext({
        env: { AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS: "true" },
        headers: headers({
          "x-agentforge-authenticated-actor": "alex",
          "x-agentforge-authenticated-role": "platform_admin"
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

  it("uses local actor fallback outside production", () => {
    expect(
      resolveDashboardActorContext({
        env: {
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

  it("requires an explicit local actor fallback in production", () => {
    expect(
      resolveDashboardActorContext({
        env: {
          AGENTFORGE_DASHBOARD_ACTOR: "dashboard-local",
          AGENTFORGE_DASHBOARD_ROLE: "platform_admin"
        },
        nodeEnv: "production"
      })
    ).toBeUndefined();

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
