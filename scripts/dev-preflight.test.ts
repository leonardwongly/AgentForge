import { describe, expect, it } from "vitest";

import { checkLocalActorExposure } from "./dev-preflight.js";

describe("development preflight diagnostics", () => {
  it("does not echo URL credentials, queries, paths, or malformed input", () => {
    const result = checkLocalActorExposure({
      AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR: "true",
      APP_BASE_URL: "https://operator:super-secret@example.com/admin?token=secret-token#fragment",
      API_BASE_URL: "not a URL\nfor log injection"
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("APP_BASE_URL=https://example.com");
    expect(result.detail).toContain("API_BASE_URL=[invalid URL]");
    expect(result.detail).not.toContain("super-secret");
    expect(result.detail).not.toContain("secret-token");
    expect(result.detail).not.toContain("/admin");
    expect(result.detail).not.toContain("fragment");
    expect(result.detail).not.toContain("\nfor log injection");
  });
});
