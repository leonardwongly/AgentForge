import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";

import {
  DASHBOARD_SESSION_MAX_AGE_SECONDS,
  DASHBOARD_SESSION_COOKIE,
  createDashboardSessionCookie,
  readDashboardSessionFromCookieHeader,
  readOauthStateCookie
} from "./session";

describe("dashboard session cookie validation", () => {
  const secret = "session-secret-for-tests";
  const input = {
    login: "octocat",
    role: "platform_admin",
    organizationId: "org-1",
    provider: "github" as const
  };

  it("rejects the cookie at the exact expiry second", () => {
    const now = Date.UTC(2026, 0, 1);
    const cookie = createDashboardSessionCookie(input, secret, now);
    expect(
      readDashboardSessionFromCookieHeader(
        `${DASHBOARD_SESSION_COOKIE}=${cookie}`,
        secret,
        now + (DASHBOARD_SESSION_MAX_AGE_SECONDS + 1) * 1000
      )
    ).toBeUndefined();
  });

  it("rejects a future-dated signed session", () => {
    const now = Date.UTC(2026, 0, 1);
    const cookie = createDashboardSessionCookie(input, secret, now + 5 * 60 * 1000);
    expect(
      readDashboardSessionFromCookieHeader(`${DASHBOARD_SESSION_COOKIE}=${cookie}`, secret, now)
    ).toBeUndefined();
  });

  it("rejects a signed session that exceeds the maximum lifetime", () => {
    const now = Date.UTC(2026, 0, 1);
    const cookie = createDashboardSessionCookie(input, secret, now);
    // The expiry field is signed, so this exercises the lifetime bound rather
    // than merely the cookie's normal expiry check.
    expect(
      readDashboardSessionFromCookieHeader(
        `${DASHBOARD_SESSION_COOKIE}=${cookie}`,
        secret,
        now + DASHBOARD_SESSION_MAX_AGE_SECONDS * 1000
      )
    ).toBeUndefined();
  });

  it("rejects malformed base64url payload encodings", () => {
    const validPayload = Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
    const validSignature = createHmac("sha256", secret).update(validPayload).digest("base64url");
    const malformedValues = [
      `eyJhIjox!.${createHmac("sha256", secret).update("eyJhIjox!").digest("base64url")}`,
      `eyJhIjox=1.${createHmac("sha256", secret).update("eyJhIjox=1").digest("base64url")}`,
      `.${createHmac("sha256", secret).update("").digest("base64url")}`,
      `${validPayload}. ${validSignature}`
    ];

    for (const value of malformedValues) {
      expect(
        readDashboardSessionFromCookieHeader(`${DASHBOARD_SESSION_COOKIE}=${value}`, secret)
      ).toBeUndefined();
    }
  });

  it("rejects signed values with trailing token segments", () => {
    const cookie = createDashboardSessionCookie(input, secret, Date.UTC(2026, 0, 1));
    expect(
      readDashboardSessionFromCookieHeader(
        `${DASHBOARD_SESSION_COOKIE}=${cookie}.trailing`,
        secret,
        Date.UTC(2026, 0, 1)
      )
    ).toBeUndefined();
  });

  it("rejects OAuth state issued too far in the future", () => {
    const state = "state-value";
    const issuedAt = Math.floor(Date.now() / 1000) + 61;
    const payload = Buffer.from(JSON.stringify({ state, issuedAt }), "utf8").toString("base64url");
    const signature = createHmac("sha256", secret).update(payload).digest("base64url");

    expect(
      readOauthStateCookie(`agentforge_github_oauth_state=${payload}.${signature}`, secret)
    ).toBeUndefined();
  });
});
