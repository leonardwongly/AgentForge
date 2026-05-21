import { describe, expect, it } from "vitest";
import type { PullRequestInput, VerifiedFact } from "@agentforge/core";
import { generateAiDraftForEvidence } from "./draft.js";

describe("generateAiDraftForEvidence", () => {
  const mockPr: PullRequestInput = {
    repositoryFullName: "acme/service",
    pullRequestNumber: 42,
    title: "Add user accounts database migration",
    authorLogin: "alice",
    baseBranch: "main",
    headBranch: "feature-migration",
    headSha: "a9876b543210cdef1234567890abcdef12345678",
    body: "This PR introduces the new accounts table. API_KEY=ghp_secretToken12345678901234567890123456",
    changedFiles: []
  };

  it("generates a high-quality rollback plan for a database migration finding", () => {
    const finding: VerifiedFact = {
      id: "finding_mig",
      type: "migration_added",
      source: "manifest_parser",
      path: "db/migration.sql",
      evidence: "new migration init",
      confidence: "verified",
      severity: "high"
    };

    const draft = generateAiDraftForEvidence({
      kind: "rollback_plan",
      finding,
      pr: mockPr
    });

    expect(draft).toContain("### Rollback Plan for Database Migration");
    expect(draft).toContain("db/migration.sql");
    expect(draft).toContain("migrate down");
  });

  it("generates a high-quality migration dry run validation", () => {
    const finding: VerifiedFact = {
      id: "finding_mig",
      type: "migration_added",
      source: "manifest_parser",
      path: "db/migration.sql",
      evidence: "new migration init",
      confidence: "verified",
      severity: "high"
    };

    const draft = generateAiDraftForEvidence({
      kind: "migration_dry_run",
      finding,
      pr: mockPr
    });

    expect(draft).toContain("### Database Migration Dry Run Verification");
    expect(draft).toContain("db/migration.sql");
    expect(draft).toContain("Validated that all new tables, indexes");
  });

  it("generates a third-party dependency justification", () => {
    const finding: VerifiedFact = {
      id: "finding_dep",
      type: "dependency_added",
      source: "manifest_parser",
      path: "package.json",
      evidence: "lodash@4.17.21",
      confidence: "verified",
      severity: "medium"
    };

    const draft = generateAiDraftForEvidence({
      kind: "dependency_justification",
      finding,
      pr: mockPr
    });

    expect(draft).toContain("### Third-Party Dependency Justification");
    expect(draft).toContain("lodash@4.17.21");
    expect(draft).toContain("MIT, Apache-2.0, or BSD");
  });

  it("redacts secrets from target PR details inside the prompt context", () => {
    const finding: VerifiedFact = {
      id: "finding_mig",
      type: "migration_added",
      source: "manifest_parser",
      path: "db/migration.sql",
      evidence: "new migration init",
      confidence: "verified",
      severity: "high"
    };

    const draft = generateAiDraftForEvidence({
      kind: "rollback_plan",
      finding,
      pr: {
        ...mockPr,
        title: "Deploy using AKIA1234567890ABCDEF key"
      }
    });

    // Ensure the AWS access key in title is redacted
    expect(draft).not.toContain("AKIA1234567890ABCDEF");
    expect(draft).toContain("[REDACTED]");
  });
});
