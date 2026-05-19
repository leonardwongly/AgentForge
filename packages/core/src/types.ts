export type PolicyMode = "observe" | "warn" | "enforce" | "optimize";

export type FindingSeverity = "critical" | "high" | "medium" | "low";

export type FactConfidence = "verified" | "observed" | "inferred" | "attested";

export type VerifiedFact = {
  id: string;
  type:
    | "sensitive_path_changed"
    | "ci_workflow_changed"
    | "test_deleted"
    | "test_skipped"
    | "coverage_threshold_reduced"
    | "suspicious_test_change"
    | "dependency_added"
    | "dependency_bumped"
    | "migration_added"
    | "agent_signal_detected"
    | "secret_like_value_detected";
  source:
    | "github_diff"
    | "github_metadata"
    | "ci_status"
    | "policy_config"
    | "manifest_parser"
    | "user_attestation";
  path?: string | undefined;
  evidence: string;
  confidence: FactConfidence;
  severity?: FindingSeverity | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type EvidenceRequirement = {
  id: string;
  kind:
    | "rollback_plan"
    | "migration_dry_run"
    | "dependency_justification"
    | "deleted_test_explanation"
    | "benchmark_before_after"
    | "security_note"
    | "ci_change_reason"
    | "manual_attestation";
  status: "missing" | "provided" | "approved" | "rejected";
  source?:
    | "pr_body"
    | "review"
    | "attachment"
    | "manual_attestation"
    | "linked_artifact"
    | undefined;
  requiredByFindingId: string;
  providedBy?: string | undefined;
  providedAt?: string | undefined;
  approvedBy?: string | undefined;
  approvedAt?: string | undefined;
  contentSummary?: string | undefined;
};

export type ReviewerRequirement = {
  id: string;
  reviewer: string;
  reviewerType: "user" | "team";
  tier: "required" | "conditional" | "suggested";
  reason: string;
  triggeredByFindingId: string;
  clearsWhen?: "path_removed" | "evidence_approved" | "manual_clear" | undefined;
  approved: boolean;
  approvedBy?: string | undefined;
  approvedAt?: string | undefined;
};

export type PolicyResult = {
  mode: PolicyMode;
  status: "pass" | "warn" | "block";
  policyVersion: string;
  policyPackId?: string | undefined;
  policyPackVersion?: string | undefined;
  findings: VerifiedFact[];
  requiredEvidence: EvidenceRequirement[];
  requiredReviewers: ReviewerRequirement[];
  explanation: string[];
  evaluatedAt: string;
};

export type ChangeControlRecord = {
  id: string;
  organizationId: string;
  repositoryId: string;
  repositoryFullName: string;
  pullRequestNumber: number;
  headSha: string;
  baseBranch: string;
  mode: PolicyMode;
  policyVersion: string;
  policyPackId?: string | undefined;
  policyPackVersion?: string | undefined;
  verifiedFindings: VerifiedFact[];
  requiredEvidence: EvidenceRequirement[];
  requiredReviewers: ReviewerRequirement[];
  checkStatus: "pass" | "warn" | "block";
  lifecycle:
    | "opened"
    | "evaluated"
    | "blocked"
    | "warned"
    | "passed"
    | "overridden"
    | "merged"
    | "closed";
  decision?: {
    status:
      | "passed"
      | "blocked"
      | "override_approved"
      | "merged"
      | "merged_after_override"
      | "closed_without_merge";
    decidedAt?: string | undefined;
    decidedBy?: string | undefined;
    overrideBy?: string | undefined;
    overrideReason?: string | undefined;
  };
  createdAt: string;
  updatedAt: string;
};

export type PullRequestReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";

export type PullRequestReview = {
  reviewer: string;
  reviewerType?: "user" | "team" | undefined;
  teamSlugs?: string[] | undefined;
  teamVerification?:
    | {
        status: "verified" | "unavailable" | "failed";
        reason: string;
        checkedTeamSlugs: string[];
      }
    | undefined;
  state: PullRequestReviewState;
  submittedAt: string;
};

export type ManualEvidenceInput = {
  kind: EvidenceRequirement["kind"];
  content: string;
  linkedArtifact?: string | undefined;
  actor: string;
  approved?: boolean;
  approvedBy?: string | undefined;
  approvedAt?: string | undefined;
  providedAt?: string | undefined;
};

export type PullRequestContext = {
  repositoryFullName: string;
  pullRequestNumber: number;
  title: string;
  authorLogin: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  body?: string | undefined;
  labels?: string[] | undefined;
  commits?:
    | Array<{
        sha: string;
        message: string;
        authorLogin?: string | undefined;
      }>
    | undefined;
  reviews?: PullRequestReview[] | undefined;
  manualEvidence?: ManualEvidenceInput[] | undefined;
  markedAgentAssistedBy?: string | undefined;
};

export type ChangedFile = {
  filename: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
  previousFilename?: string | undefined;
  additions?: number | undefined;
  deletions?: number | undefined;
  changes?: number | undefined;
  patch?: string | undefined;
  previousContent?: string | undefined;
  currentContent?: string | undefined;
};

export type PullRequestInput = PullRequestContext & {
  changedFiles: ChangedFile[];
};

export type EvidenceKind = EvidenceRequirement["kind"];

export type ReviewerTier = ReviewerRequirement["tier"];

export type PolicyHit = {
  id: string;
  ruleId: string;
  finding: VerifiedFact;
  action: "block" | "require_review" | "warn" | "suggest";
  severity: FindingSeverity;
  mode?: PolicyMode | undefined;
  requiredEvidence: EvidenceKind[];
  requiredReviewers: string[];
  reviewerTier?: ReviewerTier | undefined;
  explanation: string;
};

export type DataRetentionSettings = {
  sourceCodeStorage: boolean;
  fullDiffRetention: "disabled" | "7d" | "30d" | "custom";
  redactSecrets: boolean;
  llmFeatures: boolean;
  auditRecordRetention: string;
};

export type AuditEventAction =
  | "policy_changed"
  | "override_created"
  | "evidence_provided"
  | "evidence_approved"
  | "evidence_rejected"
  | "reviewer_approved"
  | "record_reevaluated"
  | "check_published"
  | "record_exported"
  | "retention_changed"
  | "repository_settings_changed"
  | "owner_mapping_changed";

export type AuditEventRecord = {
  id: string;
  organizationId: string;
  repositoryId?: string | undefined;
  pullRequestId?: string | undefined;
  actor: string;
  action: AuditEventAction;
  targetType: string;
  targetId: string;
  metadataJson?: Record<string, unknown> | undefined;
  createdAt: string;
};

export type OverridePolicy = {
  allowedRoles: string[];
  requireReason: boolean;
  visibleInPr: boolean;
  audit: boolean;
};

export type OverrideInput = {
  actor: string;
  actorRole: string;
  reason?: string | undefined;
  scope: "pr" | "finding" | "evidence" | "reviewer";
  visibleInPr?: boolean | undefined;
  createdAt?: string | undefined;
};

export type OverrideRecord = {
  id: string;
  pullRequestId: string;
  evaluationId?: string | undefined;
  actor: string;
  actorRole: string;
  reason: string;
  scope: OverrideInput["scope"];
  visibleInPr: boolean;
  policyVersion: string;
  createdAt: string;
};

export type AdvisoryFinding = {
  id: string;
  summary: string;
  explanation: string;
  createdAt: string;
  source: "llm";
  blocking: false;
};

export type AdvisoryResult = {
  enabled: boolean;
  advisoryOnly: true;
  promptGenerated: boolean;
  deterministicFindingIds: string[];
  findings: AdvisoryFinding[];
};

export const BLOCKABLE_CONFIDENCES: ReadonlySet<FactConfidence> = new Set(["verified", "observed"]);

export function confidenceCanBlock(confidence: FactConfidence): boolean {
  return BLOCKABLE_CONFIDENCES.has(confidence);
}

export function policyModeAllowsBlocking(mode: PolicyMode): boolean {
  return mode === "enforce" || mode === "optimize";
}
