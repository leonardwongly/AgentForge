import { describe, expect, it } from "vitest";
import type { PolicyResult, PullRequestInput } from "@agentforge/core";
import { createChangeControlRecord, createComplianceEvidencePackage } from "./index.js";

const pr: PullRequestInput = {
  repositoryFullName: "acme/payments",
  pullRequestNumber: 3,
  title: "Change",
  authorLogin: "sam",
  baseBranch: "main",
  headBranch: "feature/x",
  headSha: "sha3",
  changedFiles: []
};

const result: PolicyResult = {
  mode: "enforce",
  status: "block",
  policyVersion: "fintech@1.0.0",
  policyPackId: "fintech",
  policyPackVersion: "1.0.0",
  findings: [
    {
      id: "f1",
      type: "secret_like_value_detected",
      source: "github_diff",
      path: "src/billing/x.ts",
      evidence: "secret-like value",
      confidence: "observed",
      severity: "critical"
    }
  ],
  requiredEvidence: [
    { id: "e1", kind: "security_note", status: "missing", requiredByFindingId: "f1" }
  ],
  requiredReviewers: [
    {
      id: "r1",
      reviewer: "security-team",
      reviewerType: "team",
      tier: "required",
      reason: "secret",
      triggeredByFindingId: "f1",
      approved: false
    }
  ],
  explanation: [],
  evaluatedAt: "2026-05-12T00:00:00.000Z"
};

describe("compliance framework references", () => {
  const pkg = createComplianceEvidencePackage({
    records: [
      createChangeControlRecord({
        organizationId: "org",
        repositoryId: "repo",
        pr,
        policyResult: result
      })
    ]
  });
  const controlsByFamily = new Map(pkg.controls.map((control) => [control.controlFamily, control]));

  it("maps change management to SOC 2 and ISO/IEC 27001 controls", () => {
    const cc8 = controlsByFamily.get("SOC2_CC8_CHANGE_MANAGEMENT");
    const frameworks = new Map(cc8?.frameworks.map((ref) => [ref.framework, ref.controls]));
    expect(frameworks.get("SOC 2")).toContain("CC8.1");
    expect(frameworks.get("ISO/IEC 27001:2022")).toContain("A.8.32");
  });

  it("adds an ISO/IEC 27001 reference to every mapped control", () => {
    expect(pkg.controls.length).toBeGreaterThan(0);
    for (const control of pkg.controls) {
      expect(control.frameworks.some((ref) => ref.framework === "ISO/IEC 27001:2022")).toBe(true);
    }
  });
});
