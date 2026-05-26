import { describe, expect, it } from "vitest";
import { dashboardRoleForGitHubLogin } from "./access";
import { githubOAuthRuntime } from "./runtime";

describe("GitHub OAuth runtime config", () => {
  const testPrivateKey = [
    ["-----BEGIN", "PRIVATE", "KEY-----"].join(" "),
    "test",
    ["-----END", "PRIVATE", "KEY-----"].join(" ")
  ].join("\n");

  it("loads OAuth credentials and authorization lists through shared config", () => {
    const runtime = githubOAuthRuntime({
      NODE_ENV: "development",
      GITHUB_CLIENT_ID: "Iv1.local",
      GITHUB_CLIENT_SECRET: "github-client-secret",
      SESSION_SECRET: "session-secret",
      AGENTFORGE_GITHUB_ADMIN_LOGINS: "octocat",
      AGENTFORGE_GITHUB_ALLOWED_LOGINS: "hubot",
      AGENTFORGE_DASHBOARD_ORGANIZATION: "org-dev"
    });

    expect(runtime).toMatchObject({
      clientId: "Iv1.local",
      clientSecret: "github-client-secret",
      sessionSecret: "session-secret",
      secureCookies: false,
      organizationId: "org-dev"
    });
    expect(dashboardRoleForGitHubLogin("octocat", runtime.accessEnv)).toBe("platform_admin");
    expect(dashboardRoleForGitHubLogin("hubot", runtime.accessEnv)).toBe("developer");
  });

  it("uses secure cookies in production and a local organization fallback", () => {
    const runtime = githubOAuthRuntime({
      NODE_ENV: "production",
      GITHUB_WEBHOOK_SECRET: "production-secret",
      GITHUB_APP_ID: "123456",
      GITHUB_APP_PRIVATE_KEY: testPrivateKey,
      GITHUB_CLIENT_ID: "Iv1.production",
      GITHUB_CLIENT_SECRET: "github-client-secret",
      SESSION_SECRET: "session-secret-32-characters-long",
      SOURCE_CODE_STORAGE: "false",
      REDACT_SECRETS: "true",
      ALLOW_UNSIGNED_GITHUB_WEBHOOKS: "false",
      AGENTFORGE_API_TRUST_PROXY_HEADERS: "true",
      AGENTFORGE_API_PROXY_SECRET: "test-proxy-secret-987654",
      AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS: "true",
      AGENTFORGE_AUTH_PROXY_STRIPS_HEADERS: "true"
    });

    expect(runtime.secureCookies).toBe(true);
    expect(runtime.organizationId).toBe("org_local");
  });
});
