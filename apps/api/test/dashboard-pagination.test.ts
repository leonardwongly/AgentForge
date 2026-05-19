import { describe, expect, it } from "vitest";
import type { ChangeControlRecord } from "@agentforge/core";
import { createApp, createInitialState } from "../src/index.js";

describe("dashboard pagination and bounded exports", () => {
  it("paginates and filters dashboard records with bounded query params", async () => {
    const state = createInitialState();
    state.records = [
      record("record-3", 3, "pass", "passed"),
      record("record-2", 2, "block", "blocked"),
      record("record-1", 1, "block", "blocked")
    ];
    const app = createApp(state);

    const response = await app.inject({
      method: "GET",
      url: "/api/dashboard/records?status=block&limit=1&offset=1&sort=pr_asc"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      pageInfo: {
        limit: 1,
        offset: 1,
        total: 2,
        hasMore: false
      }
    });
    expect(response.json().records).toHaveLength(1);
    expect(response.json().records[0].pullRequestNumber).toBe(2);
    await app.close();
  });

  it("rejects invalid pagination parameters before scanning dashboard records", async () => {
    const app = createApp(createInitialState());

    const response = await app.inject({
      method: "GET",
      url: "/api/dashboard/records?limit=10000"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().details.limit).toEqual(expect.arrayContaining([expect.any(String)]));
    await app.close();
  });

  it("keeps large dashboard responses bounded to the requested page size", async () => {
    const state = createInitialState();
    state.records = Array.from({ length: 500 }, (_, index) =>
      record(`record-${index + 1}`, index + 1, index % 3 === 0 ? "block" : "pass", "passed")
    );
    const app = createApp(state);

    const response = await app.inject({
      method: "GET",
      url: "/api/dashboard/records?limit=50&offset=100"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().records).toHaveLength(50);
    expect(response.json().pageInfo).toMatchObject({
      limit: 50,
      offset: 100,
      total: 500,
      hasMore: true,
      nextOffset: 150
    });
    await app.close();
  });

  it("bounds exports and reports truncation without crossing tenant scope", async () => {
    const state = createInitialState();
    state.records = [
      record("record-a-3", 3, "pass", "passed", "org-a"),
      record("record-a-2", 2, "pass", "passed", "org-a"),
      record("record-a-1", 1, "pass", "passed", "org-a"),
      record("record-b-1", 1, "pass", "passed", "org-b")
    ];
    const app = createApp(state);

    const response = await app.inject({
      method: "POST",
      url: "/api/exports/change-control-records",
      payload: JSON.stringify({ format: "json", maxRecords: 2 }),
      headers: {
        "content-type": "application/json",
        "x-agentforge-actor": "auditor-a",
        "x-agentforge-role": "auditor",
        "x-agentforge-organization": "org-a"
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      recordCount: 2,
      totalMatchingRecords: 3,
      truncated: true
    });
    const job = state.exports[0]!;
    expect(job).toMatchObject({
      recordCount: 2,
      totalMatchingRecords: 3,
      truncated: true
    });
    expect(job.content).toContain("record-a-3");
    expect(job.content).not.toContain("record-b-1");
    await app.close();
  });

  it("returns advisory policy insights without mutating records", async () => {
    const state = createInitialState();
    state.records = [
      {
        ...record("record-a", 1, "block", "overridden"),
        requiredEvidence: [
          {
            id: "evidence-a",
            kind: "security_note",
            status: "rejected",
            requiredByFindingId: "finding-record-a"
          }
        ],
        requiredReviewers: [
          {
            id: "reviewer-a",
            reviewer: "security-team",
            reviewerType: "team",
            tier: "required",
            reason: "Security finding requires review.",
            triggeredByFindingId: "finding-record-a",
            approved: false
          }
        ]
      },
      record("record-b", 2, "block", "overridden"),
      record("record-c", 3, "block", "blocked")
    ];
    const before = JSON.stringify(state.records);
    const app = createApp(state);

    const response = await app.inject({
      method: "GET",
      url: "/api/dashboard/policy-insights?limit=50"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().insights).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "override_noise",
          guardrail: expect.stringContaining("Advisory only")
        })
      ])
    );
    expect(JSON.stringify(state.records)).toBe(before);
    await app.close();
  });
});

function record(
  id: string,
  pullRequestNumber: number,
  checkStatus: ChangeControlRecord["checkStatus"],
  lifecycle: ChangeControlRecord["lifecycle"],
  organizationId = "org_local"
): ChangeControlRecord {
  const seconds = String(pullRequestNumber % 60).padStart(2, "0");
  const timestamp = `2026-05-19T00:00:${seconds}.000Z`;
  return {
    id,
    organizationId,
    repositoryId: `repo-${organizationId}`,
    repositoryFullName: `${organizationId}/payments`,
    pullRequestNumber,
    headSha: `sha-${id}`,
    baseBranch: "main",
    mode: checkStatus === "block" ? "enforce" : "warn",
    policyVersion: "fintech@1.0.0",
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
    checkStatus,
    lifecycle,
    decision: checkStatus === "block" ? { status: "blocked" } : { status: "passed" },
    createdAt: timestamp,
    updatedAt: timestamp
  };
}
