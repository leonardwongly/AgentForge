import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

const testMocks = vi.hoisted(() => {
  class RedirectSignal extends Error {
    constructor(readonly location: string) {
      super(`redirect:${location}`);
      this.name = "RedirectSignal";
    }
  }

  return {
    RedirectSignal,
    redirect: vi.fn((location: string): never => {
      throw new RedirectSignal(location);
    }),
    revalidatePath: vi.fn(),
    resolveDashboardActor: vi.fn(),
    apiActorHeaders: vi.fn(() => ({
      "x-agentforge-actor": "test-actor",
      "x-agentforge-role": "platform_admin",
      "x-agentforge-organization": "org-test"
    }))
  };
});

vi.mock("next/navigation", () => ({ redirect: testMocks.redirect }));
vi.mock("next/cache", () => ({ revalidatePath: testMocks.revalidatePath }));
vi.mock("./settings/actor", () => ({
  resolveDashboardActor: testMocks.resolveDashboardActor
}));
vi.mock("./settings/api-actor-headers", () => ({
  apiActorHeaders: testMocks.apiActorHeaders
}));

import {
  DASHBOARD_SESSION_COOKIE,
  GITHUB_OAUTH_STATE_COOKIE,
  createDashboardSessionCookie,
  readDashboardSessionFromCookieHeader,
  readOauthStateCookie
} from "./auth/session";
import { dashboardRoleForGitHubLogin } from "./auth/github/access";
import { formatDate, loadDashboardData, loadRecord, loadSettings } from "./data";
import {
  createCompliancePackageExport,
  createRecordExport,
  createStandaloneRecord
} from "./records/actions";
import { recordHref } from "./security/navigation";
import { resolveDashboardActorContext } from "./settings/actor-context";

const actor = {
  login: "test-actor",
  role: "platform_admin",
  organizationId: "org-test",
  source: "session" as const
};
const sessionSecret = "adversarial-session-secret";
const fixedNow = Date.UTC(2026, 0, 1);

function jsonResponse(payload: unknown, status = 200, statusText?: string): Response {
  return new Response(JSON.stringify(payload), {
    status,
    ...(statusText ? { statusText } : {}),
    headers: { "content-type": "application/json" }
  });
}

function signPayload(payload: unknown, secret = sessionSecret): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function baseStandaloneForm(): FormData {
  const form = new FormData();
  form.set("returnTo", "/records");
  form.set("repositoryFullName", "acme/payments");
  form.set("pullRequestNumber", "42");
  form.set("title", "Add checkout guard");
  form.set("authorLogin", "octocat");
  form.set("baseBranch", "main");
  form.set("headBranch", "feature/checkout");
  form.set("headSha", "0123456789abcdef0123456789abcdef01234567");
  form.set("policyPackId", "fintech");
  form.set("filename_0", "src/checkout.ts");
  form.set("status_0", "modified");
  form.set("patch_0", "@@ -1 +1 @@");
  return form;
}

async function expectRedirect(work: () => Promise<unknown>, location: string): Promise<void> {
  await expect(work()).rejects.toMatchObject({ location });
}

