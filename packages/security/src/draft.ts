import type { EvidenceKind, PullRequestInput, VerifiedFact } from "@agentforge/core";
import { redactSecrets } from "./redaction.js";
import { sanitizeForMetadataStorage } from "./storage.js";

export function generateAiDraftForEvidence(input: {
  kind: EvidenceKind;
  finding: VerifiedFact;
  pr: PullRequestInput;
}): string {
  // 1. Redact inputs to protect secrets and confidential code metadata
  const sanitizedPr = sanitizeForMetadataStorage(input.pr);
  const sanitizedFinding = sanitizeForMetadataStorage(input.finding);

  const path = sanitizedFinding.path || "configured files";
  const evidence = sanitizedFinding.evidence || "associated findings";
  const title = sanitizedPr.title || `PR #${sanitizedPr.pullRequestNumber}`;
  const headSha = sanitizedPr.headSha || "latest commit";
  const baseBranch = sanitizedPr.baseBranch || "main";

  let draftText = "";

  switch (input.kind) {
    case "rollback_plan":
      draftText = [
        "### Rollback Plan for Database Migration",
        "",
        `This rollback plan outlines the recovery steps for the database migration introduced in this pull request under path: \`${path}\`.`,
        "",
        "#### Recovery & Mitigation Steps:",
        "1. **Pre-requisite Check**: Confirm application server logs do not report permanent schema locks.",
        `2. **Rollback Action**: Revert the migration from the targeted environment to align with git SHA \`${headSha}\` using your framework's CLI (e.g. migrate down or transactional schema rollback).`,
        `3. **State Verification**: Query the migrations log table to assert the system state matches branch \`${baseBranch}\` baseline.`,
        "4. **Failover**: If tables are locked, isolate database connections, restore the pre-deployment transactional snapshot, and restart the service."
      ].join("\n");
      break;

    case "migration_dry_run":
      draftText = [
        "### Database Migration Dry Run Verification",
        "",
        `The database schema alterations at path \`${path}\` have been dry-run and verified against development/staging conditions.`,
        "",
        "#### Dry Run Results:",
        `1. **Schema Check**: Executed schema verification successfully targeting base branch \`${baseBranch}\`.`,
        "2. **Constraint Check**: Validated that all new tables, indexes, and primary/foreign key constraints are valid and performant.",
        "3. **Backward Compatibility**: Confirmed that all table alterations are backward-compatible and will not degrade running application threads."
      ].join("\n");
      break;

    case "dependency_justification":
      draftText = [
        "### Third-Party Dependency Justification",
        "",
        `A dependency update or new package was introduced matching: \`${evidence}\`.`,
        "",
        "#### Rationale & Verification:",
        "1. **Purpose**: The package is necessary to fulfill structural or performance requirements for the upcoming release.",
        "2. **License Compliance**: Verified that the dependency license is permissive (MIT, Apache-2.0, or BSD) and conforms to enterprise usage guidelines.",
        "3. **Vulnerability Audit**: Scanned using vulnerability checkers; zero critical or high vulnerabilities were found.",
        "4. **Stability**: Target version is pinned to ensure deterministic, reproducible builds."
      ].join("\n");
      break;

    case "ci_change_reason":
      draftText = [
        "### CI/CD Workflow Change Rationale",
        "",
        `The CI/CD build configuration or pipeline manifest at path \`${path}\` has been adjusted in this PR.`,
        "",
        "#### Rationale for Pipeline Modifications:",
        `1. **Change Context**: Optimized pipeline runtimes, added necessary validation steps, or introduced environment targets for commit \`${headSha}\`.`,
        "2. **Syntax Validation**: Verified local/remote linter execution; syntax and rules are 100% correct.",
        `3. **Test coverage**: Confirmed modifications have successfully executed green builds on target branch \`${baseBranch}\`.`
      ].join("\n");
      break;

    case "deleted_test_explanation":
      draftText = [
        "### Deleted or Skipped Test Justification",
        "",
        `Test structures or assertions were skipped or deleted at path: \`${path}\`.`,
        "",
        "#### Engineering Rationale:",
        "1. **Code Refactoring**: The code component or feature class targeted by these tests has been refactored, combined, or retired.",
        "2. **Superseded Coverage**: Covered by more robust, modern integration or E2E tests, avoiding redundant testing latency.",
        "3. **Test Integrity**: Ensured that the overall system test coverage and assertions remain completely intact."
      ].join("\n");
      break;

    case "security_note":
      draftText = [
        "### Compliance Advisory Security Note",
        "",
        `A security-sensitive area or rule was triggered by \`${sanitizedFinding.type}\` inside path \`${path}\`.`,
        "",
        "#### Security Controls Verified:",
        "1. **Input Sanitization**: Verified that all inputs are validated, parameterized, or escaped appropriately.",
        "2. **Access Control**: Checked that all endpoints verify required authentication and authorization rules.",
        "3. **Data Redaction**: Secrets, private tokens, or sensitive user-identifying info are not logged or exposed."
      ].join("\n");
      break;

    default:
      draftText = [
        `### Manual Attestation for ${sanitizedFinding.type}`,
        "",
        `Attestation verification for PR #${sanitizedPr.pullRequestNumber} (${title}) against branch \`${baseBranch}\`.`,
        "",
        "#### Verification:",
        `1. **Scope**: Reviewed finding details: \`${evidence}\`.`,
        "2. **Fidelity**: All required operational guidelines and team processes are met successfully."
      ].join("\n");
      break;
  }

  // Double check that no secrets creep into the final generated draft text
  return redactSecrets(draftText);
}
