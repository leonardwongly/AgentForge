import { describe, expect, it } from "vitest";
import { type PolicyMode, type PolicyResult, type PullRequestInput } from "@agentforge/core";
import { createChangeControlRecord, updateRecordFromPolicyResult } from "./index.js";

const pr: PullRequestInput = {
  repositoryFullName: "acme/payments",
  pullRequestNumber: 7,
  title: "Change",
  authorLogin: "sam",
  baseBranch: "main",
  headBranch: "feature/x",
  headSha: "sha7",
  changedFiles: []
};

function resultFor(mode: PolicyMode, status: PolicyResult["status"]): PolicyResult {
  return {
    mode,
    status,
    policyVersion: "fintech@1.0.0",
    policyPackId: "fintech",
    policyPackVersion: "1.0.0",
    findings: [
      {
        id: "fact_1",
        type: "sensitive_path_changed",
        source: "github_diff",
        path: "src/billing/checkout.ts",
        evidence: "Sensitive path changed",
        confidence: "verified",
        severity: "high"
      }
    ],
    requiredEvidence: [
      { id: "evidence_1", kind: "rollback_plan", status: "missing", requiredByFindingId: "fact_1" }
    ],
    requiredReviewers: [
      {
        id: "reviewer_1",
        reviewer: "billing-owner",
        reviewerType: "team",
        tier: "required",
        reason: "Sensitive path changed",
        triggeredByFindingId: "fact_1",
        approved: false
      }
    ],
    explanation: ["Sensitive path changed."],
    evaluatedAt: "2026-05-12T00:00:00.000Z"
  };
}

const lifecycleForStatus: Record<PolicyResult["status"], string> = {
  block: "blocked",
  warn: "warned",
  pass: "passed"
};

describe("change control record is a faithful projection of the policy result", () => {
  it("copies decision-relevant fields and preserves finding/evidence/reviewer counts", () => {
    const result = resultFor("enforce", "block");
    const record = createChangeControlRecord({
      organizationId: "org_local",
      repositoryId: "repo_1",
      pr,
      policyResult: result
    });

    expect(record.checkStatus).toBe(result.status);
    expect(record.mode).toBe(result.mode);
    expect(record.policyVersion).toBe(result.policyVersion);
    expect(record.policyPackId).toBe(result.policyPackId);
    expect(record.policyPackVersion).toBe(result.policyPackVersion);
    expect(record.lifecycle).toBe(lifecycleForStatus[result.status]);
    expect(record.decision?.status).toBe("blocked");
    expect(record.verifiedFindings).toHaveLength(result.findings.length);
    expect(record.requiredEvidence).toHaveLength(result.requiredEvidence.length);
    expect(record.requiredReviewers).toHaveLength(result.requiredReviewers.length);
  });

  it("re-projects faithfully on re-evaluation", () => {
    const initial = createChangeControlRecord({
      organizationId: "org_local",
      repositoryId: "repo_1",
      pr,
      policyResult: resultFor("enforce", "block")
    });
    const updated = updateRecordFromPolicyResult(initial, resultFor("warn", "warn"));

    expect(updated.checkStatus).toBe("warn");
    expect(updated.mode).toBe("warn");
    expect(updated.lifecycle).toBe("warned");
  });

  it("mirrors check status and lifecycle for every evaluation status", () => {
    const statuses: PolicyResult["status"][] = ["pass", "warn", "block"];
    for (const status of statuses) {
      const record = createChangeControlRecord({
        organizationId: "org_local",
        repositoryId: "repo_1",
        pr,
        policyResult: resultFor("enforce", status)
      });
      expect(record.checkStatus).toBe(status);
      expect(record.lifecycle).toBe(lifecycleForStatus[status]);
    }
  });
});
