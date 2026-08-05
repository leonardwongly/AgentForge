import { describe, expect, it } from "vitest";
import type {
  EvidenceRequirement,
  ManualEvidenceInput,
  PolicyHit,
  PullRequestInput,
  VerifiedFact
} from "@agentforge/core";
import { addManualEvidence, deriveEvidenceRequirements, findEvidenceInPrBody } from "./index.js";

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

  it("deduplicates requirements that share the same finding and evidence kind", () => {
    const duplicateHit: PolicyHit = {
      ...hit,
      id: "hit_2",
      ruleId: "database.migrations.2"
    };
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
    // Two hits reference the same finding id + kind -> one requirement, not two.
    const requirements = deriveEvidenceRequirements([hit, duplicateHit], pr);
    expect(requirements).toHaveLength(2);
    expect(requirements.map((item) => item.id)).toEqual([
      "evidence:fact_1:rollback_plan",
      "evidence:fact_1:migration_dry_run"
    ]);
  });

  it("returns an empty list for no policy hits", () => {
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
    expect(deriveEvidenceRequirements([], pr)).toEqual([]);
  });

  it("derives a provided requirement from PR body evidence attributed to the author", () => {
    const pr: PullRequestInput = {
      repositoryFullName: "acme/payments",
      pullRequestNumber: 1,
      title: "Migration",
      authorLogin: "sam",
      baseBranch: "main",
      headBranch: "db/demo",
      headSha: "sha",
      changedFiles: [],
      body: "Rollback plan: revert the migration by running migrate down."
    };
    const requirements = deriveEvidenceRequirements([hit], pr);
    const rollback = requirements.find((item) => item.kind === "rollback_plan");
    expect(rollback).toMatchObject({
      status: "provided",
      source: "pr_body",
      providedBy: "sam"
    });
    expect(rollback?.contentSummary).toContain("revert");
  });

  it("prefers manual evidence over PR body evidence for the same kind", () => {
    const pr: PullRequestInput = {
      repositoryFullName: "acme/payments",
      pullRequestNumber: 1,
      title: "Migration",
      authorLogin: "sam",
      baseBranch: "main",
      headBranch: "db/demo",
      headSha: "sha",
      changedFiles: [],
      body: "Rollback plan: revert the migration.",
      manualEvidence: [
        {
          kind: "rollback_plan",
          content: "Manual rollback plan: restore snapshot.",
          actor: "alice",
          approved: true
        }
      ]
    };
    const requirements = deriveEvidenceRequirements([hit], pr);
    const rollback = requirements.find((item) => item.kind === "rollback_plan");
    expect(rollback).toMatchObject({
      status: "approved",
      source: "manual_attestation",
      providedBy: "alice"
    });
    expect(rollback?.contentSummary).toContain("Manual rollback plan");
  });

  it("matches evidence headings case-insensitively and across multi-line content", () => {
    const body = [
      "## Summary",
      "Migration dry run: validated schema.",
      "  - index created",
      "  - constraint added",
      "## Next steps",
      "Deploy."
    ].join("\n");
    const found = findEvidenceInPrBody("migration_dry_run", body);
    expect(found?.contentSummary).toContain("validated schema");
    expect(found?.contentSummary).toContain("constraint added");
  });

  it("returns undefined when the heading is absent or content is empty", () => {
    expect(findEvidenceInPrBody("rollback_plan", "No evidence here.")).toBeUndefined();
    expect(findEvidenceInPrBody("rollback_plan", "Rollback plan:")).toBeUndefined();
    expect(findEvidenceInPrBody("rollback_plan", "")).toBeUndefined();
  });

  it("redacts secrets from PR body evidence summaries", () => {
    const body = `Rollback plan: use token ghp_${"1".repeat(36)} to revert.`;
    const found = findEvidenceInPrBody("rollback_plan", body);
    expect(found?.contentSummary).not.toContain("ghp_");
    expect(found?.contentSummary).toContain("[REDACTED]");
  });
});

