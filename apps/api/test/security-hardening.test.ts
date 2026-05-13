import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { PullRequestInput } from "@agentforge/core";
import { buildLlmAdvisoryPrompt } from "@agentforge/security";
import { createApp, createInitialState } from "../src/index.js";

const rawGithubToken = "ghp_123456789012345678901234567890123456";
const rawSource = "export const checkoutToken = process.env.CHECKOUT_TOKEN;";

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
  const response = await app.inject({
    method: "POST",
    url: "/api/policies/preview",
    payload: JSON.stringify({ contentYaml: policyYaml, pr: sensitivePr() }),
    headers: { "content-type": "application/json" }
  });
  expect(response.statusCode).toBe(200);
  return { app, state, response };
}

afterEach(() => {
  delete process.env.GITHUB_WEBHOOK_SECRET;
  delete process.env.SOURCE_CODE_STORAGE;
  delete process.env.FULL_DIFF_RETENTION;
  delete process.env.REDACT_SECRETS;
  delete process.env.LLM_FEATURES;
  delete process.env.ALLOW_UNSIGNED_GITHUB_WEBHOOKS;
});

describe("security and audit hardening", () => {
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

  it("rejects unauthorized overrides and records authorized override audit details", async () => {
    const { app, state } = await createPreviewRecord();
    const record = state.records[0]!;

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
    const { app } = await createPreviewRecord();

    const policyWithoutActor = await app.inject({
      method: "PUT",
      url: "/api/repositories/repo_local/policy",
      payload: JSON.stringify({ contentYaml: policyYaml }),
      headers: { "content-type": "application/json" }
    });
    expect(policyWithoutActor.statusCode).toBe(401);

    const settingsWrongRole = await app.inject({
      method: "PATCH",
      url: "/api/repositories/repo_local/settings",
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
      url: "/api/repositories/repo_local/policy",
      payload: JSON.stringify({ contentYaml: policyYaml }),
      headers: { "content-type": "application/json", ...actorHeaders("alex", "platform_admin") }
    });
    await app.inject({
      method: "PATCH",
      url: "/api/repositories/repo_local/settings",
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