describe("adversarial web input boundaries", () => {
  it("never throws when navigation receives a malformed UTF-16 identifier", () => {
    expect(recordHref("record-\ud800-id")).toBe("/records/record-%EF%BF%BD-id");
  });

  it("rejects duplicate or structurally invalid signed session cookies", () => {
    const valid = createDashboardSessionCookie(
      {
        login: "octocat",
        role: "platform_admin",
        organizationId: "org-test",
        provider: "github"
      },
      sessionSecret,
      fixedNow
    );
    expect(
      readDashboardSessionFromCookieHeader(
        `${DASHBOARD_SESSION_COOKIE}=${valid}; ${DASHBOARD_SESSION_COOKIE}=${valid}`,
        sessionSecret,
        fixedNow
      )
    ).toBeUndefined();

    expect(
      readDashboardSessionFromCookieHeader(
        `${DASHBOARD_SESSION_COOKIE}=${signPayload(null)}`,
        sessionSecret,
        fixedNow
      )
    ).toBeUndefined();
    expect(
      readDashboardSessionFromCookieHeader(
        `${DASHBOARD_SESSION_COOKIE}=${signPayload({
          login: "octocat",
          role: "platform_admin",
          organizationId: "org-test",
          provider: "other",
          issuedAt: Math.floor(fixedNow / 1000),
          expiresAt: Math.floor(fixedNow / 1000) + 3_600
        })}`,
        sessionSecret,
        fixedNow
      )
    ).toBeUndefined();
  });

  it("rejects signed session claims whose expiry precedes issuance", () => {
    const issuedAt = Math.floor(fixedNow / 1000);
    expect(
      readDashboardSessionFromCookieHeader(
        `${DASHBOARD_SESSION_COOKIE}=${signPayload({
          login: "octocat",
          role: "platform_admin",
          organizationId: "org-test",
          provider: "github",
          issuedAt,
          expiresAt: issuedAt - 1
        })}`,
        sessionSecret,
        fixedNow
      )
    ).toBeUndefined();
  });

  it("rejects oversized cookie headers before HMAC or JSON work", () => {
    expect(
      readDashboardSessionFromCookieHeader(
        `${DASHBOARD_SESSION_COOKIE}=${"x".repeat(20_000)}`,
        sessionSecret,
        fixedNow
      )
    ).toBeUndefined();
  });

  it("rejects non-string OAuth state claims", () => {
    const issuedAt = Math.floor(Date.now() / 1000);
    expect(
      readOauthStateCookie(
        `${GITHUB_OAUTH_STATE_COOKIE}=${signPayload({ state: 123, issuedAt })}`,
        sessionSecret
      )
    ).toBeUndefined();
  });

  it("fails closed for non-string GitHub login data at the authorization boundary", () => {
    expect(
      dashboardRoleForGitHubLogin(123 as unknown as string, {
        AGENTFORGE_GITHUB_ADMIN_LOGINS: "123"
      })
    ).toBeUndefined();
  });

  it("rejects malformed trusted-header types and signature fields", async () => {
    const values = new Map<string, unknown>([
      ["x-agentforge-authenticated-actor", 42],
      ["x-agentforge-authenticated-role", "platform_admin"],
      ["x-agentforge-authenticated-organization", "org-test"],
      ["x-agentforge-signature-timestamp", "1700000000junk"],
      ["x-agentforge-signature-nonce", "nonce"],
      ["x-agentforge-signature", "not-a-signature"]
    ]);
    expect(
      await resolveDashboardActorContext({
        env: {
          AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS: "true",
          AGENTFORGE_DASHBOARD_PROXY_SECRET: "dashboard-secret"
        },
        headers: { get: (name) => values.get(name) as string | undefined },
        nodeEnv: "production"
      })
    ).toBeUndefined();
  });

  it("normalizes malformed pagination input before constructing an API query", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ records: [] }))
    );

    await loadDashboardData({
      limit: -1,
      offset: Number.MAX_SAFE_INTEGER,
      sort: "not-a-sort" as never,
      repositoryId: ` ${"x".repeat(241)} `
    });

    const fetchMock = vi.mocked(fetch);
    const requestUrl = String(fetchMock.mock.calls[0]?.[0]);
    const url = new URL(requestUrl);
    expect(url.searchParams.get("limit")).toBe("1");
    expect(url.searchParams.get("offset")).toBe(String(Number.MAX_SAFE_INTEGER - 100));
    expect(url.searchParams.get("sort")).toBe("updated_desc");
    expect(url.searchParams.has("repositoryId")).toBe(false);
  });

  it("turns oversized API responses into a bounded unavailable state", async () => {
    const oversizedBody = new Uint8Array(2_000_001);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(oversizedBody);
                controller.close();
              }
            })
          )
      )
    );

    const data = await loadDashboardData();
    expect(data.source).toBe("unavailable");
    expect(data.message).toBe("Dashboard API unavailable. Start the API with pnpm dev:api.");
  });

  it("does not double-escape browser-preserved opaque route parameters", async () => {
    let requestedUrl = "";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const data = await loadRecord("%2F%2Fmissing%3Fquery%23fragment");
    expect(data.source).toBe("empty");
    expect(requestedUrl).toContain(
      "/api/pull-requests/%2F%2Fmissing%3Fquery%23fragment/change-control-record"
    );
    expect(requestedUrl).not.toContain("%252F");
  });

  it("does not expose arbitrary network errors or duplicate terminal punctuation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("failure", { status: 503, statusText: "Unavailable." }))
    );
    const dashboard = await loadDashboardData();
    expect(dashboard.message).toBe(
      "Dashboard API unavailable: 503 Unavailable. Start the API with pnpm dev:api."
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("database password=do-not-display");
      })
    );
    const settings = await loadSettings();
    expect(settings.message).toBe("Settings API unavailable.");
    expect(settings.message).not.toContain("do-not-display");
  });

  it("renders invalid timestamps as an explicit unknown state", () => {
    expect(formatDate("not-a-date")).toBe("unknown");
  });
});

