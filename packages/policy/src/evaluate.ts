import type {
  EvidenceKind,
  EvidenceRequirement,
  FindingSeverity,
  PolicyHit,
  PolicyMode,
  PolicyResult,
  PullRequestInput,
  ReviewerRequirement,
  VerifiedFact
} from "@agentforge/core";
import { confidenceCanBlock } from "@agentforge/core";
import { deriveEvidenceRequirements } from "@agentforge/evidence";
import { routeReviewers } from "@agentforge/reviewers";
import { minimatch } from "minimatch";
import type { PolicyAction, PolicyConfig } from "./schema.js";
import { normalizeEvidenceKinds, strictestMode } from "./schema.js";

export function evaluateMergeGuard(
  pr: PullRequestInput,
  facts: VerifiedFact[],
  policy: PolicyConfig
): PolicyResult {
  const evaluatedAt = new Date().toISOString();
  if (!policyAppliesToPullRequest(pr, policy.agentforge.apply_to)) {
    return {
      mode: policy.agentforge.mode,
      status: "pass",
      policyVersion: buildPolicyVersion(policy),
      policyPackId: policy.policy_pack_id,
      policyPackVersion: policy.policy_pack_version,
      findings: [],
      requiredEvidence: [],
      requiredReviewers: [],
      explanation: ["Policy scope does not include this pull request."],
      evaluatedAt
    };
  }

  const policyHits = applyPolicyRules(facts, policy);
  const evidence = deriveEvidenceRequirements(policyHits, pr);
  const reviewers = routeReviewers(policyHits, pr);
  const mode = resolveEvaluationMode(policy.agentforge.mode, policyHits);

  const hasUnresolvedBlockingHit = policyHits.some((hit) =>
    isBlockingHitUnresolved(hit, evidence, reviewers)
  );
  const incompleteEvidence = evidence.some((item) => item.status !== "approved");
  const missingRequiredReview = reviewers.some(
    (item) => item.tier === "required" && !item.approved
  );
  const wouldBlock = hasUnresolvedBlockingHit || incompleteEvidence || missingRequiredReview;

  return {
    mode,
    status:
      mode === "observe"
        ? "pass"
        : mode === "warn" && wouldBlock
          ? "warn"
          : wouldBlock
            ? "block"
            : "pass",
    policyVersion: buildPolicyVersion(policy),
    policyPackId: policy.policy_pack_id,
    policyPackVersion: policy.policy_pack_version,
    findings: facts,
    requiredEvidence: evidence,
    requiredReviewers: reviewers,
    explanation: buildHumanReadableReasons(policyHits, evidence, reviewers, mode),
    evaluatedAt
  };
}

export function applyPolicyRules(facts: VerifiedFact[], policy: PolicyConfig): PolicyHit[] {
  return facts.flatMap((fact) => {
    return hitForFact(fact, policy);
  });
}

function hitForFact(fact: VerifiedFact, policy: PolicyConfig): PolicyHit[] {
  switch (fact.type) {
    case "sensitive_path_changed":
    case "ci_workflow_changed":
      return hitForSensitivePathFact(fact, policy);
    case "test_deleted":
      return hitForTestFact(fact, policy.tests.deleted_tests, "tests.deleted_tests");
    case "test_skipped":
      return hitForTestFact(fact, policy.tests.skipped_tests, "tests.skipped_tests");
    case "coverage_threshold_reduced":
      return hitForTestFact(
        fact,
        policy.tests.coverage_threshold_reduced,
        "tests.coverage_threshold_reduced"
      );
    case "suspicious_test_change":
      return hitForTestFact(
        fact,
        policy.tests.suspicious_test_change,
        "tests.suspicious_test_change"
      );
    case "dependency_added":
      return hitForDependencyFact(
        fact,
        policy.dependencies.new_package,
        "dependencies.new_package"
      );
    case "dependency_bumped":
      return hitForDependencyFact(
        fact,
        policy.dependencies.major_version_bump,
        "dependencies.major_version_bump"
      );
    case "migration_added":
      return [
        makeHit({
          ruleId: "database.migrations",
          fact,
          action: policy.database.migrations.action,
          severity: fact.severity ?? "high",
          mode: policy.database.migrations.mode,
          requiredEvidence: policy.database.migrations.required_evidence,
          requiredReviewers: policy.database.migrations.required_reviewers,
          explanation: `Database migration changed: ${fact.path ?? fact.evidence}.`
        })
      ];
    case "agent_signal_detected":
      return [
        makeHit({
          ruleId: "agent_assisted.signal",
          fact,
          action: "warn",
          severity: fact.severity ?? "medium",
          requiredEvidence: [],
          requiredReviewers: [],
          explanation: `Agent-assistance signal recorded: ${fact.evidence}.`
        })
      ];
    case "detection_coverage_truncated":
      return [
        makeHit({
          ruleId: "detection.coverage_truncated",
          fact,
          action: "suggest",
          severity: fact.severity ?? "low",
          requiredEvidence: [],
          requiredReviewers: [],
          explanation: `Detector coverage was truncated by a configured scanning limit: ${fact.evidence}.`
        })
      ];
    case "secret_like_value_detected":
      if (fact.metadata?.secretRisk === "low") {
        return [
          makeHit({
            ruleId: "security.secret_like_value.advisory",
            fact,
            action: "warn",
            severity: "low",
            requiredEvidence: [],
            requiredReviewers: [],
            explanation: "Low-risk secret-like placeholder or documentation example observed."
          })
        ];
      }
      return [
        makeHit({
          ruleId: "security.secret_like_value",
          fact,
          action: "block",
          severity: "critical",
          requiredEvidence: ["security_note"],
          requiredReviewers: ["security-team"],
          explanation: "Secret-like value detected and redacted in changed content."
        })
      ];
    default:
      return [];
  }
}