describe("addManualEvidence", () => {
  const requirement = (kind: EvidenceRequirement["kind"]): EvidenceRequirement => ({
    id: `evidence:fact_1:${kind}`,
    kind,
    status: "missing",
    requiredByFindingId: "fact_1"
  });

  it("updates only the requirement whose kind matches the provided evidence", () => {
    const current = [requirement("rollback_plan"), requirement("migration_dry_run")];
    const manual: ManualEvidenceInput[] = [
      { kind: "rollback_plan", content: "Revert the migration.", actor: "sam" }
    ];

    const next = addManualEvidence(current, manual);
    expect(next[0]).toMatchObject({
      kind: "rollback_plan",
      status: "provided",
      source: "manual_attestation",
      providedBy: "sam"
    });
    // Unmatched requirement is untouched.
    expect(next[1]).toEqual(requirement("migration_dry_run"));
  });

  it("marks approved evidence as approved and defaults approver to the actor", () => {
    const next = addManualEvidence([requirement("rollback_plan")], [
      { kind: "rollback_plan", content: "Revert.", actor: "sam", approved: true }
    ]);
    expect(next[0]).toMatchObject({
      status: "approved",
      approvedBy: "sam",
      approvedAt: expect.any(String)
    });
  });

  it("keeps unapproved evidence as provided without an approver", () => {
    const next = addManualEvidence([requirement("rollback_plan")], [
      { kind: "rollback_plan", content: "Revert.", actor: "sam" }
    ]);
    expect(next[0]).toMatchObject({ status: "provided" });
    expect(next[0]!.approvedBy).toBeUndefined();
    expect(next[0]!.approvedAt).toBeUndefined();
  });

  it("sources linked artifacts as linked_artifact", () => {
    const next = addManualEvidence([requirement("rollback_plan")], [
      {
        kind: "rollback_plan",
        content: "Revert.",
        actor: "sam",
        linkedArtifact: "https://artifacts.example.com/plan-1"
      }
    ]);
    expect(next[0]).toMatchObject({ source: "linked_artifact" });
  });

  it("leaves requirements unchanged for empty or whitespace-only content", () => {
    const current = [requirement("rollback_plan")];
    expect(addManualEvidence(current, [{ kind: "rollback_plan", content: "", actor: "sam" }])[0]).toEqual(
      requirement("rollback_plan")
    );
    expect(
      addManualEvidence(current, [{ kind: "rollback_plan", content: "   \n  ", actor: "sam" }])[0]
    ).toEqual(requirement("rollback_plan"));
  });

  it("leaves requirements unchanged when no manual evidence matches", () => {
    const current = [requirement("rollback_plan")];
    expect(addManualEvidence(current, [{ kind: "migration_dry_run", content: "x", actor: "sam" }])[0]).toEqual(
      requirement("rollback_plan")
    );
    expect(addManualEvidence(current, [])).toEqual(current);
  });

  it("preserves explicitly supplied providedAt, approvedBy, and approvedAt", () => {
    const next = addManualEvidence([requirement("rollback_plan")], [
      {
        kind: "rollback_plan",
        content: "Revert.",
        actor: "sam",
        approved: true,
        providedAt: "2026-07-01T00:00:00.000Z",
        approvedBy: "governance-admin",
        approvedAt: "2026-07-01T01:00:00.000Z"
      }
    ]);
    expect(next[0]).toMatchObject({
      providedAt: "2026-07-01T00:00:00.000Z",
      approvedBy: "governance-admin",
      approvedAt: "2026-07-01T01:00:00.000Z"
    });
  });

  it("redacts secrets from the content summary of manual evidence", () => {
    const next = addManualEvidence([requirement("rollback_plan")], [
      { kind: "rollback_plan", content: `Revert using ghp_${"1".repeat(36)}`, actor: "sam" }
    ]);
    expect(next[0]!.contentSummary).not.toContain("ghp_");
    expect(next[0]!.contentSummary).toContain("[REDACTED]");
  });
});
