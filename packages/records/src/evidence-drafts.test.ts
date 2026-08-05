import { describe, expect, it } from "vitest";
import type { ChangeControlRecord } from "@agentforge/core";
import { withEvidenceDrafts } from "./index.js";

function baseRecord(): ChangeControlRecord {
  return {
    id: "r1",
    revision: 0,
    organizationId: "org",
    repositoryId: "repo",
    repositoryFullName: "acme/app",
    pullRequestNumber: 7,
    headSha: "sha7",
    baseBranch: "main",
    mode: "enforce",
    policyVersion: "fintech@1.0.0",
    verifiedFindings: [
      {
        id: "f1",
        type: "migration_added",
        source: "github_diff",
        path: "db/migrations/1.sql",
        evidence: "migration added",
        confidence: "verified",
        severity: "high"
      }
    ],
    requiredEvidence: [
      { id: "e1", kind: "rollback_plan", status: "missing", requiredByFindingId: "f1" },
      { id: "e2", kind: "rollback_plan", status: "approved", requiredByFindingId: "f1" }
    ],
    requiredReviewers: [],
    checkStatus: "block",
    lifecycle: "blocked",
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z"
  };
}

describe("withEvidenceDrafts", () => {
  it("drafts unsatisfied evidence and leaves approved evidence untouched", () => {
    const enriched = withEvidenceDrafts(baseRecord());
    expect(enriched.requiredEvidence.find((item) => item.id === "e1")?.aiDraft).toContain(
      "Rollback Plan"
    );
    expect(enriched.requiredEvidence.find((item) => item.id === "e2")?.aiDraft).toBeUndefined();
  });

  it("never changes the check status or lifecycle (advisory only)", () => {
    const record = baseRecord();
    const enriched = withEvidenceDrafts(record);
    expect(enriched.checkStatus).toBe(record.checkStatus);
    expect(enriched.lifecycle).toBe(record.lifecycle);
  });

  it("skips evidence whose triggering finding is absent", () => {
    const record = baseRecord();
    record.requiredEvidence = [
      { id: "e3", kind: "security_note", status: "missing", requiredByFindingId: "absent" }
    ];
    expect(withEvidenceDrafts(record).requiredEvidence[0]?.aiDraft).toBeUndefined();
  });
});
