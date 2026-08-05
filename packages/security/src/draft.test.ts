import { describe, expect, it } from "vitest";
import type { PullRequestInput, VerifiedFact } from "@agentforge/core";
import { generateAiDraftForEvidence } from "./draft.js";

describe("generateAiDraftForEvidence", () => {
  const rawGithubToken = `ghp_secretToken${"1".repeat(26)}`;
  const rawAwsKey = `AKIA${"1234567890ABCDEF"}`;
  const mockPr: PullRequestInput = {
    repositoryFullName: "acme/service",
    pullRequestNumber: 42,
    title: "Add user accounts database migration",
    authorLogin: "alice",
    baseBranch: "main",
    headBranch: "feature-migration",
    headSha: "a9876b543210cdef1234567890abcdef12345678",
    body: `This PR introduces the new accounts table. API_KEY=${rawGithubToken}`,
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
      kind: "manual_attestation",
      finding,
      pr: {
        ...mockPr,
        title: `Deploy using ${rawAwsKey} key`
      }
    });

    // Ensure the AWS access key in title is redacted
    expect(draft).not.toContain(rawAwsKey);
    expect(draft).toContain("[REDACTED]");
  });

  it("generates a CI/CD workflow change rationale", () => {
    const finding: VerifiedFact = {
      id: "finding_ci",
      type: "ci_workflow_changed",
      source: "github_diff",
      path: ".github/workflows/deploy.yml",
      evidence: "workflow changed",
      confidence: "verified",
      severity: "high"
    };

    const draft = generateAiDraftForEvidence({
      kind: "ci_change_reason",
      finding,
      pr: mockPr
    });

    expect(draft).toContain("### CI/CD Workflow Change Rationale");
    expect(draft).toContain(".github/workflows/deploy.yml");
    expect(draft).toContain("Syntax Validation");
  });

  it("generates a deleted test justification", () => {
    const finding: VerifiedFact = {
      id: "finding_test",
      type: "test_deleted",
      source: "github_diff",
      path: "src/legacy.test.ts",
      evidence: "test removed",
      confidence: "verified",
      severity: "high"
    };

    const draft = generateAiDraftForEvidence({
      kind: "deleted_test_explanation",
      finding,
      pr: mockPr
    });

    expect(draft).toContain("### Deleted or Skipped Test Justification");
    expect(draft).toContain("src/legacy.test.ts");
    expect(draft).toContain("Superseded Coverage");
  });

  it("generates a security note that redacts secrets embedded in the finding type", () => {
    const finding: VerifiedFact = {
      id: "finding_sec",
      type: "secret_like_value_detected",
      source: "github_diff",
      path: "config/secrets.env",
      evidence: `detected ${rawGithubToken}`,
      confidence: "verified",
      severity: "critical"
    };

    const draft = generateAiDraftForEvidence({
      kind: "security_note",
      finding,
      pr: mockPr
    });

    expect(draft).toContain("### Compliance Advisory Security Note");
    expect(draft).toContain("secret_like_value_detected");
    expect(draft).toContain("config/secrets.env");
    // The finding type is interpolated into the draft; a secret embedded there
    // must still be redacted before the draft is returned.
    expect(draft).not.toContain(rawGithubToken);
  });

  it("falls back to safe defaults when PR metadata is missing", () => {
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
      // Deliberately omit path/evidence to exercise the fallback defaults.
      finding: { ...finding, path: undefined, evidence: undefined } as unknown as VerifiedFact,
      pr: {
        repositoryFullName: "acme/service",
        pullRequestNumber: 42,
        title: "",
        authorLogin: "alice",
        baseBranch: "",
        headBranch: "",
        headSha: "",
        changedFiles: []
      }
    });

    // Defaults are used instead of raw undefined leaking into the template.
    expect(draft).toContain("configured files");
    expect(draft).toContain("latest commit");
    expect(draft).toContain("main");
    expect(draft).not.toContain("undefined");
  });

  it("falls back to a safe default for missing finding evidence", () => {
    const finding = {
      id: "finding_dep",
      type: "dependency_added",
      source: "manifest_parser",
      path: "package.json",
      confidence: "verified",
      severity: "medium"
    } as unknown as VerifiedFact;

    const draft = generateAiDraftForEvidence({
      kind: "dependency_justification",
      finding,
      pr: mockPr
    });

    expect(draft).toContain("associated findings");
    expect(draft).not.toContain("undefined");
  });

  it("uses the manual attestation default branch for unknown kinds", () => {
    const finding = {
      id: "finding_unknown",
      type: "custom_finding_type",
      source: "custom",
      path: "src/custom.ts",
      evidence: "custom evidence",
      confidence: "verified",
      severity: "medium"
    } as unknown as VerifiedFact;

    const draft = generateAiDraftForEvidence({
      // @ts-expect-error - deliberately pass an unsupported kind to exercise the default branch
      kind: "unsupported_kind",
      finding,
      pr: mockPr
    });

    expect(draft).toContain("### Manual Attestation for custom_finding_type");
    expect(draft).toContain("custom evidence");
    expect(draft).toContain("PR #42");
  });
});
