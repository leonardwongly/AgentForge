import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { PullRequestInput } from "@agentforge/core";
import { buildLlmAdvisoryPrompt } from "@agentforge/security";
import { createApp, createInitialState } from "../src/index.js";

const rawGithubToken = "ghp_123456789012345678901234567890123456";
const rawSource = "export const checkoutToken = process.env.CHECKOUT_TOKEN;";
const mutableEnvKeys = [
  "DATABASE_URL",
  "REDIS_URL",
  "NODE_ENV",
  "GITHUB_WEBHOOK_SECRET",
  "SOURCE_CODE_STORAGE",
  "FULL_DIFF_RETENTION",
  "REDACT_SECRETS",
  "LLM_FEATURES",
  "ALLOW_UNSIGNED_GITHUB_WEBHOOKS",
  "AGENTFORGE_API_TRUST_PROXY_HEADERS",
  "AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS"
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

function actorHeaders(actor: string, role: string): Record<string, string> {
  return {
    "x-agentforge-actor": actor,
    "x-agentforge-role": role
  };
}

function authenticatedActorHeaders(actor: string, role: string): Record<string, string> {
  return {
    "x-agentforge-authenticated-actor": actor,
    "x-agentforge-authenticated-role": role
  };
}

function sensitivePr(): PullRequestInput {
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
    ]
  };
}

async function createPreviewRecord() {
  const state = createInitialState();
  const app = createApp(state);
  const headers =
    process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS === "true"
      ? authenticatedActorHeaders("alex", "platform_admin")
      : actorHeaders("alex", "platform_admin");
  const response = await app.inject({
    method: "POST",
    url: "/api/policies/preview",
    payload: JSON.stringify({ contentYaml: policyYaml, pr: sensitivePr(), persist: true }),
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

    const app = createApp(createInitialState());

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

    const dashboard = await app.inject({ method: "GET", url: "/api/dashboard/blocked-prs" });
    expect(dashboard.body).not.toContain(rawGithubToken);
    expect(dashboard.body).not.toContain(rawSource);
    const records = await app.inject({ method: "GET", url: "/api/dashboard/records" });
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
        kind: evidence.kind,
        content: "Security note: provided without authenticated actor headers."
      }),
      headers: { "content-type": "application/json" }
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects raw local actor headers in production unless explicitly allowed", async () => {
    process.env.NODE_ENV = "production";
    process.env.GITHUB_WEBHOOK_SECRET = "production-secret";
    process.env.AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS = "true";
    const { app, state } = await createPreviewRecord();
    delete process.env.AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS;
    const record = state.records[0]!;
    const evidence = record.requiredEvidence[0]!;

    const rejected = await app.inject({
      method: "POST",
      url: `/api/pull-requests/${record.id}/evidence`,
      payload: JSON.stringify({
        kind: evidence.kind,
        content: "Security note: raw local actor headers are not production auth context."
      }),
      headers: { "content-type": "application/json", ...actorHeaders("sam", "developer") }
    });
    expect(rejected.statusCode).toBe(401);

    process.env.AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS = "true";
    const allowedLocalFallback = await app.inject({
      method: "POST",
      url: `/api/pull-requests/${record.id}/evidence`,
      payload: JSON.stringify({
        kind: evidence.kind,
        content: "Security note: explicit production local fallback accepted."
      }),
      headers: { "content-type": "application/json", ...actorHeaders("sam", "developer") }
    });
    expect(allowedLocalFallback.statusCode).toBe(200);
    await app.close();
  });

  it("accepts authenticated proxy actor headers in production when proxy trust is enabled", async () => {
    process.env.NODE_ENV = "production";
    process.env.GITHUB_WEBHOOK_SECRET = "production-secret";
    process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS = "true";
    const { app, state } = await createPreviewRecord();
    const record = state.records[0]!;
    const evidence = record.requiredEvidence[0]!;

    const accepted = await app.inject({
      method: "POST",
      url: `/api/pull-requests/${record.id}/evidence`,
      payload: JSON.stringify({
        kind: evidence.kind,
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
    const evidence = record.requiredEvidence[0]!;
    const reviewer = record.requiredReviewers[0]!;

    expect(record.checkStatus).toBe("block");

    const provided = await app.inject({
      method: "POST",
      url: `/api/pull-requests/${record.id}/evidence`,
      payload: JSON.stringify({
        kind: evidence.kind,
        content: "Security note: secret-like value was removed and the old token was revoked."
      }),
      headers: { "content-type": "application/json", ...actorHeaders("sam", "developer") }
    });
    expect(provided.statusCode).toBe(200);
    expect(state.records[0]!.checkStatus).toBe("block");

    const approvedEvidence = await app.inject({
      method: "PATCH",
      url: `/api/evidence/${evidence.id}/approve`,
      payload: JSON.stringify({}),
      headers: { "content-type": "application/json", ...actorHeaders("alex", "platform_admin") }
    });
    expect(approvedEvidence.statusCode).toBe(200);
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
      url: `/api/pull-requests/${record.id}/change-control-record`
    });
    expect(updated.json().record).toMatchObject({
      checkStatus: "pass",
      lifecycle: "passed",
      decision: expect.objectContaining({ status: "passed" })
    });
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
      expect(job.body).not.toContain(rawGithubToken);
      expect(job.body).not.toContain(rawSource);
      expect(job.body).not.toContain("currentContent");
      expect(job.body).not.toContain("previousContent");
    }

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
        kind: evidence.kind,
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
    expect(JSON.stringify(audit.json())).not.toContain(rawGithubToken);
    await app.close();
  });
});
