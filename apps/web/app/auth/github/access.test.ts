import { describe, expect, it } from "vitest";
import { dashboardRoleForGitHubLogin } from "./access";

describe("GitHub OAuth access", () => {
  it("grants platform admin only to configured admin logins", () => {
    expect(
      dashboardRoleForGitHubLogin("OctoCat", {
        AGENTFORGE_GITHUB_ADMIN_LOGINS: "octocat"
      })
    ).toBe("platform_admin");
  });

  it("grants developer only to explicitly allowed non-admin logins", () => {
    expect(
      dashboardRoleForGitHubLogin("hubot", {
        AGENTFORGE_GITHUB_ALLOWED_LOGINS: "hubot"
      })
    ).toBe("developer");
  });

  it("rejects unknown GitHub logins by default", () => {
    expect(
      dashboardRoleForGitHubLogin("random-user", {
        AGENTFORGE_GITHUB_ADMIN_LOGINS: "octocat",
        AGENTFORGE_GITHUB_ALLOWED_LOGINS: "hubot"
      })
    ).toBeUndefined();
  });
});
