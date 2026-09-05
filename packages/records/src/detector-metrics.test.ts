import { describe, expect, it } from "vitest";
import type { ChangeControlRecord, VerifiedFact } from "@agentforge/core";

import { computeDetectorMetrics, computeGovernanceHealth } from "./index.js";

function finding(type: VerifiedFact["type"], id: string): VerifiedFact {
  return { id, type, source: "github_diff", evidence: "evidence", confidence: "verified" };
}

function record(
  id: string,
  lifecycle: ChangeControlRecord["lifecycle"],
  findings: VerifiedFact[]
): ChangeControlRecord {
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

describe("computeDetectorMetrics", () => {
  it("returns an empty list for no records", () => {
    expect(computeDetectorMetrics([])).toEqual([]);
  });

  it("aggregates findings per detector across records", () => {
    const metrics = computeDetectorMetrics([
      record("r1", "passed", [
        finding("sensitive_path_changed", "f1"),
        finding("migration_added", "f2")
      ]),
      record("r2", "passed", [finding("sensitive_path_changed", "f3")])
    ]);
    const sensitive = metrics.find((m) => m.detector === "sensitive_path_changed");
    const migration = metrics.find((m) => m.detector === "migration_added");
    expect(sensitive?.findingCount).toBe(2);
    expect(sensitive?.affectedRecordCount).toBe(2);
    expect(sensitive?.overrideCount).toBe(0);
    expect(sensitive?.precision).toBe(1);
    expect(migration?.findingCount).toBe(1);
    expect(migration?.affectedRecordCount).toBe(1);
  });

  it("treats overridden records as the false-positive proxy for precision", () => {
    const metrics = computeDetectorMetrics([
      record("r1", "overridden", [finding("sensitive_path_changed", "f1")]),
      record("r2", "overridden", [finding("sensitive_path_changed", "f2")]),
      record("r3", "passed", [finding("sensitive_path_changed", "f3")])
    ]);
    const sensitive = metrics.find((m) => m.detector === "sensitive_path_changed");
    expect(sensitive?.findingCount).toBe(3);
    expect(sensitive?.overrideCount).toBe(2);
    expect(sensitive?.precision).toBeCloseTo(1 - 2 / 3, 3);
  });

  it("counts an override once per detector per record even with multiple findings", () => {
    const metrics = computeDetectorMetrics([
      record("r1", "overridden", [
        finding("sensitive_path_changed", "f1"),
        finding("sensitive_path_changed", "f2")
      ])
    ]);
    const sensitive = metrics.find((m) => m.detector === "sensitive_path_changed");
    expect(sensitive?.findingCount).toBe(2);
    expect(sensitive?.overrideCount).toBe(1);
  });

  it("sorts detectors by finding count descending", () => {
    const metrics = computeDetectorMetrics([
      record("r1", "passed", [finding("test_deleted", "f1")]),
      record("r2", "passed", [
        finding("dependency_added", "f2"),
        finding("dependency_added", "f3"),
        finding("migration_added", "f4")
      ])
    ]);
    expect(metrics[0]?.detector).toBe("dependency_added");
    expect(metrics[0]?.findingCount).toBe(2);
  });
});

describe("computeGovernanceHealth", () => {
  it("scores a clean window as A", () => {
    const health = computeGovernanceHealth({
      overrideRate: 0,
      rejectedEvidenceRate: 0,
      openEvidenceRate: 0,
      pendingReviewerRate: 0,
      observeOrWarnOpenRequirementCount: 0
    });
    expect(health.score).toBe(100);
    expect(health.grade).toBe("A");
  });

  it("penalizes override and open evidence noise", () => {
    const health = computeGovernanceHealth({
      overrideRate: 40,
      rejectedEvidenceRate: 0,
      openEvidenceRate: 30,
      pendingReviewerRate: 20,
      observeOrWarnOpenRequirementCount: 3
    });
    expect(health.score).toBe(100 - Math.round(40 * 0.4 + 30 * 0.3 + 20 * 0.2));
    expect(health.grade).toBe("C");
  });

  it("clamps the score to the 0-100 range", () => {
    const health = computeGovernanceHealth({
      overrideRate: 100,
      rejectedEvidenceRate: 100,
      openEvidenceRate: 100,
      pendingReviewerRate: 100,
      observeOrWarnOpenRequirementCount: 10
    });
    expect(health.score).toBe(0);
    expect(health.grade).toBe("D");
  });
});
