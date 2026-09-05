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
  it("uses trusted authenticated headers when explicitly enabled and signed", async () => {
    expect(
      await resolveDashboardActorContext({
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

  it("rejects unsigned trusted authenticated headers", async () => {
    expect(
      await resolveDashboardActorContext({
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

  it("rejects trusted headers signed with the wrong secret", async () => {
    expect(
      await resolveDashboardActorContext({
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

  it("rejects trusted headers when no dashboard proxy secret is configured", async () => {
    expect(
      await resolveDashboardActorContext({
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

  it("rejects a request carrying an otherwise-valid signature with no nonce (mandatory-nonce enforcement)", async () => {
    // Regression test for the fix that removed the legacy nonce-less fallback:
    // dashboardActorFromTrustedHeaders must reject a nonce-less signed payload
    // outright, mirroring apps/api/src/auth.ts's resolveApiActor. Without this,
    // a nonce-less signature could be replayed indefinitely within the
    // 5-minute timestamp window since registerDashboardSignatureUse is never
    // consulted for it.
    const secret = DASHBOARD_PROXY_SECRET;
    const login = "alex";
    const role = "platform_admin";
    const organizationId = "org-a";
    const timestamp = String(Math.floor(Date.now() / 1000));
    // Legacy nonce-less payload shape (no nonce segment).
    const payload = [timestamp, login, role, organizationId].join(":");
    const signature = createHmac("sha256", secret).update(payload).digest("hex");

    expect(
      await resolveDashboardActorContext({
        env: {
          AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS: "true",
          AGENTFORGE_DASHBOARD_PROXY_SECRET: secret
        },
        headers: headers({
          "x-agentforge-authenticated-actor": login,
          "x-agentforge-authenticated-role": role,
          "x-agentforge-authenticated-organization": organizationId,
          "x-agentforge-signature-timestamp": timestamp,
          "x-agentforge-signature": signature
          // No x-agentforge-signature-nonce header.
        }),
        nodeEnv: "production"
      })
    ).toBeUndefined();
  });

  it("rejects a replayed signed trusted-header request", async () => {
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
      await resolveDashboardActorContext({ env, headers: headers(signed), nodeEnv: "production" })
    ).toEqual({
      login: "alex",
      role: "platform_admin",
      organizationId: "org-a",
      source: "trusted_headers"
    });
    // Same signature replayed within the window is rejected.
    expect(
      await resolveDashboardActorContext({ env, headers: headers(signed), nodeEnv: "production" })
    ).toBeUndefined();
  });

  it("resolves the SAME signed headers exactly once even when awaited concurrently", async () => {
    // Stronger regression guard than the sequential replay case above: two
    // concurrent resolutions of the identical signed header set must not both
    // succeed just because neither had claimed the nonce yet when the other
    // started -- the Redis-backed SignatureReplayGuard's atomic SET NX EX
    // must still allow only one winner even under a real race.
    const env = {
      AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS: "true",
      AGENTFORGE_DASHBOARD_PROXY_SECRET: DASHBOARD_PROXY_SECRET
    };
    const signed = signedTrustedHeaders({
      login: "alex",
      role: "platform_admin",
      organizationId: "org-a"
    });

    const [first, second] = await Promise.all([
      resolveDashboardActorContext({ env, headers: headers(signed), nodeEnv: "production" }),
      resolveDashboardActorContext({ env, headers: headers(signed), nodeEnv: "production" })
    ]);
    const results = [first, second];
    const winners = results.filter((result) => result !== undefined);
    const losers = results.filter((result) => result === undefined);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(winners[0]).toEqual({
      login: "alex",
      role: "platform_admin",
      organizationId: "org-a",
      source: "trusted_headers"
    });
  });

  it("requires trusted authenticated headers to include organization identity", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = "fixednonce";
    const signature = createHmac("sha256", DASHBOARD_PROXY_SECRET)
      .update([timestamp, nonce, "alex", "platform_admin"].join(":"))
      .digest("hex");
    expect(
      await resolveDashboardActorContext({
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

  it("does not trust incoming actor headers unless proxy header trust is enabled", async () => {
    expect(
      await resolveDashboardActorContext({
        env: {},
        headers: headers({
          "x-agentforge-authenticated-actor": "alex",
          "x-agentforge-authenticated-role": "platform_admin"
        }),
        nodeEnv: "production"
      })
    ).toBeUndefined();
  });

  it("uses a signed GitHub OAuth session when trusted proxy headers are absent", async () => {
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
      await resolveDashboardActorContext({
        env: {
          SESSION_SECRET: "test-session-secret",
          AGENTFORGE_GITHUB_ADMIN_LOGINS: "octocat",
          AGENTFORGE_DASHBOARD_ORGANIZATION: "org-a"
        },
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

  it("revokes a signed session when the GitHub access policy removes the login", async () => {
    const session = createDashboardSessionCookie(
      {
        login: "octocat",
        role: "platform_admin",
        organizationId: "org-a",
        provider: "github"
      },
      "test-session-secret"
    );

    await expect(
      resolveDashboardActorContext({
        env: {
          SESSION_SECRET: "test-session-secret",
          AGENTFORGE_GITHUB_ADMIN_LOGINS: "other-admin",
          AGENTFORGE_DASHBOARD_ORGANIZATION: "org-a"
        },
        headers: headers({ cookie: `${DASHBOARD_SESSION_COOKIE}=${session}` }),
        nodeEnv: "production"
      })
    ).resolves.toBeUndefined();
  });

  it("revokes a signed administrator session when its role changes", async () => {
    const session = createDashboardSessionCookie(
      {
        login: "octocat",
        role: "platform_admin",
        organizationId: "org-a",
        provider: "github"
      },
      "test-session-secret"
    );

    await expect(
      resolveDashboardActorContext({
        env: {
          SESSION_SECRET: "test-session-secret",
          AGENTFORGE_GITHUB_ALLOWED_LOGINS: "octocat",
          AGENTFORGE_DASHBOARD_ORGANIZATION: "org-a"
        },
        headers: headers({ cookie: `${DASHBOARD_SESSION_COOKIE}=${session}` }),
        nodeEnv: "production"
      })
    ).resolves.toBeUndefined();
  });

  it("revokes a signed session when the configured dashboard organization changes", async () => {
    const session = createDashboardSessionCookie(
      {
        login: "octocat",
        role: "platform_admin",
        organizationId: "org-a",
        provider: "github"
      },
      "test-session-secret"
    );

    await expect(
      resolveDashboardActorContext({
        env: {
          SESSION_SECRET: "test-session-secret",
          AGENTFORCE_GITHUB_ADMIN_LOGINS: "octocat",
          AGENTFORGE_DASHBOARD_ORGANIZATION: "org-b"
        },
        headers: headers({ cookie: `${DASHBOARD_SESSION_COOKIE}=${session}` }),
        nodeEnv: "production"
      })
    ).resolves.toBeUndefined();
  });

  it("rejects tampered GitHub OAuth session cookies", async () => {
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
      await resolveDashboardActorContext({
        env: { SESSION_SECRET: "test-session-secret" },
        headers: headers({
          cookie: `${DASHBOARD_SESSION_COOKIE}=${session}x`
        }),
        nodeEnv: "production"
      })
    ).toBeUndefined();
  });

  it("does not treat raw actor headers as trusted proxy identity", async () => {
    expect(
      await resolveDashboardActorContext({
        env: { AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS: "true" },
        headers: headers({
          "x-agentforge-actor": "alex",
          "x-agentforge-role": "platform_admin"
        }),
        nodeEnv: "production"
      })
    ).toBeUndefined();
  });

  it("requires explicit local actor fallback outside production", async () => {
    expect(
      await resolveDashboardActorContext({
        env: {
          AGENTFORGE_DASHBOARD_ACTOR: "dashboard-local",
          AGENTFORGE_DASHBOARD_ROLE: "engineering_manager",
          AGENTFORGE_DASHBOARD_ORGANIZATION: "org-dev"
        },
        nodeEnv: "development"
      })
    ).toBeUndefined();

    expect(
      await resolveDashboardActorContext({
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

  it("uses a non-admin local actor by default", async () => {
    expect(
      await resolveDashboardActorContext({
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

  it("allows an explicit local actor override only outside production", async () => {
    const env = {
      AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR: "true",
      AGENTFORGE_DASHBOARD_ACTOR: "dashboard-local",
      AGENTFORGE_DASHBOARD_ROLE: "platform_admin"
    };

    expect(await resolveDashboardActorContext({ env, nodeEnv: "development" })).toEqual({
      login: "dashboard-local",
      role: "platform_admin",
      organizationId: "org_local",
      source: "local_environment"
    });
    expect(await resolveDashboardActorContext({ env, nodeEnv: "production" })).toBeUndefined();
    expect(
      await resolveDashboardActorContext({ env: { ...env, NODE_ENV: "production" } })
    ).toBeUndefined();
  });

  it("rejects invalid actor and role values", async () => {
    expect(
      await resolveDashboardActorContext({
        env: {
          AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR: "true",
          AGENTFORGE_DASHBOARD_ACTOR: "bad\r\nactor",
          AGENTFORGE_DASHBOARD_ROLE: "owner"
        },
        nodeEnv: "development"
      })
    ).toBeUndefined();
  });

  it("rejects trusted header identities containing non-ASCII homoglyph substitutions", async () => {
    const env = {
      AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS: "true",
      AGENTFORGE_DASHBOARD_PROXY_SECRET: DASHBOARD_PROXY_SECRET
    };
    const homoglyphIdentities = [
      { login: "аlex", role: "platform_admin", organizationId: "org-a" },
      { login: "alex", role: "platform_admin", organizationId: "οrg-a" }
    ];

    for (const identity of homoglyphIdentities) {
      expect(
        await resolveDashboardActorContext({
          env,
          headers: headers(signedTrustedHeaders(identity)),
          nodeEnv: "production"
        })
      ).toBeUndefined();
    }
  });

  it("provides an actionable missing-auth message", () => {
    expect(dashboardActorErrorMessage()).toContain("Authenticated dashboard actor context");
  });
});
