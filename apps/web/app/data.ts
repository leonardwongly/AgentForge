import type { ChangeControlRecord } from "@agentforge/core";

export const demoRecords: ChangeControlRecord[] = [
  {
    id: "ccr_demo",
    organizationId: "org_local",
    repositoryId: "repo_local",
    repositoryFullName: "acme/payments",
    pullRequestNumber: 1842,
    headSha: "b8f7c1a",
    baseBranch: "main",
    mode: "enforce",
    policyVersion: "fintech@1.0.0",
    policyPackId: "fintech",
    policyPackVersion: "1.0.0",
    verifiedFindings: [
      {
        id: "fact_billing",
        type: "sensitive_path_changed",
        source: "github_diff",
        path: "src/billing/checkout.ts",
        evidence: "Changed path matched billing policy: src/billing/checkout.ts",
        confidence: "verified",
        severity: "high"
      },
      {
        id: "fact_agent",
        type: "agent_signal_detected",
        source: "github_metadata",
        evidence: "Branch matched configured agent-assistance pattern: codex/update-checkout",
        confidence: "observed",
        severity: "medium"
      }
    ],
    requiredEvidence: [
      {
        id: "evidence:fact_billing:rollback_plan",
        kind: "rollback_plan",
        status: "missing",
        requiredByFindingId: "fact_billing"
      }
    ],
    requiredReviewers: [
      {
        id: "reviewer:fact_billing:billing-owner",
        reviewer: "billing-owner",
        reviewerType: "team",
        tier: "required",
        reason: "Sensitive path changed: src/billing/checkout.ts.",
        triggeredByFindingId: "fact_billing",
        approved: false
      }
    ],
    checkStatus: "block",
    lifecycle: "blocked",
    decision: {
      status: "blocked",
      decidedAt: "2026-05-12T14:30:00.000Z"
    },
    createdAt: "2026-05-12T14:30:00.000Z",
    updatedAt: "2026-05-12T14:30:00.000Z"
  },
  {
    id: "ccr_warn",
    organizationId: "org_local",
    repositoryId: "repo_local",
    repositoryFullName: "acme/platform",
    pullRequestNumber: 913,
    headSha: "a1f3d92",
    baseBranch: "main",
    mode: "warn",
    policyVersion: "platform-engineering@1.0.0",
    policyPackId: "platform-engineering",
    policyPackVersion: "1.0.0",
    verifiedFindings: [
      {
        id: "fact_ci",
        type: "ci_workflow_changed",
        source: "github_diff",
        path: ".github/workflows/deploy.yml",
        evidence: "CI or deployment path changed: .github/workflows/deploy.yml",
        confidence: "verified",
        severity: "high"
      }
    ],
    requiredEvidence: [
      {
        id: "evidence:fact_ci:ci_change_reason",
        kind: "ci_change_reason",
        status: "provided",
        source: "pr_body",
        requiredByFindingId: "fact_ci",
        providedBy: "mira",
        providedAt: "2026-05-12T13:00:00.000Z",
        contentSummary: "Deploy job now separates staging and production approvals."
      }
    ],
    requiredReviewers: [
      {
        id: "reviewer:fact_ci:platform-team",
        reviewer: "platform-team",
        reviewerType: "team",
        tier: "required",
        reason: "CI or deployment workflow changed.",
        triggeredByFindingId: "fact_ci",
        approved: false
      }
    ],
    checkStatus: "warn",
    lifecycle: "warned",
    decision: {
      status: "passed",
      decidedAt: "2026-05-12T13:10:00.000Z"
    },
    createdAt: "2026-05-12T13:00:00.000Z",
    updatedAt: "2026-05-12T13:10:00.000Z"
  }
];

export const policyYaml = `version: 1
policy_pack_id: fintech
policy_pack_version: 1.0.0
agentforge:
  mode: warn
  apply_to:
    - all_pull_requests
sensitive_paths:
  billing:
    paths:
      - "src/billing/**"
      - "src/checkout/**"
      - "services/payments/**"
    required_reviewers:
      - "billing-owner"
    required_evidence:
      - "rollback_plan"
  auth:
    paths:
      - "src/auth/**"
      - "services/identity/**"
    required_reviewers:
      - "security-team"
    required_evidence:
      - "security_note"
tests:
  deleted_tests:
    action: block
    required_evidence:
      - "deleted_test_explanation"
dependencies:
  new_package:
    action: require_review
    required_reviewers:
      - "security-team"
    required_evidence:
      - "dependency_justification"
database:
  migrations:
    required_reviewers:
      - "database-owner"
    required_evidence:
      - "rollback_plan"
      - "migration_dry_run"`;
