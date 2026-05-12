import { describe, expect, it } from "vitest";
import type { PolicyHit, PullRequestInput, VerifiedFact } from "@agentforge/core";
import { deriveEvidenceRequirements, findEvidenceInPrBody } from "./index.js";

const fact: VerifiedFact = {
  id: "fact_1",
  type: "migration_added",
  source: "github_diff",
  evidence: "Database migration added",
  confidence: "verified"
};

const hit: PolicyHit = {
  id: "hit_1",
  ruleId: "database.migrations",
  finding: fact,
  action: "block",
  severity: "high",
  requiredEvidence: ["rollback_plan", "migration_dry_run"],
  requiredReviewers: ["database-owner"],
  explanation: "Database migration changed."
};

describe("evidence engine", () => {
  it("detects evidence in PR body", () => {
    const found = findEvidenceInPrBody("rollback_plan", "Rollback plan: revert the migration.");
    expect(found?.contentSummary).toContain("revert");
  });

  it("creates missing evidence when evidence is absent", () => {
    const pr: PullRequestInput = {
      repositoryFullName: "acme/payments",
      pullRequestNumber: 1,
      title: "Migration",
      authorLogin: "sam",
      baseBranch: "main",
      headBranch: "db/demo",
      headSha: "sha",
      changedFiles: []
    };
    const requirements = deriveEvidenceRequirements([hit], pr);
    expect(requirements.filter((item) => item.status === "missing")).toHaveLength(2);
  });
});