describe("adversarial records server actions", () => {
  beforeEach(() => {
    testMocks.resolveDashboardActor.mockResolvedValue(actor);
    vi.unstubAllGlobals();
  });

  it.each(["", "0", "-1", "1e3", "1000001", "9007199254740992"])(
    "rejects malformed or out-of-range PR number %j before network mutation",
    async (pullRequestNumber) => {
      const form = baseStandaloneForm();
      if (pullRequestNumber) {
        form.set("pullRequestNumber", pullRequestNumber);
      } else {
        form.delete("pullRequestNumber");
      }
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expectRedirect(
        () => createStandaloneRecord(form),
        "/records?error=Enter%20a%20valid%20pull%20request%20number%20from%201%20to%201000000."
      );
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("rejects invalid changed-file status, gaps, and duplicate fields", async () => {
    const invalidStatus = baseStandaloneForm();
    invalidStatus.set("status_0", "deleted");
    await expectRedirect(
      () => createStandaloneRecord(invalidStatus),
      "/records?error=Changed%20file%20status%20is%20invalid."
    );

    const gap = baseStandaloneForm();
    gap.delete("filename_0");
    gap.set("filename_2", "src/other.ts");
    await expectRedirect(
      () => createStandaloneRecord(gap),
      "/records?error=Changed%20file%20rows%20must%20be%20contiguous."
    );

    const duplicate = baseStandaloneForm();
    duplicate.append("filename_0", "src/other.ts");
    await expectRedirect(
      () => createStandaloneRecord(duplicate),
      "/records?error=Changed%20file%20rows%20are%20invalid."
    );
  });

  it("caps changed-file count and patch bytes before making a request", async () => {
    const tooMany = baseStandaloneForm();
    for (let index = 1; index <= 200; index += 1) {
      tooMany.set(`filename_${index}`, `src/file-${index}.ts`);
      tooMany.set(`status_${index}`, "modified");
    }
    await expectRedirect(
      () => createStandaloneRecord(tooMany),
      "/records?error=A%20maximum%20of%20200%20changed%20files%20may%20be%20submitted."
    );

    const hugePatch = baseStandaloneForm();
    hugePatch.set("patch_0", "x".repeat(200_001));
    await expectRedirect(
      () => createStandaloneRecord(hugePatch),
      "/records?error=Each%20changed%20file%20patch%20must%20be%20200%20KB%20or%20smaller."
    );
  });

  it("rejects unsupported export formats and malformed export API payloads", async () => {
    const invalidFormat = new FormData();
    invalidFormat.set("returnTo", "/records");
    invalidFormat.set("format", "xml");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expectRedirect(
      () => createRecordExport(invalidFormat),
      "/records?error=Export%20format%20is%20invalid."
    );
    expect(fetchMock).not.toHaveBeenCalled();

    const malformedResponse = new FormData();
    malformedResponse.set("returnTo", "/records");
    malformedResponse.set("format", "json");
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await expectRedirect(
      () => createRecordExport(malformedResponse),
      "/records?error=record-export-failed"
    );
  });

  it("rejects malformed or reversed compliance export dates and bad limits", async () => {
    const malformedDate = new FormData();
    malformedDate.set("returnTo", "/records");
    malformedDate.set("startDate", "2026-99-99T00:00");
    malformedDate.set("maxRecords", "250");
    await expectRedirect(
      () => createCompliancePackageExport(malformedDate),
      "/records?error=Export%20dates%20must%20be%20valid%20UTC%20date-times."
    );

    const reversed = new FormData();
    reversed.set("returnTo", "/records");
    reversed.set("startDate", "2026-02-01T00:00");
    reversed.set("endDate", "2026-01-01T00:00");
    reversed.set("maxRecords", "250");
    await expectRedirect(
      () => createCompliancePackageExport(reversed),
      "/records?error=Start%20time%20must%20be%20before%20or%20equal%20to%20end%20time."
    );

    const invalidLimit = new FormData();
    invalidLimit.set("returnTo", "/records");
    invalidLimit.set("maxRecords", "501");
    await expectRedirect(
      () => createCompliancePackageExport(invalidLimit),
      "/records?error=Record%20limit%20must%20be%20a%20whole%20number%20from%201%20to%20500."
    );
  });

  it("keeps server-action redirects on the same-origin record route", async () => {
    const form = new FormData();
    form.set("returnTo", "/records/%0D%0ASet-Cookie%3A%20session=attacker");
    form.set("format", "json");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ id: "job-1", recordCount: 0 }))
    );

    await expectRedirect(
      () => createRecordExport(form),
      "/records?updated=records-export&exportId=job-1&recordCount=0"
    );
  });

  it("does not treat a successful status with an invalid standalone payload as success", async () => {
    const form = baseStandaloneForm();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ contentYaml: "agentforge:\n  mode: warn\n" }))
        .mockResolvedValueOnce(jsonResponse({ record: {} }))
    );

    await expectRedirect(
      () => createStandaloneRecord(form),
      "/records?error=Change%20Control%20Record%20could%20not%20be%20created."
    );
  });
});
