import { describe, expect, it } from "vitest";
import type { PullRequestInput, VerifiedFact } from "@agentforge/core";
import { deterministicEvidenceDraftProvider } from "./evidence-provider.js";

const finding: VerifiedFact = {
  id: "fact_mig",
  type: "migration_added",
  source: "manifest_parser",
  path: "db/migration.sql",
  evidence: "new migration",
  confidence: "verified",
  severity: "high"
};

const pr: PullRequestInput = {
  repositoryFullName: "acme/service",
  pullRequestNumber: 1,
  title: "Migration",
  authorLogin: "sam",
  baseBranch: "main",
  headBranch: "feature/mig",
  headSha: "sha1",
  changedFiles: []
};

describe("deterministic evidence draft provider", () => {
  it("produces advisory-only, no-egress drafts", async () => {
    const draft = await deterministicEvidenceDraftProvider.draftEvidence({
      kind: "rollback_plan",
      finding,
      pr
    });
    expect(deterministicEvidenceDraftProvider.egress).toBe(false);
    expect(draft.advisoryOnly).toBe(true);
    expect(draft.egress).toBe(false);
    expect(draft.source).toBe("deterministic");
    expect(draft.content).toContain("Rollback Plan");
  });

  it("redacts secrets that appear in the source PR", async () => {
    const rawToken = `ghp_${"a".repeat(36)}`;
    const draft = await deterministicEvidenceDraftProvider.draftEvidence({
      kind: "rollback_plan",
      finding,
      pr: { ...pr, title: `Deploy with ${rawToken}` }
    });
    expect(draft.content).not.toContain(rawToken);
  });
});
