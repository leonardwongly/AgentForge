import { createHmac, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { PullRequestInput } from "@agentforge/core";
import { hashPolicy } from "@agentforge/policy";
import { buildLlmAdvisoryPrompt } from "@agentforge/security";
import { resolveApiActor } from "../src/auth.js";
import { createApp, createInitialState } from "../src/index.js";

const rawGithubToken = `ghp_${"1".repeat(36)}`;
const testPrivateKey = [
  ["-----BEGIN", "PRIVATE", "KEY-----"].join(" "),
  "test",
  ["-----END", "PRIVATE", "KEY-----"].join(" ")
].join("\n");
const rawSource = "export const checkoutToken = process.env.CHECKOUT_TOKEN;";
const mutableEnvKeys = [
  "DATABASE_URL",
  "REDIS_URL",
  "NODE_ENV",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_SLUG",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "SESSION_SECRET",
  "SOURCE_CODE_STORAGE",
  "FULL_DIFF_RETENTION",
  "REDACT_SECRETS",
  "LLM_FEATURES",
  "ALLOW_UNSIGNED_GITHUB_WEBHOOKS",
  "AGENTFORGE_API_TRUST_PROXY_HEADERS",
  "AGENTFORGE_API_PROXY_SECRET",
  "AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS",
  "AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS",
  "AGENTFORGE_DASHBOARD_PROXY_SECRET",
  "AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR",
  "AGENTFORGE_AUTH_PROXY_STRIPS_HEADERS"
] as const;
const originalEnv = new Map<string, string | undefined>(
  mutableEnvKeys.map((key) => [key, process.env[key]])
);

const policyYaml = `
version: 1
policy_pack_id: security-test
policy_pack_version: 1.0.0
agentforge:
  mode: enforce
  apply_to:
    - all_pull_requests
overrides:
  allowed_roles:
    - platform_admin
  require_reason: true
  visible_in_pr: true
  audit: true
`;

function actorHeaders(
  actor: string,
  role: string,
  organizationId = "org_local"
): Record<string, string> {
  return {
    "x-agentforge-actor": actor,
    "x-agentforge-role": role,
    "x-agentforge-organization": organizationId
  };
}

function authenticatedActorHeaders(
  actor: string,
  role: string,
  organizationId = "org_local"
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID();
  const secret = process.env.AGENTFORGE_API_PROXY_SECRET || "test-proxy-secret-123456";
  const payload = [timestamp, nonce, actor, role, organizationId].join(":");
  const signature = createHmac("sha256", secret).update(payload).digest("hex");

  return {
    "x-agentforge-authenticated-actor": actor,
    "x-agentforge-authenticated-role": role,
    "x-agentforge-authenticated-organization": organizationId,
    "x-agentforge-signature-timestamp": timestamp,
    "x-agentforge-signature-nonce": nonce,
    "x-agentforge-signature": signature
  };
}

function setProductionProxyAuthEnv() {
  process.env.NODE_ENV = "production";
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
  process.env.GITHUB_WEBHOOK_SECRET = "production-secret-32-characters-long";
  process.env.GITHUB_APP_ID = "123456";
  process.env.GITHUB_APP_PRIVATE_KEY = testPrivateKey;
  process.env.GITHUB_APP_SLUG = "agentforge-test";
  process.env.GITHUB_CLIENT_ID = "Iv1.test";
  process.env.GITHUB_CLIENT_SECRET = "github-client-secret";
  process.env.SESSION_SECRET = "session-secret-32-characters-long";
  process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS = "true";
  process.env.AGENTFORGE_API_PROXY_SECRET = "test-proxy-secret-32-characters-long";
  process.env.AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS = "true";
  process.env.AGENTFORGE_DASHBOARD_PROXY_SECRET = "test-dashboard-proxy-secret-123456";
  process.env.AGENTFORGE_AUTH_PROXY_STRIPS_HEADERS = "true";
}

function requestFromHeaders(
  headers: Record<string, string>
): Parameters<typeof resolveApiActor>[0] {
  return { headers } as Parameters<typeof resolveApiActor>[0];
}

function sensitivePr(overrides: Partial<PullRequestInput> = {}): PullRequestInput {
  return {
    repositoryFullName: "acme/payments",
    pullRequestNumber: 44,
    title: "Rotate checkout token",
    authorLogin: "sam",
    baseBranch: "main",
    headBranch: "feature/checkout-token",
    headSha: "sha-security",
    body: "",
    changedFiles: [
      {
        filename: "src/billing/checkout.ts",
        status: "modified",
        patch: `@@\n+const token = "${rawGithubToken}";\n+${rawSource}`,
        previousContent: "export const before = true;",
        currentContent: rawSource
      }
    ],
    ...overrides
  };
}

async function createPreviewRecord(
  options: {
    state?: ReturnType<typeof createInitialState>;
    organizationId?: string;
    pr?: PullRequestInput;
  } = {}
) {
  const state = options.state ?? createInitialState();
  const app = createApp(state);
  const organizationId = options.organizationId ?? "org_local";
  const headers =
    process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS === "true"
      ? authenticatedActorHeaders("alex", "platform_admin", organizationId)
      : actorHeaders("alex", "platform_admin", organizationId);
  const response = await app.inject({
    method: "POST",
    url: "/api/policies/preview",
    payload: JSON.stringify({
      contentYaml: policyYaml,
      pr: options.pr ?? sensitivePr(),
      persist: true
    }),
    headers: { "content-type": "application/json", ...headers }
  });
  expect(response.statusCode).toBe(200);
  return { app, state, response };
}

afterEach(() => {
  for (const key of mutableEnvKeys) {
    const originalValue = originalEnv.get(key);
    if (originalValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalValue;
    }
  }
});

describe("security and audit hardening", () => {
  it("does not leak local database defaults into process env during in-memory test runs", async () => {
    process.env.NODE_ENV = "test";
    delete process.env.DATABASE_URL;

    const app = createApp(createInitialState(), { prisma: undefined });

    expect(process.env.DATABASE_URL).toBeUndefined();
    await app.close();
  });

  it("keeps unauthenticated policy preview read-only and rejects unauthenticated persistence", async () => {
    const state = createInitialState();
    const app = createApp(state);

    const preview = await app.inject({
      method: "POST",
      url: "/api/policies/preview",
      payload: JSON.stringify({ contentYaml: policyYaml, pr: sensitivePr() }),
      headers: { "content-type": "application/json" }
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().persisted).toBe(false);
    expect(state.records).toHaveLength(0);
    expect(state.auditEvents).toHaveLength(0);

    const rejected = await app.inject({
      method: "POST",
      url: "/api/policies/preview",
      payload: JSON.stringify({ contentYaml: policyYaml, pr: sensitivePr(), persist: true }),
      headers: { "content-type": "application/json" }
    });
    expect(rejected.statusCode).toBe(401);
    expect(state.records).toHaveLength(0);
    await app.close();
  });

  it("requires registered repositories before production policy preview persistence", async () => {
    setProductionProxyAuthEnv();
    const prisma = {
      repository: {
        findFirst: async () => undefined
      }
    };
    const app = createApp(createInitialState(), { prisma: prisma as never });

    const response = await app.inject({
      method: "POST",
      url: "/api/policies/preview",
      payload: JSON.stringify({ contentYaml: policyYaml, pr: sensitivePr(), persist: true }),
      headers: {
        "content-type": "application/json",
        ...authenticatedActorHeaders("alex", "platform_admin")
      }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: "Repository must be registered before persisted policy preview"
    });
    await app.close();

    const inMemoryApp = createApp(createInitialState());
    const inMemoryResponse = await inMemoryApp.inject({
      method: "POST",
      url: "/api/policies/preview",
      payload: JSON.stringify({ contentYaml: policyYaml, pr: sensitivePr(), persist: true }),
      headers: {
        "content-type": "application/json",
        ...authenticatedActorHeaders("alex", "platform_admin")
      }
    });

    expect(inMemoryResponse.statusCode).toBe(404);
    expect(inMemoryResponse.json()).toEqual({
      error: "Repository must be registered before persisted policy preview"
    });
    await inMemoryApp.close();
  });

  it("requires actor and tenant scope before policy preview reads stored repository state", async () => {
    const state = createInitialState();
    const { app } = await createPreviewRecord({ state, organizationId: "org-a" });
    const repositoryId = state.records[0]!.repositoryId;

    const savedPolicy = await app.inject({
      method: "PUT",
      url: `/api/repositories/${repositoryId}/policy`,
      payload: JSON.stringify({ contentYaml: policyYaml }),
      headers: {
        "content-type": "application/json",
        ...actorHeaders("alex", "platform_admin", "org-a")
      }
    });
    expect(savedPolicy.statusCode).toBe(200);

    const modeOverride = await app.inject({
      method: "PATCH",
      url: `/api/repositories/${repositoryId}/settings`,
      payload: JSON.stringify({ mode: "observe" }),
      headers: {
        "content-type": "application/json",
        ...actorHeaders("alex", "platform_admin", "org-a")
      }
    });
    expect(modeOverride.statusCode).toBe(200);

    const unauthenticatedStoredPreview = await app.inject({
      method: "POST",
      url: "/api/policies/preview",
      payload: JSON.stringify({ pr: sensitivePr() }),
      headers: { "content-type": "application/json" }
    });
    expect(unauthenticatedStoredPreview.statusCode).toBe(401);

    const unauthenticatedFixturePreview = await app.inject({
      method: "POST",
      url: "/api/policies/preview",
      payload: JSON.stringify({ contentYaml: policyYaml, pr: sensitivePr() }),
      headers: { "content-type": "application/json" }
    });
    expect(unauthenticatedFixturePreview.statusCode).toBe(200);
    expect(unauthenticatedFixturePreview.json().result.mode).toBe("enforce");
    expect(unauthenticatedFixturePreview.json().persisted).toBe(false);

    const crossTenantFixturePreview = await app.inject({
      method: "POST",
      url: "/api/policies/preview",
      payload: JSON.stringify({ contentYaml: policyYaml, pr: sensitivePr() }),
      headers: {
        "content-type": "application/json",
        ...actorHeaders("brenda", "auditor", "org-b")
      }
    });
    expect(crossTenantFixturePreview.statusCode).toBe(403);

    const crossTenantStoredPreview = await app.inject({
      method: "POST",
      url: "/api/policies/preview",
      payload: JSON.stringify({ pr: sensitivePr() }),
      headers: {
        "content-type": "application/json",
        ...actorHeaders("brenda", "auditor", "org-b")
      }
    });
    expect(crossTenantStoredPreview.statusCode).toBe(403);

    const storedPreview = await app.inject({
      method: "POST",
      url: "/api/policies/preview",
      payload: JSON.stringify({ pr: sensitivePr() }),
      headers: {
        "content-type": "application/json",
        ...actorHeaders("auditor-a", "auditor", "org-a")
      }
    });
    expect(storedPreview.statusCode).toBe(200);
    expect(storedPreview.json().result.mode).toBe("observe");
    expect(storedPreview.json().persisted).toBe(false);

    const previewOverrideYaml = policyYaml.replace("mode: enforce", "mode: observe");
    const authenticatedFixturePreview = await app.inject({
      method: "POST",
      url: "/api/policies/preview",
      payload: JSON.stringify({ contentYaml: previewOverrideYaml, pr: sensitivePr() }),
      headers: {
        "content-type": "application/json",
        ...actorHeaders("auditor-a", "auditor", "org-a")
      }
    });
    expect(authenticatedFixturePreview.statusCode).toBe(200);
    expect(authenticatedFixturePreview.json().result.mode).toBe("observe");
    expect(authenticatedFixturePreview.json().persisted).toBe(false);
    expect(state.auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "policy_previewed",
          organizationId: "org-a",
          repositoryId,
          actor: "auditor-a",
          actorRole: "auditor",
          targetId: hashPolicy(previewOverrideYaml),
          metadataJson: expect.objectContaining({
            repositoryFullName: "acme/payments",
            previewPersisted: false,
            mode: "observe"
          })
        })
      ])
    );

    await app.close();
  });

  it("rejects invalid GitHub webhook signatures", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "secret";
    const app = createApp(createInitialState());
    const body = JSON.stringify({ action: "opened" });
    const invalid = `sha256=${createHmac("sha256", "wrong").update(body).digest("hex")}`;

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-security",
        "x-github-event": "pull_request",
        "x-hub-signature-256": invalid
      }
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("stores metadata only by default and redacts raw secrets in records and dashboard output", async () => {
    const { app, state, response } = await createPreviewRecord();
    const serializedState = JSON.stringify(state.records);
    const serializedResponse = response.body;

    for (const artifact of [serializedState, serializedResponse]) {
      expect(artifact).not.toContain(rawGithubToken);
      expect(artifact).not.toContain(rawSource);
      expect(artifact).not.toContain("currentContent");
      expect(artifact).not.toContain("previousContent");
      expect(artifact).not.toContain("patch");
    }

    const dashboard = await app.inject({
      method: "GET",
      url: "/api/dashboard/blocked-prs",
      headers: actorHeaders("alex", "platform_admin")
    });
    expect(dashboard.body).not.toContain(rawGithubToken);
    expect(dashboard.body).not.toContain(rawSource);
    const records = await app.inject({
      method: "GET",
      url: "/api/dashboard/records",
      headers: actorHeaders("alex", "platform_admin")
    });
    expect(records.statusCode).toBe(200);
    expect(records.body).toContain("records");
    expect(records.body).not.toContain(rawGithubToken);
    expect(records.body).not.toContain(rawSource);
    await app.close();
  });

  it("retains only redacted patch data when full diff retention is explicitly enabled", async () => {
    process.env.FULL_DIFF_RETENTION = "7d";
    const { app, state } = await createPreviewRecord();
    const serializedState = JSON.stringify(state.records);

    expect(serializedState).toContain("patch");
    expect(serializedState).toContain("[REDACTED]");
    expect(serializedState).not.toContain(rawGithubToken);
    expect(serializedState).not.toContain("currentContent");
    await app.close();
  });

  it("does not generate LLM prompts when LLM features are disabled", () => {
    const prompt = buildLlmAdvisoryPrompt({
      llmFeatures: false,
      findings: [
        {
          id: "fact_secret",
          type: "secret_like_value_detected",
          evidence: `token=${rawGithubToken}`,
          confidence: "observed"
        }
      ],
      requiredEvidence: [{ kind: "security_note", status: "missing" }],
      requiredReviewers: [{ reviewer: "security-team", tier: "required", approved: false }]
    });

    expect(prompt.promptGenerated).toBe(false);
    expect("prompt" in prompt).toBe(false);
  });

  it("requires server-resolved actor headers for manual evidence", async () => {
    const { app, state } = await createPreviewRecord();
    const record = state.records[0]!;
    const evidence = record.requiredEvidence[0]!;

    const response = await app.inject({
      method: "POST",
      url: `/api/pull-requests/${record.id}/evidence`,
      payload: JSON.stringify({
        actor: "spoofed-user",
        evidenceId: evidence.id,
        content: "Security note: provided without authenticated actor headers."
      }),
      headers: { "content-type": "application/json" }
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects raw local actor headers in production even when they spoof a valid actor", async () => {
    const state = createInitialState();
    const seeded = await createPreviewRecord({ state });
    await seeded.app.close();

    setProductionProxyAuthEnv();
    const app = createApp(state);
    const record = state.records[0]!;
    const evidence = record.requiredEvidence[0]!;

    const rejected = await app.inject({
      method: "POST",
      url: `/api/pull-requests/${record.id}/evidence`,
      payload: JSON.stringify({
        evidenceId: evidence.id,
        content: "Security note: raw local actor headers are not production auth context."
      }),
      headers: { "content-type": "application/json", ...actorHeaders("sam", "developer") }
    });
    expect(rejected.statusCode).toBe(401);
    await app.close();
  });

  it("requires an explicit flag before raw local actor headers resolve outside tests", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS;

    expect(
      await resolveApiActor(requestFromHeaders(actorHeaders("sam", "developer", "org-dev")))
    ).toBeUndefined();

    process.env.AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS = "true";
    expect(
      await resolveApiActor(requestFromHeaders(actorHeaders("sam", "developer", "org-dev")))
    ).toEqual({ login: "sam", role: "developer", organizationId: "org-dev" });
  });

  it("accepts authenticated proxy actor headers in production when proxy trust is enabled", async () => {
    const state = createInitialState();
    const seeded = await createPreviewRecord({ state });
    await seeded.app.close();

    setProductionProxyAuthEnv();
    const app = createApp(state);
    const record = state.records[0]!;
    const evidence = record.requiredEvidence[0]!;

    const accepted = await app.inject({
      method: "POST",
      url: `/api/pull-requests/${record.id}/evidence`,
      payload: JSON.stringify({
        evidenceId: evidence.id,
        content: "Security note: authenticated proxy header context accepted."
      }),
      headers: {
        "content-type": "application/json",
        ...authenticatedActorHeaders("sam", "developer")
      }
    });
    expect(accepted.statusCode).toBe(200);
    expect(state.records[0]!.requiredEvidence[0]!.providedBy).toBe("sam");
    await app.close();
  });

  it("rejects trusted proxy actor headers that omit organization identity", async () => {
    setProductionProxyAuthEnv();
    const app = createApp(createInitialState());

    const response = await app.inject({
      method: "POST",
      url: "/api/exports/change-control-records",
      payload: JSON.stringify({ format: "json" }),
      headers: {
        "content-type": "application/json",
        "x-agentforge-authenticated-actor": "alex",
        "x-agentforge-authenticated-role": "platform_admin"
      }
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects unauthorized overrides and records authorized override audit details", async () => {
    const { app, state } = await createPreviewRecord();
    const record = state.records[0]!;

    const activePolicy = await app.inject({
      method: "PUT",
      url: `/api/repositories/${record.repositoryId}/policy`,
      payload: JSON.stringify({ contentYaml: policyYaml }),
      headers: { "content-type": "application/json", ...actorHeaders("alex", "platform_admin") }
    });
    expect(activePolicy.statusCode).toBe(200);

    const unauthorized = await app.inject({
      method: "POST",
      url: `/api/pull-requests/${record.id}/override`,
      payload: JSON.stringify({
        actorRole: "platform_admin",
        reason: "Need to merge",
        scope: "pr"
      }),
      headers: { "content-type": "application/json", ...actorHeaders("sam", "developer") }
    });
    expect(unauthorized.statusCode).toBe(403);

    const unauthorizedByActivePolicy = await app.inject({
      method: "POST",
      url: `/api/pull-requests/${record.id}/override`,
      payload: JSON.stringify({
        reason: "Engineering manager cannot override this repository policy.",
        scope: "pr"
      }),
      headers: {
        "content-type": "application/json",
        ...actorHeaders("morgan", "engineering_manager")
      }
    });
    expect(unauthorizedByActivePolicy.statusCode).toBe(403);
    expect(unauthorizedByActivePolicy.json().error).toContain("not authorized");

    const authorized = await app.inject({
      method: "POST",
      url: `/api/pull-requests/${record.id}/override`,
      payload: JSON.stringify({
        actorRole: "developer",
        reason: "Release manager accepted the documented rollback window.",
        scope: "pr"
      }),
      headers: { "content-type": "application/json", ...actorHeaders("alex", "platform_admin") }
    });
    expect(authorized.statusCode).toBe(201);
    expect(authorized.json().override).toMatchObject({
      actor: "alex",
      actorRole: "platform_admin",
      scope: "pr",
      policyVersion: "security-test@1.0.0"
    });
    expect(state.auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "override_created",
          actor: "alex",
          metadataJson: expect.objectContaining({
            actorRole: "platform_admin",
            policyVersion: "security-test@1.0.0"
          })
        })
      ])
    );
    await app.close();
  });

  it("recomputes the Merge Guard result after evidence and reviewer approvals clear requirements", async () => {
    const { app, state } = await createPreviewRecord();
    const record = state.records[0]!;
    const reviewer = record.requiredReviewers[0]!;

    expect(record.checkStatus).toBe("block");

    for (const evidence of record.requiredEvidence) {
      const provided = await app.inject({
        method: "POST",
        url: `/api/pull-requests/${record.id}/evidence`,
        payload: JSON.stringify({
          evidenceId: evidence.id,
          content: "Security note: secret-like value was removed and the old token was revoked."
        }),
        headers: { "content-type": "application/json", ...actorHeaders("sam", "developer") }
      });
      expect(provided.statusCode).toBe(200);

      const approvedEvidence = await app.inject({
        method: "PATCH",
        url: `/api/evidence/${evidence.id}/approve`,
        payload: JSON.stringify({}),
        headers: { "content-type": "application/json", ...actorHeaders("alex", "platform_admin") }
      });
      expect(approvedEvidence.statusCode).toBe(200);
    }
    expect(state.records[0]!.checkStatus).toBe("block");

    const approvedReviewer = await app.inject({
      method: "PATCH",
      url: `/api/reviewers/${reviewer.id}/approve`,
      payload: JSON.stringify({}),
      headers: {
        "content-type": "application/json",
        ...actorHeaders("security-team", "security_reviewer")
      }
    });
    expect(approvedReviewer.statusCode).toBe(200);

    const updated = await app.inject({
      method: "GET",
      url: `/api/pull-requests/${record.id}/change-control-record`,
      headers: actorHeaders("alex", "platform_admin")
    });
    expect(updated.json().record).toMatchObject({
      checkStatus: "pass",
      lifecycle: "passed",
      decision: expect.objectContaining({ status: "passed" })
    });
    expect(state.auditEvents.map((event) => event.action)).toEqual(
      expect.arrayContaining(["evidence_provided", "evidence_approved", "record_reevaluated"])
    );
    await app.close();
  });

  it("validates manual evidence ids, payload size, and approval transitions", async () => {
    const { app, state } = await createPreviewRecord();
    const record = state.records[0]!;
    const evidence = record.requiredEvidence[0]!;

    const unknownRequirement = await app.inject({
      method: "POST",
      url: `/api/pull-requests/${record.id}/evidence`,
      payload: JSON.stringify({
        evidenceId: "evidence:unknown:security_note",
        content: "Security note: unknown evidence id should not update any record."
      }),
      headers: { "content-type": "application/json", ...actorHeaders("sam", "developer") }
    });
    expect(unknownRequirement.statusCode).toBe(404);

    state.records[0]!.requiredEvidence.push({
      ...evidence,
      id: `${evidence.id}:duplicate`
    });
    const ambiguousKind = await app.inject({
      method: "POST",
      url: `/api/pull-requests/${record.id}/evidence`,
      payload: JSON.stringify({
        kind: evidence.kind,
        content: "Security note: kind-only submission is ambiguous for duplicate requirements."
      }),
      headers: { "content-type": "application/json", ...actorHeaders("sam", "developer") }
    });
    expect(ambiguousKind.statusCode).toBe(409);

    const oversized = await app.inject({
      method: "POST",
      url: `/api/pull-requests/${record.id}/evidence`,
      payload: JSON.stringify({
        evidenceId: evidence.id,
        content: "x".repeat(4_001)
      }),
      headers: { "content-type": "application/json", ...actorHeaders("sam", "developer") }
    });
    expect(oversized.statusCode).toBe(400);

    const approveBeforeSubmit = await app.inject({
      method: "PATCH",
      url: `/api/evidence/${evidence.id}/approve`,
      payload: JSON.stringify({}),
      headers: { "content-type": "application/json", ...actorHeaders("alex", "platform_admin") }
    });
    expect(approveBeforeSubmit.statusCode).toBe(409);

    const developerApprove = await app.inject({
      method: "PATCH",
      url: `/api/evidence/${evidence.id}/approve`,
      payload: JSON.stringify({}),
      headers: { "content-type": "application/json", ...actorHeaders("sam", "developer") }
    });
    expect(developerApprove.statusCode).toBe(403);
    await app.close();
  });

  it("supports evidence rejection and corrected resubmission without clearing the block", async () => {
    const { app, state } = await createPreviewRecord();
    const record = state.records[0]!;
    const evidence = record.requiredEvidence[0]!;

    const provided = await app.inject({
      method: "POST",
      url: `/api/pull-requests/${record.id}/evidence`,
      payload: JSON.stringify({
        evidenceId: evidence.id,
        content: "Security note: token appears in logs but rotation proof is missing."
      }),
      headers: { "content-type": "application/json", ...actorHeaders("sam", "developer") }
    });
    expect(provided.statusCode).toBe(200);

    const rejected = await app.inject({
      method: "PATCH",
      url: `/api/evidence/${evidence.id}/reject`,
      payload: JSON.stringify({ reason: "Rotation proof link is missing from the evidence." }),
      headers: { "content-type": "application/json", ...actorHeaders("alex", "platform_admin") }
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().evidence).toMatchObject({
      id: evidence.id,
      status: "rejected"
    });
    expect(state.records[0]!).toMatchObject({
      checkStatus: "block",
      lifecycle: "blocked"
    });

    const corrected = await app.inject({
      method: "POST",
      url: `/api/pull-requests/${record.id}/evidence`,
      payload: JSON.stringify({
        evidenceId: evidence.id,
        content: "Security note: token was revoked and rotation evidence is linked in SEC-123."
      }),
      headers: { "content-type": "application/json", ...actorHeaders("sam", "developer") }
    });
    expect(corrected.statusCode).toBe(200);
    expect(corrected.json().evidence).toMatchObject({
      id: evidence.id,
      status: "provided"
    });
    expect(corrected.json().evidence.approvedBy).toBeUndefined();
    expect(state.auditEvents.map((event) => event.action)).toEqual(
      expect.arrayContaining(["evidence_rejected", "record_reevaluated"])
    );
    await app.close();
  });

  it("scopes evidence and reviewer approvals to the selected record id", async () => {
    const state = createInitialState();
    const app = createApp(state);
    const firstPreview = await app.inject({
      method: "POST",
      url: "/api/policies/preview",
      payload: JSON.stringify({ contentYaml: policyYaml, pr: sensitivePr(), persist: true }),
      headers: { "content-type": "application/json", ...actorHeaders("alex", "platform_admin") }
    });
    expect(firstPreview.statusCode).toBe(200);

    const secondPr = sensitivePr();
    secondPr.pullRequestNumber = 45;
    secondPr.headSha = "sha-security-2";
    const secondPreview = await app.inject({
      method: "POST",
      url: "/api/policies/preview",
      payload: JSON.stringify({ contentYaml: policyYaml, pr: secondPr, persist: true }),
      headers: { "content-type": "application/json", ...actorHeaders("alex", "platform_admin") }
    });
    expect(secondPreview.statusCode).toBe(200);

    const firstRecord = firstPreview.json().record;
    const secondRecord = secondPreview.json().record;
    const sharedEvidenceId = secondRecord.requiredEvidence[0].id;
    const sharedReviewerId = secondRecord.requiredReviewers[0].id;
    expect(firstRecord.requiredEvidence.map((item: { id: string }) => item.id)).toContain(
      sharedEvidenceId
    );
    expect(firstRecord.requiredReviewers.map((item: { id: string }) => item.id)).toContain(
      sharedReviewerId
    );

    await app.inject({
      method: "POST",
      url: `/api/pull-requests/${secondRecord.id}/evidence`,
      payload: JSON.stringify({
        evidenceId: sharedEvidenceId,
        content: "Security note: this evidence belongs only to the second record."
      }),
      headers: { "content-type": "application/json", ...actorHeaders("sam", "developer") }
    });
    const approvedEvidence = await app.inject({
      method: "PATCH",
      url: `/api/evidence/${sharedEvidenceId}/approve`,
      payload: JSON.stringify({ recordId: secondRecord.id }),
      headers: { "content-type": "application/json", ...actorHeaders("alex", "platform_admin") }
    });
    expect(approvedEvidence.statusCode).toBe(200);

    const approvedReviewer = await app.inject({
      method: "PATCH",
      url: `/api/reviewers/${sharedReviewerId}/approve`,
      payload: JSON.stringify({ recordId: secondRecord.id }),
      headers: { "content-type": "application/json", ...actorHeaders("alex", "platform_admin") }
    });
    expect(approvedReviewer.statusCode).toBe(200);

    const currentFirst = state.records.find((record) => record.id === firstRecord.id)!;
    const currentSecond = state.records.find((record) => record.id === secondRecord.id)!;
    expect(currentFirst.requiredEvidence.find((item) => item.id === sharedEvidenceId)?.status).toBe(
      "missing"
    );
    expect(
      currentFirst.requiredReviewers.find((item) => item.id === sharedReviewerId)?.approved
    ).toBe(false);
    expect(
      currentSecond.requiredEvidence.find((item) => item.id === sharedEvidenceId)?.status
    ).toBe("approved");
    expect(
      currentSecond.requiredReviewers.find((item) => item.id === sharedReviewerId)?.approved
    ).toBe(true);
    await app.close();
  });

  it("exports Change Control Records as JSON and CSV without source code", async () => {
    const { app } = await createPreviewRecord();

    for (const format of ["json", "csv"] as const) {
      const created = await app.inject({
        method: "POST",
        url: "/api/exports/change-control-records",
        payload: JSON.stringify({ format }),
        headers: { "content-type": "application/json", ...actorHeaders("alex", "platform_admin") }
      });
      const job = await app.inject({
        method: "GET",
        url: `/api/exports/${created.json().id}`,
        headers: actorHeaders("alex", "platform_admin")
      });

      expect(job.statusCode).toBe(200);
      expect(job.body).toContain("security-test@1.0.0");
      expect(job.body).toContain(format === "csv" ? "auditEventsJson" : "auditEvents");
      expect(job.body).toContain("check_published");
      expect(job.body).toContain("record_exported");
      expect(job.body).not.toContain(rawGithubToken);
      expect(job.body).not.toContain(rawSource);
      expect(job.body).not.toContain("currentContent");
      expect(job.body).not.toContain("previousContent");
    }

    await app.close();
  });

  it("exports auditor-scoped compliance evidence packages", async () => {
    const { app } = await createPreviewRecord();

    const created = await app.inject({
      method: "POST",
      url: "/api/exports/compliance-evidence-package",
      payload: JSON.stringify({ maxRecords: 250, policyPackId: "security-test" }),
      headers: { "content-type": "application/json", ...actorHeaders("auditor-a", "auditor") }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      recordCount: 1,
      packageType: "compliance_evidence",
      truncated: false
    });

    const job = await app.inject({
      method: "GET",
      url: `/api/exports/${created.json().id}`,
      headers: actorHeaders("auditor-a", "auditor")
    });
    expect(job.statusCode).toBe(200);
    const packageContent = JSON.parse(job.json().content) as {
      packageType: string;
      manifest: { recordCount: number };
    };
    expect(packageContent).toMatchObject({
      packageType: "compliance_evidence",
      manifest: { recordCount: 1 }
    });
    expect(job.body).toContain("SOC2_CC6_ACCESS_CONTROL");
    expect(job.body).toContain("redactionReport");
    expect(job.body).toContain("record_exported");
    expect(job.body).not.toContain(rawGithubToken);
    expect(job.body).not.toContain(rawSource);
    expect(job.body).not.toContain("currentContent");
    expect(job.body).not.toContain("previousContent");

    const wrongRole = await app.inject({
      method: "POST",
      url: "/api/exports/compliance-evidence-package",
      payload: JSON.stringify({ maxRecords: 250 }),
      headers: {
        "content-type": "application/json",
        ...actorHeaders("morgan", "engineering_manager")
      }
    });
    expect(wrongRole.statusCode).toBe(403);

    const invalidRange = await app.inject({
      method: "POST",
      url: "/api/exports/compliance-evidence-package",
      payload: JSON.stringify({
        startDate: "2026-05-13T00:00:00.000Z",
        endDate: "2026-05-12T00:00:00.000Z"
      }),
      headers: { "content-type": "application/json", ...actorHeaders("auditor-a", "auditor") }
    });
    expect(invalidRange.statusCode).toBe(400);

    await app.close();
  });

  it("enforces organization isolation for evidence, exports, and audit access", async () => {
    const state = createInitialState();
    const { app } = await createPreviewRecord({ state, organizationId: "org-a" });
    await app.inject({
      method: "POST",
      url: "/api/policies/preview",
      payload: JSON.stringify({
        contentYaml: policyYaml,
        pr: sensitivePr({
          repositoryFullName: "beta/payments",
          pullRequestNumber: 45,
          headSha: "sha-security-b"
        }),
        persist: true
      }),
      headers: {
        "content-type": "application/json",
        ...actorHeaders("brenda", "platform_admin", "org-b")
      }
    });
    const orgBRecord = state.records.find((record) => record.organizationId === "org-b")!;
    const orgBEvidence = orgBRecord.requiredEvidence[0]!;

    const crossTenantEvidence = await app.inject({
      method: "POST",
      url: `/api/pull-requests/${orgBRecord.id}/evidence`,
      payload: JSON.stringify({
        evidenceId: orgBEvidence.id,
        content: "Security note: tenant A must not write tenant B evidence."
      }),
      headers: { "content-type": "application/json", ...actorHeaders("alex", "developer", "org-a") }
    });
    expect(crossTenantEvidence.statusCode).toBe(403);

    const orgAExport = await app.inject({
      method: "POST",
      url: "/api/exports/change-control-records",
      payload: JSON.stringify({ format: "json" }),
      headers: {
        "content-type": "application/json",
        ...actorHeaders("auditor-a", "auditor", "org-a")
      }
    });
    expect(orgAExport.statusCode).toBe(201);
    expect(orgAExport.json()).toMatchObject({ recordCount: 1 });

    const crossTenantExportRead = await app.inject({
      method: "GET",
      url: `/api/exports/${orgAExport.json().id}`,
      headers: actorHeaders("auditor-b", "auditor", "org-b")
    });
    expect(crossTenantExportRead.statusCode).toBe(403);

    const orgAAudit = await app.inject({
      method: "GET",
      url: "/api/audit-events",
      headers: actorHeaders("auditor-a", "auditor", "org-a")
    });
    expect(orgAAudit.statusCode).toBe(200);
    expect(
      orgAAudit
        .json()
        .auditEvents.every((event: { organizationId: string }) => event.organizationId === "org-a")
    ).toBe(true);

    await app.close();
  });

  it("requires actor context and tenant scope for read APIs", async () => {
    const state = createInitialState();
    const { app } = await createPreviewRecord({ state, organizationId: "org-a" });
    await app.inject({
      method: "POST",
      url: "/api/policies/preview",
      payload: JSON.stringify({
        contentYaml: policyYaml,
        pr: sensitivePr({
          repositoryFullName: "beta/payments",
          pullRequestNumber: 45,
          headSha: "sha-security-b"
        }),
        persist: true
      }),
      headers: {
        "content-type": "application/json",
        ...actorHeaders("brenda", "platform_admin", "org-b")
      }
    });
    const orgARecord = state.records.find((record) => record.organizationId === "org-a")!;
    const orgBRecord = state.records.find((record) => record.organizationId === "org-b")!;
    state.queuedEvaluations.push({
      id: "delivery-org-b",
      deliveryId: "delivery-org-b",
      queuedAt: new Date().toISOString(),
      envelope: {
        deliveryId: "delivery-org-b",
        event: "pull_request",
        action: "opened",
        repository: {
          id: 2,
          fullName: orgBRecord.repositoryFullName,
          owner: "beta",
          name: "payments",
          defaultBranch: "main"
        },
        pullRequest: {
          id: 45,
          number: orgBRecord.pullRequestNumber,
          title: "Tenant B PR",
          authorLogin: "brenda",
          baseBranch: "main",
          headBranch: "feature/b",
          headSha: orgBRecord.headSha,
          body: "",
          state: "open",
          merged: false
        },
        receivedAt: "2026-05-22T00:00:00.000Z"
      }
    });

    const unauthenticatedDashboard = await app.inject({
      method: "GET",
      url: "/api/dashboard/records"
    });
    expect(unauthenticatedDashboard.statusCode).toBe(401);
    expect(unauthenticatedDashboard.json()).toMatchObject({
      code: "api_actor_required",
      error: "Authenticated actor headers are required for this governance action.",
      requestId: expect.any(String)
    });
    expect(unauthenticatedDashboard.body).not.toContain("x-agentforge");

    const orgARecords = await app.inject({
      method: "GET",
      url: "/api/dashboard/records",
      headers: actorHeaders("auditor-a", "auditor", "org-a")
    });
    expect(orgARecords.statusCode).toBe(200);
    expect(orgARecords.json().records).toHaveLength(1);
    expect(orgARecords.body).toContain(orgARecord.id);
    expect(orgARecords.body).not.toContain(orgBRecord.id);

    const crossTenantRecordRead = await app.inject({
      method: "GET",
      url: `/api/pull-requests/${orgBRecord.id}/change-control-record`,
      headers: actorHeaders("auditor-a", "auditor", "org-a")
    });
    expect(crossTenantRecordRead.statusCode).toBe(403);

    const orgBCheckOutput = await app.inject({
      method: "GET",
      url: `/api/check-output/${orgBRecord.id}`,
      headers: actorHeaders("auditor-b", "auditor", "org-b")
    });
    expect(orgBCheckOutput.statusCode).toBe(200);

    const crossTenantReplay = await app.inject({
      method: "POST",
      url: "/api/admin/queue/replay",
      payload: JSON.stringify({ deliveryId: "delivery-org-b" }),
      headers: {
        "content-type": "application/json",
        ...actorHeaders("ops-a", "platform_admin", "org-a")
      }
    });
    expect(crossTenantReplay.statusCode).toBe(404);

    await app.close();
  });

  it("requires authorized actors for policy, settings, exports, and audit access", async () => {
    const { app, state } = await createPreviewRecord();
    const repositoryId = state.records[0]!.repositoryId;

    const policyWithoutActor = await app.inject({
      method: "PUT",
      url: `/api/repositories/${repositoryId}/policy`,
      payload: JSON.stringify({ contentYaml: policyYaml }),
      headers: { "content-type": "application/json" }
    });
    expect(policyWithoutActor.statusCode).toBe(401);

    const settingsWrongRole = await app.inject({
      method: "PATCH",
      url: `/api/repositories/${repositoryId}/settings`,
      payload: JSON.stringify({ fullDiffRetention: "7d" }),
      headers: { "content-type": "application/json", ...actorHeaders("sam", "developer") }
    });
    expect(settingsWrongRole.statusCode).toBe(403);

    const exportWithoutActor = await app.inject({
      method: "POST",
      url: "/api/exports/change-control-records",
      payload: JSON.stringify({ format: "json" }),
      headers: { "content-type": "application/json" }
    });
    expect(exportWithoutActor.statusCode).toBe(401);

    const auditWrongRole = await app.inject({
      method: "GET",
      url: "/api/audit-events",
      headers: actorHeaders("sam", "developer")
    });
    expect(auditWrongRole.statusCode).toBe(403);

    const queueWithoutActor = await app.inject({
      method: "GET",
      url: "/api/admin/queue"
    });
    expect(queueWithoutActor.statusCode).toBe(401);

    const queueWrongRole = await app.inject({
      method: "GET",
      url: "/api/admin/queue",
      headers: actorHeaders("sam", "developer")
    });
    expect(queueWrongRole.statusCode).toBe(403);

    const replayWithoutActor = await app.inject({
      method: "POST",
      url: "/api/admin/queue/replay",
      payload: JSON.stringify({ deliveryId: "delivery-security" }),
      headers: { "content-type": "application/json" }
    });
    expect(replayWithoutActor.statusCode).toBe(401);

    const replayWrongRole = await app.inject({
      method: "POST",
      url: "/api/admin/queue/replay",
      payload: JSON.stringify({ deliveryId: "delivery-security" }),
      headers: { "content-type": "application/json", ...actorHeaders("sam", "developer") }
    });
    expect(replayWrongRole.statusCode).toBe(403);

    await app.close();
  });

  it("rejects oversized policy YAML at direct API boundaries", async () => {
    const { app, state } = await createPreviewRecord();
    const repositoryId = state.records[0]!.repositoryId;
    const oversizedPolicy = `${policyYaml}\n# ${"x".repeat(200_001)}`;

    const validation = await app.inject({
      method: "POST",
      url: "/api/policies/validate",
      payload: JSON.stringify({ contentYaml: oversizedPolicy }),
      headers: { "content-type": "application/json" }
    });
    expect(validation.statusCode).toBe(400);

    const update = await app.inject({
      method: "PUT",
      url: `/api/repositories/${repositoryId}/policy`,
      payload: JSON.stringify({ contentYaml: oversizedPolicy }),
      headers: { "content-type": "application/json", ...actorHeaders("alex", "platform_admin") }
    });
    expect(update.statusCode).toBe(400);

    const preview = await app.inject({
      method: "POST",
      url: "/api/policies/preview",
      payload: JSON.stringify({ contentYaml: oversizedPolicy, pr: sensitivePr() }),
      headers: { "content-type": "application/json" }
    });
    expect(preview.statusCode).toBe(400);

    await app.close();
  });

  it("does not expose webhook payloads through queue inspection", async () => {
    const rawWebhookSecret = "webhook_secret_dummy_123";
    const state = createInitialState();
    state.queuedEvaluations.push({
      id: "delivery-secret",
      deliveryId: "delivery-secret",
      queuedAt: new Date().toISOString(),
      envelope: {
        deliveryId: "delivery-secret",
        event: "pull_request",
        action: "opened",
        repository: {
          id: 1,
          fullName: "acme/payments",
          owner: "acme",
          name: "payments",
          defaultBranch: "main"
        },
        pullRequest: {
          id: 1,
          number: 9,
          title: `Do not leak ${rawWebhookSecret}`,
          authorLogin: "sam",
          baseBranch: "main",
          headBranch: "feature/secret",
          headSha: "sha-secret",
          body: `token=${rawWebhookSecret}`,
          state: "open",
          merged: false
        },
        receivedAt: "2026-05-19T00:00:00.000Z"
      }
    });
    const app = createApp(state);

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/queue",
      headers: actorHeaders("alex", "platform_admin")
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        payloadsIncluded: false,
        queue: expect.objectContaining({
          counts: expect.objectContaining({ waiting: 1 })
        })
      })
    );
    expect(response.body).not.toContain(rawWebhookSecret);
    expect(response.body).not.toContain("pull_request");
    expect(response.body).not.toContain("Do not leak");
    await app.close();
  });

  it("keeps health safe while readiness fails when a configured queue is unavailable", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.DATABASE_URL;
    process.env.REDIS_URL = "redis://127.0.0.1:1";
    const app = createApp(createInitialState(), { prisma: undefined });

    const health = await app.inject({ method: "GET", url: "/health" });
    const ready = await app.inject({ method: "GET", url: "/ready" });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok", version: "1.0.0" });
    expect(health.body).not.toContain("workerQueue");
    expect(health.body).not.toContain("database");
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual(
      expect.objectContaining({
        status: "not_ready",
        workerQueue: "configured",
        queue: expect.objectContaining({
          status: "not_ready",
          backend: "redis",
          error: expect.objectContaining({
            errorClass: expect.any(String),
            message: expect.any(String)
          })
        })
      })
    );

    await app.close();
  });

  it("protects readiness and metrics details in production", async () => {
    setProductionProxyAuthEnv();
    const app = createApp(createInitialState());

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok", version: "1.0.0" });

    const unauthenticatedReady = await app.inject({ method: "GET", url: "/ready" });
    expect(unauthenticatedReady.statusCode).toBe(401);
    expect(unauthenticatedReady.body).not.toContain("runtimeStore");

    const unauthenticatedMetrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(unauthenticatedMetrics.statusCode).toBe(401);
    expect(unauthenticatedMetrics.body).not.toContain("agentforge_runtime_store");

    const developerReady = await app.inject({
      method: "GET",
      url: "/ready",
      headers: authenticatedActorHeaders("sam", "developer")
    });
    expect(developerReady.statusCode).toBe(403);

    const operatorReady = await app.inject({
      method: "GET",
      url: "/ready",
      headers: authenticatedActorHeaders("ops", "auditor")
    });
    expect(operatorReady.statusCode).toBe(200);
    expect(operatorReady.json()).toEqual(
      expect.objectContaining({
        status: "ready",
        runtimeStore: "in_memory",
        workerQueue: "in_memory"
      })
    );

    const operatorMetrics = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: authenticatedActorHeaders("ops", "platform_admin")
    });
    expect(operatorMetrics.statusCode).toBe(200);
    expect(operatorMetrics.body).toContain('agentforge_runtime_store{backend="in_memory"} 1');

    await app.close();
  });

  it("emits audit events for policy, retention, evidence, reviewer, check, and export actions", async () => {
    const { app, state } = await createPreviewRecord();
    const record = state.records[0]!;
    const evidence = record.requiredEvidence[0]!;
    const reviewer = record.requiredReviewers[0]!;

    await app.inject({
      method: "PUT",
      url: `/api/repositories/${record.repositoryId}/policy`,
      payload: JSON.stringify({ contentYaml: policyYaml }),
      headers: { "content-type": "application/json", ...actorHeaders("alex", "platform_admin") }
    });
    await app.inject({
      method: "PATCH",
      url: `/api/repositories/${record.repositoryId}/settings`,
      payload: JSON.stringify({ fullDiffRetention: "7d", sourceCodeStorage: false }),
      headers: { "content-type": "application/json", ...actorHeaders("alex", "platform_admin") }
    });
    await app.inject({
      method: "POST",
      url: `/api/pull-requests/${record.id}/evidence`,
      payload: JSON.stringify({
        evidenceId: evidence.id,
        content: `Security note: token rotated, old value ${rawGithubToken} revoked.`
      }),
      headers: { "content-type": "application/json", ...actorHeaders("sam", "developer") }
    });
    expect(JSON.stringify(state.records)).not.toContain(rawGithubToken);
    await app.inject({
      method: "PATCH",
      url: `/api/evidence/${evidence.id}/approve`,
      payload: JSON.stringify({}),
      headers: { "content-type": "application/json", ...actorHeaders("alex", "platform_admin") }
    });
    await app.inject({
      method: "PATCH",
      url: `/api/reviewers/${reviewer.id}/approve`,
      payload: JSON.stringify({}),
      headers: {
        "content-type": "application/json",
        ...actorHeaders("security-team", "security_reviewer")
      }
    });
    await app.inject({
      method: "POST",
      url: "/api/exports/change-control-records",
      payload: JSON.stringify({ format: "json" }),
      headers: { "content-type": "application/json", ...actorHeaders("alex", "platform_admin") }
    });

    const audit = await app.inject({
      method: "GET",
      url: "/api/audit-events",
      headers: actorHeaders("alex", "platform_admin")
    });
    const actions = audit.json().auditEvents.map((event: { action: string }) => event.action);
    const auditEvents = audit.json().auditEvents as Array<{
      schemaVersion: number;
      actorRole: string;
      source: string;
      requestId?: string;
      metadataJson: Record<string, unknown>;
    }>;
    expect(actions).toEqual(
      expect.arrayContaining([
        "check_published",
        "policy_changed",
        "retention_changed",
        "evidence_provided",
        "evidence_approved",
        "reviewer_approved",
        "record_exported"
      ])
    );
    for (const event of auditEvents) {
      expect(event.schemaVersion).toBe(1);
      expect(event.actorRole).toEqual(expect.any(String));
      expect(event.source).toMatch(/^(api|worker|webhook|system)$/u);
      expect(event.metadataJson).toEqual(
        expect.objectContaining({
          schemaVersion: 1,
          actorRole: event.actorRole,
          source: event.source
        })
      );
    }
    const apiEvents = auditEvents.filter((event) => event.source === "api");
    expect(apiEvents.length).toBeGreaterThan(0);
    for (const event of apiEvents) {
      expect(event.requestId).toBeDefined();
      expect(event.requestId).toMatch(/^req-/u);
    }
    expect(JSON.stringify(audit.json())).not.toContain(rawGithubToken);
    const metrics = await app.inject({
      method: "GET",
      url: "/metrics"
    });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain('agentforge_audit_events_total{action="record_exported"} 1');
    expect(metrics.body).toContain('agentforge_audit_events_total{action="evidence_provided"} 1');
    expect(metrics.body).not.toContain(rawGithubToken);
    await app.close();
  });
});