export function buildHumanReadableReasons(
  policyHits: PolicyHit[],
  evidence: Array<{ kind: string; status: string }>,
  reviewers: Array<{ reviewer: string; tier: string; approved: boolean }>,
  mode: PolicyMode
): string[] {
  const lines = policyHits.map((hit) => hit.explanation);
  const missingEvidence = evidence.filter((item) => item.status === "missing");
  const unapprovedEvidence = evidence.filter((item) => item.status === "provided");
  const pendingReviewers = reviewers.filter((item) => item.tier === "required" && !item.approved);

  for (const item of missingEvidence) {
    lines.push(`Required policy evidence is missing: ${humanize(item.kind)}.`);
  }
  for (const item of unapprovedEvidence) {
    lines.push(`Required policy evidence is awaiting approval: ${humanize(item.kind)}.`);
  }
  for (const reviewer of pendingReviewers) {
    lines.push(`Reviewer approval required: ${reviewer.reviewer}.`);
  }
  if (mode === "observe") {
    lines.push("Observe mode records findings and does not block merge.");
  } else if (mode === "warn") {
    lines.push("Warn mode records what would block in enforce mode and does not block merge.");
  } else if (mode === "optimize") {
    lines.push(
      missingEvidence.length > 0 || pendingReviewers.length > 0
        ? "Optimize mode keeps enforce controls active and highlights governance tuning work."
        : "Optimize mode keeps enforce controls active while surfacing improvement opportunities."
    );
  } else if (missingEvidence.length > 0 || pendingReviewers.length > 0) {
    lines.push("Enforce mode blocks merge until required evidence and approvals are complete.");
  }
  return [...new Set(lines)];
}

function hitForSensitivePathFact(fact: VerifiedFact, policy: PolicyConfig): PolicyHit[] {
  const ruleId = String(fact.metadata?.ruleId ?? fact.metadata?.group ?? "");
  const rule = policy.sensitive_paths[ruleId];
  if (!rule) {
    return [];
  }

  const action: PolicyAction = rule.action ?? "require_review";
  const label =
    fact.type === "ci_workflow_changed"
      ? "CI or deployment workflow changed"
      : "Sensitive path changed";

  return [
    makeHit({
      ruleId: `sensitive_paths.${ruleId}`,
      fact,
      action,
      severity: fact.severity ?? (fact.type === "ci_workflow_changed" ? "high" : "high"),
      mode: rule.mode,
      requiredEvidence: rule.required_evidence,
      requiredReviewers: rule.required_reviewers,
      explanation: `${label}: ${fact.path ?? fact.evidence}.`
    })
  ];
}

function isBlockingHitUnresolved(
  hit: PolicyHit,
  evidence: EvidenceRequirement[],
  reviewers: ReviewerRequirement[]
): boolean {
  if (hit.action !== "block" || !confidenceCanBlock(hit.finding.confidence)) {
    return false;
  }
  const relevantEvidence = evidence.filter(
    (item) =>
      item.requiredByFindingId === hit.finding.id && hit.requiredEvidence.includes(item.kind)
  );
  const relevantReviewers = reviewers.filter(
    (item) =>
      item.triggeredByFindingId === hit.finding.id &&
      hit.requiredReviewers.includes(item.reviewer) &&
      item.tier === "required"
  );
  if (hit.requiredEvidence.length === 0 && hit.requiredReviewers.length === 0) {
    return true;
  }
  if (hit.requiredEvidence.length > 0) {
    return (
      relevantEvidence.length !== hit.requiredEvidence.length ||
      relevantEvidence.some((item) => item.status !== "approved")
    );
  }
  if (hit.requiredReviewers.length > 0) {
    return (
      relevantReviewers.length !== hit.requiredReviewers.length ||
      relevantReviewers.some((item) => !item.approved)
    );
  }
  return false;
}

