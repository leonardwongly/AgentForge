import { describe, expect, it } from "vitest";
import type {
  EvidenceRequirement,
  ManualEvidenceInput,
  PolicyHit,
  PullRequestInput,
  VerifiedFact
} from "@agentforge/core";
import { addManualEvidence, deriveEvidenceRequirements, findEvidenceInPrBody } from "./index.js";

const finding: VerifiedFact = {
  id: "finding-evidence-boundary",
  type: "migration_added",
  source: "github_diff",
  evidence: "migration changed",
  confidence: "verified"
};

const hit: PolicyHit = {
  id: "hit-evidence-boundary",
  ruleId: "database.migrations",
  finding,
  action: "block",
  severity: "high",
  requiredEvidence: ["rollback_plan"],
  requiredReviewers: [],
  explanation: "Rollback plan required."
};

const requirement: EvidenceRequirement = {
  id: "evidence:finding-evidence-boundary:rollback_plan",
  kind: "rollback_plan",
  status: "missing",
  requiredByFindingId: finding.id
};

const pr = (overrides: Partial<PullRequestInput> = {}): PullRequestInput => ({
  repositoryFullName: "acme/app",
  pullRequestNumber: 1,
  title: "Migration",
  authorLogin: "sam",
  baseBranch: "main",
  headBranch: "migration",
  headSha: "head",
  changedFiles: [],
  ...overrides
});

describe("evidence parser adversarial inputs", () => {
  it("does not let a blank duplicate suppress a later valid manual attestation", () => {
    const manual: ManualEvidenceInput[] = [
      { kind: "rollback_plan", content: "   ", actor: "attacker" },
      { kind: "rollback_plan", content: "Revert the migration.", actor: "sam" }
    ];

    const [updated] = addManualEvidence([requirement], manual);

    expect(updated).toMatchObject({
      status: "provided",
      providedBy: "sam",
      contentSummary: "Revert the migration."
    });
  });

  it("ignores non-string PR bodies at the runtime boundary", () => {
    expect(findEvidenceInPrBody("rollback_plan", null as unknown as string)).toBeUndefined();
    expect(
      findEvidenceInPrBody("rollback_plan", { content: "secret" } as unknown as string)
    ).toBeUndefined();
  });

  it("ignores malformed manual evidence content without throwing", () => {
    const malformed = [{ kind: "rollback_plan", content: null, actor: "attacker" }];

    expect(() =>
      deriveEvidenceRequirements(
        [hit],
        pr({ manualEvidence: malformed as unknown as ManualEvidenceInput[] })
      )
    ).not.toThrow();
    expect(
      deriveEvidenceRequirements(
        [hit],
        pr({ manualEvidence: malformed as unknown as ManualEvidenceInput[] })
      )[0]
    ).toMatchObject({ status: "missing" });
  });

  it("leaves requirements unchanged for a malformed manual evidence collection", () => {
    expect(addManualEvidence([requirement], null as unknown as ManualEvidenceInput[])).toEqual([
      requirement
    ]);
  });
});
