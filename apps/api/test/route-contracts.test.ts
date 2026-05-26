import { describe, expect, it } from "vitest";
import type { ChangeControlRecord } from "@agentforge/core";
import { createApp, createInitialState } from "../src/index.js";

const policyYaml = `
version: 1
policy_pack_id: route-contract
policy_pack_version: 1.0.0
agentforge:
  mode: warn
  apply_to:
    - all_pull_requests
overrides:
  allowed_roles:
    - platform_admin
  require_reason: true
  visible_in_pr: true
  audit: true
`;

function actorHeaders(role = "auditor", organizationId = "org_local"): Record<string, string> {
  return {
    "x-agentforge-actor": "route-contract-user",
    "x-agentforge-role": role,
    "x-agentforge-organization": organizationId
  };
}

describe("API route plugin contracts", () => {
  it.each([
    ["GET", "/api/repositories"],
    ["GET", "/api/settings"],
    ["GET", "/api/pull-requests"],
    ["GET", "/api/dashboard/records"],
    ["GET", "/api/audit-events"],
    ["GET", "/api/admin/queue"],
    ["POST", "/api/admin/queue/replay"],
    ["POST", "/api/exports/change-control-records"]
  ] as const)("keeps %s %s protected after route extraction", async (method, url) => {
    const app = createApp(createInitialState());
    const request =
      method === "POST"
        ? {
            method,
            url,
            payload: JSON.stringify({}),
            headers: { "content-type": "application/json" }
          }
        : { method, url };

    const response = await app.inject(request);

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("keeps public health, webhook validation, and policy utility routes reachable", async () => {
    const app = createApp(createInitialState());

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "ok", version: "0.1.0" });

    const webhook = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: JSON.stringify({ action: "opened" }),
      headers: { "content-type": "application/json" }
    });
    expect(webhook.statusCode).toBe(400);
    expect(webhook.json()).toMatchObject({ error: "Missing GitHub webhook headers" });

    const policyValidation = await app.inject({
      method: "POST",
      url: "/api/policies/validate",
      payload: JSON.stringify({ contentYaml: policyYaml }),
      headers: { "content-type": "application/json" }
    });
    expect(policyValidation.statusCode).toBe(200);
    expect(policyValidation.json()).toMatchObject({ valid: true });

    const codeowners = await app.inject({
      method: "POST",
      url: "/api/codeowners/preview",
      payload: JSON.stringify({
        content: "*.ts @platform\n/docs/ @docs-team",
        changedPaths: ["src/app.ts", "docs/readme.md"]
      }),
      headers: { "content-type": "application/json" }
    });
    expect(codeowners.statusCode).toBe(200);
    expect(codeowners.json()).toMatchObject({ suggestions: expect.any(Array) });

    await app.close();
  });

  it("keeps tenant-scoped read and export response contracts stable", async () => {
    const state = createInitialState();
    state.records = [record("record-local", "org_local"), record("record-other", "org_other")];
    const app = createApp(state);

    const repositories = await app.inject({
      method: "GET",
      url: "/api/repositories",
      headers: actorHeaders("auditor", "org_local")
    });
    expect(repositories.statusCode).toBe(200);
    expect(repositories.json().repositories).toHaveLength(1);

    const dashboard = await app.inject({
      method: "GET",
      url: "/api/dashboard/summary",
      headers: actorHeaders("auditor", "org_local")
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json()).toMatchObject({
      blockedPrCount: 1,
      warningCount: 0
    });

    const createdExport = await app.inject({
      method: "POST",
      url: "/api/exports/change-control-records",
      payload: JSON.stringify({ format: "json" }),
      headers: {
        ...actorHeaders("auditor", "org_local"),
        "content-type": "application/json"
      }
    });
    expect(createdExport.statusCode).toBe(201);
    expect(createdExport.json()).toMatchObject({
      status: "completed",
      recordCount: 1,
      totalMatchingRecords: 1,
      truncated: false
    });

    const exportJob = await app.inject({
      method: "GET",
      url: `/api/exports/${createdExport.json().id}`,
      headers: actorHeaders("auditor", "org_local")
    });
    expect(exportJob.statusCode).toBe(200);
    expect(exportJob.body).toContain("record-local");
    expect(exportJob.body).not.toContain("record-other");

    await app.close();
  });
});

function record(id: string, organizationId: string): ChangeControlRecord {
  return {
    id,
    organizationId,
    repositoryId: `repo-${organizationId}`,
    repositoryFullName: `${organizationId}/payments`,
    pullRequestNumber: 42,
    headSha: `sha-${id}`,
    baseBranch: "main",
    mode: "enforce",
    policyVersion: "route-contract@1.0.0",
    policyPackId: "route-contract",
    policyPackVersion: "1.0.0",
    verifiedFindings: [
      {
        id: `finding-${id}`,
        type: "sensitive_path_changed",
        source: "github_diff",
        evidence: "src/auth/session.ts changed",
        confidence: "verified",
        severity: "high"
      }
    ],
    requiredEvidence: [],
    requiredReviewers: [],
    checkStatus: "block",
    lifecycle: "blocked",
    decision: { status: "blocked" },
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z"
  };
}