function hitForTestFact(
  fact: VerifiedFact,
  rule: {
    action: PolicyAction;
    required_evidence: EvidenceKind[];
    required_reviewers: string[];
    mode?: PolicyMode | undefined;
  },
  ruleId: string
): PolicyHit[] {
  const advisoryOnly = fact.confidence === "inferred";
  return [
    makeHit({
      ruleId,
      fact,
      action: advisoryOnly ? "warn" : rule.action,
      severity: fact.severity ?? (fact.type === "suspicious_test_change" ? "medium" : "high"),
      mode: rule.mode,
      requiredEvidence: advisoryOnly ? [] : rule.required_evidence,
      requiredReviewers: advisoryOnly ? [] : rule.required_reviewers,
      explanation:
        fact.type === "suspicious_test_change"
          ? `Detected common test-weakening pattern: ${fact.evidence}.`
          : `Test control finding: ${fact.evidence}.`
    })
  ];
}

function hitForDependencyFact(
  fact: VerifiedFact,
  rule: {
    action: PolicyAction;
    required_evidence: EvidenceKind[];
    required_reviewers: string[];
    mode?: PolicyMode | undefined;
  },
  ruleId: string
): PolicyHit[] {
  return [
    makeHit({
      ruleId,
      fact,
      action: rule.action,
      severity: fact.severity ?? "medium",
      mode: rule.mode,
      requiredEvidence: rule.required_evidence,
      requiredReviewers: rule.required_reviewers,
      explanation:
        fact.type === "dependency_added"
          ? `New dependency added: ${fact.evidence}.`
          : `Dependency version changed: ${fact.evidence}.`
    })
  ];
}

function makeHit(input: {
  ruleId: string;
  fact: VerifiedFact;
  action: PolicyAction;
  severity: FindingSeverity;
  mode?: PolicyMode | undefined;
  requiredEvidence: EvidenceKind[];
  requiredReviewers: string[];
  explanation: string;
}): PolicyHit {
  const action = confidenceCanBlock(input.fact.confidence) ? input.action : "warn";
  return {
    id: `hit:${input.ruleId}:${input.fact.id}`,
    ruleId: input.ruleId,
    finding: input.fact,
    action,
    severity: input.severity,
    mode: input.mode,
    requiredEvidence:
      action === "warn" || action === "suggest"
        ? []
        : normalizeEvidenceKinds(input.requiredEvidence),
    requiredReviewers:
      action === "warn" || action === "suggest" ? [] : [...new Set(input.requiredReviewers)],
    reviewerTier: action === "suggest" ? "suggested" : "required",
    explanation: input.explanation
  };
}

function resolveEvaluationMode(defaultMode: PolicyMode, hits: PolicyHit[]): PolicyMode {
  return strictestMode([
    defaultMode,
    ...(hits.map((hit) => hit.mode).filter(Boolean) as PolicyMode[])
  ]);
}

function policyAppliesToPullRequest(pr: PullRequestInput, scopes: string[] = []): boolean {
  if (scopes.length === 0 || scopes.includes("all_pull_requests")) {
    return true;
  }
  const labels = (pr.labels ?? []).map((label) => label.toLowerCase());
  return scopes.some((scope) => {
    const [kind, rawPattern] = splitScope(scope);
    const pattern = rawPattern.trim();
    if (!pattern) {
      return false;
    }
    if (kind === "repo" || kind === "repository") {
      return matchesScope(pr.repositoryFullName, pattern);
    }
    if (kind === "base" || kind === "base_branch") {
      return matchesScope(pr.baseBranch, pattern);
    }
    if (kind === "head" || kind === "head_branch" || kind === "branch") {
      return matchesScope(pr.headBranch, pattern);
    }
    if (kind === "label") {
      return labels.some((label) => matchesScope(label, pattern.toLowerCase()));
    }
    return matchesScope(pr.repositoryFullName, scope) || matchesScope(pr.baseBranch, scope);
  });
}

function splitScope(scope: string): [string, string] {
  const separator = scope.indexOf(":");
  if (separator === -1) {
    return ["", scope];
  }
  return [scope.slice(0, separator).trim().toLowerCase(), scope.slice(separator + 1)];
}

function matchesScope(value: string, pattern: string): boolean {
  return minimatch(value, pattern, { dot: true, nocase: true });
}

function buildPolicyVersion(policy: PolicyConfig): string {
  if (policy.policy_pack_id && policy.policy_pack_version) {
    return `${policy.policy_pack_id}@${policy.policy_pack_version}`;
  }
  return `schema-v${policy.version}`;
}

function humanize(value: string): string {
  return value.replace(/_/g, " ");
}
