import { describe, expect, it } from "vitest";
import type { ChangeControlRecord, VerifiedFact } from "@agentforge/core";

import { buildEvidenceReport } from "./design-partner-report.js";

function finding(type: VerifiedFact["type"], id: string): VerifiedFact {
  return { id, type, source: "github_diff", evidence: "evidence", confidence: "verified" };
}

function record(id: string, lifecycle: ChangeControlRecord["lifecycle"], findings: VerifiedFact[]): ChangeControlRecord {
  return {
    id,
    revision: 1,
    organizationId: "org",
    repositoryId: "repo",
    repositoryFullName: "acme/repo",
    pullRequestNumber: 1,
    headSha: "abc",
    baseBranch: "main",
    mode: "enforce",
    policyVersion: "1",
    verifiedFindings: findings,
    requiredEvidence: [],
    requiredReviewers: [],
    checkStatus: "block",
    lifecycle,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("buildEvidenceReport", () => {
  it("produces a markdown report with validation metrics and detector precision", () => {
    const markdown = buildEvidenceReport([
      record("r1", "overridden", [finding("sensitive_path_changed", "f1")]),
      record("r2", "passed", [finding("sensitive_path_changed", "f2")])
    ]);
    expect(markdown).toContain("# AgentForge Design-Partner Evidence Report");
    expect(markdown).toContain("Records analyzed: 2");
    expect(markdown).toContain("Override rate");
    expect(markdown).toContain("sensitive_path_changed");
    expect(markdown).toContain("Governance health");
  });

  it("handles an empty window gracefully", () => {
    const markdown = buildEvidenceReport([]);
    expect(markdown).toContain("Records analyzed: 0");
    expect(markdown).toContain("No findings in this window.");
  });
});
