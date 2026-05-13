import { describe, expect, it } from "vitest";
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
          "x-agentforge-authenticated-role": "platform_admin"
        }),
        nodeEnv: "production"
      })
    ).toEqual({
      login: "alex",
      role: "platform_admin",
      source: "trusted_headers"
    });
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

  it("uses local actor fallback outside production", () => {
    expect(
      resolveDashboardActorContext({
        env: {
          AGENTFORGE_DASHBOARD_ACTOR: "dashboard-local",
          AGENTFORGE_DASHBOARD_ROLE: "engineering_manager"
        },
        nodeEnv: "development"
      })
    ).toEqual({
      login: "dashboard-local",
      role: "engineering_manager",
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
