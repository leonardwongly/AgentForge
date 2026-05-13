import type {
  ChangeControlRecord,
  EvidenceRequirement,
  ReviewerRequirement,
  VerifiedFact
} from "@agentforge/core";

export type DashboardRecord = {
  record: ChangeControlRecord;
  title: string;
  author: string;
  githubUrl: string;
  team: "Billing" | "Platform" | "Security" | "Database" | "Maintainers";
  age: string;
  override?: {
    actor: string;
    actorRole: string;
    reason: string;
    scope: string;
    createdAt: string;
    visibleInPr: boolean;
  };
  checkHistory: Array<{
    status: ChangeControlRecord["checkStatus"];
    conclusion: "success" | "neutral" | "failure";
    publishedAt: string;
    message: string;
  }>;
};

export type DashboardDataSource = "api" | "empty" | "demo" | "unavailable";

export type DashboardData = {
  records: DashboardRecord[];
  source: DashboardDataSource;
  message: string;
};

export type RepositoryOption = {
  id: string;
  fullName: string;
  enabled: boolean;
  mode: string;
  currentPolicyPack: string;
};

const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:4000";
const demoMode = process.env.DEMO_MODE === "true" || process.env.NEXT_PUBLIC_DEMO_MODE === "true";

const now = "2026-05-13T09:00:00.000Z";

export const dashboardRecords: DashboardRecord[] = [
  {
    title: "Checkout validation and release control updates",
    author: "mira",
    githubUrl: "https://github.com/acme/payments/pull/1842",
    team: "Billing",
    age: "3h 18m",
    checkHistory: [
      {
        status: "block",
        conclusion: "failure",
        publishedAt: "2026-05-13T05:42:00.000Z",
        message: "Merge Guard blocked merge because required evidence is missing."
      }
    ],
    record: {
      id: "ccr_demo",
      organizationId: "org_local",
      repositoryId: "repo_payments",
      repositoryFullName: "acme/payments",
      pullRequestNumber: 1842,
      headSha: "b8f7c1a",
      baseBranch: "main",
      mode: "enforce",
      policyVersion: "fintech@1.4.0",
      policyPackId: "fintech",
      policyPackVersion: "1.4.0",
      verifiedFindings: [
        fact({
          id: "fact_billing",
          type: "sensitive_path_changed",
          path: "src/billing/checkout.ts",
          evidence: "Changed path matched billing policy: src/billing/checkout.ts",
          severity: "high",
          metadata: { ruleId: "billing" }
        }),
        fact({
          id: "fact_agent",
          type: "agent_signal_detected",
          source: "github_metadata",
          evidence: "Branch matched configured agent-assistance pattern: codex/update-checkout",
          confidence: "observed",
          severity: "medium",
          metadata: { signal: "branch_pattern" }
        })
      ],
      requiredEvidence: [
        evidence("fact_billing", "rollback_plan", "missing"),
        evidence("fact_billing", "manual_attestation", "provided", {
          source: "manual_attestation",
          providedBy: "mira",
          providedAt: "2026-05-13T06:12:00.000Z",
          contentSummary: "Confirmed checkout path was intentionally changed."
        })
      ],
      requiredReviewers: [
        reviewer("fact_billing", "billing-owner", "team", "required", false, {
          reason: "Sensitive path changed: src/billing/checkout.ts."
        })
      ],
      checkStatus: "block",
      lifecycle: "blocked",
      decision: {
        status: "blocked",
        decidedAt: "2026-05-13T05:42:00.000Z"
      },
      createdAt: "2026-05-13T05:42:00.000Z",
      updatedAt: "2026-05-13T06:12:00.000Z"
    }
  },
  {
    title: "Add ledger reconciliation migration",
    author: "sam",
    githubUrl: "https://github.com/acme/payments/pull/1845",
    team: "Database",
    age: "1h 04m",
    checkHistory: [
      {
        status: "block",
        conclusion: "failure",
        publishedAt: "2026-05-13T07:56:00.000Z",
        message: "Merge Guard blocked merge because migration dry run evidence is missing."
      }
    ],
    record: {
      id: "ccr_migration",
      organizationId: "org_local",
      repositoryId: "repo_payments",
      repositoryFullName: "acme/payments",
      pullRequestNumber: 1845,
      headSha: "ef98b41",
      baseBranch: "main",
      mode: "enforce",
      policyVersion: "fintech@1.4.0",
      policyPackId: "fintech",
      policyPackVersion: "1.4.0",
      verifiedFindings: [
        fact({
          id: "fact_migration",
          type: "migration_added",
          path: "prisma/migrations/202605130742_add_ledger_reconciliation/migration.sql",
          evidence:
            "Database migration added: prisma/migrations/202605130742_add_ledger_reconciliation/migration.sql",
          severity: "high"
        })
      ],
      requiredEvidence: [
        evidence("fact_migration", "rollback_plan", "provided", {
          source: "pr_body",
          providedBy: "sam",
          providedAt: "2026-05-13T08:05:00.000Z",
          contentSummary: "Rollback plan references reverse migration and backup snapshot."
        }),
        evidence("fact_migration", "migration_dry_run", "missing")
      ],
      requiredReviewers: [
        reviewer("fact_migration", "database-owner", "team", "required", false, {
          reason: "Database migration added."
        })
      ],
      checkStatus: "block",
      lifecycle: "blocked",
      decision: {
        status: "blocked",
        decidedAt: "2026-05-13T07:56:00.000Z"
      },
      createdAt: "2026-05-13T07:56:00.000Z",
      updatedAt: "2026-05-13T08:05:00.000Z"
    }
  },
  {
    title: "Separate staging and production deploy approvals",
    author: "alex",
    githubUrl: "https://github.com/acme/platform/pull/913",
    team: "Platform",
    age: "5h 46m",
    checkHistory: [
      {
        status: "warn",
        conclusion: "neutral",
        publishedAt: "2026-05-13T03:14:00.000Z",
        message: "Non-blocking warning; this shows what would block in enforce mode."
      }
    ],
    record: {
      id: "ccr_warn",
      organizationId: "org_local",
      repositoryId: "repo_platform",
      repositoryFullName: "acme/platform",
      pullRequestNumber: 913,
      headSha: "a1f3d92",
      baseBranch: "main",
      mode: "warn",
      policyVersion: "platform-engineering@1.2.0",
      policyPackId: "platform-engineering",
      policyPackVersion: "1.2.0",
      verifiedFindings: [
        fact({
          id: "fact_ci",
          type: "ci_workflow_changed",
          path: ".github/workflows/deploy.yml",
          evidence: "CI or deployment path changed: .github/workflows/deploy.yml",
          severity: "high",
          metadata: { ruleId: "ci_and_deploy" }
        })
      ],
      requiredEvidence: [
        evidence("fact_ci", "ci_change_reason", "provided", {
          source: "pr_body",
          providedBy: "alex",
          providedAt: "2026-05-13T03:22:00.000Z",
          contentSummary: "Deploy job now separates staging and production approvals."
        })
      ],
      requiredReviewers: [
        reviewer("fact_ci", "platform-team", "team", "required", false, {
          reason: "CI or deployment workflow changed."
        })
      ],
      checkStatus: "warn",
      lifecycle: "warned",
      decision: {
        status: "passed",
        decidedAt: "2026-05-13T03:14:00.000Z"
      },
      createdAt: "2026-05-13T03:14:00.000Z",
      updatedAt: "2026-05-13T03:22:00.000Z"
    }
  },
  {
    title: "Rotate identity session cookie settings",
    author: "jules",
    githubUrl: "https://github.com/acme/identity/pull/477",
    team: "Security",
    age: "1d 02h",
    override: {
      actor: "nora",
      actorRole: "platform_admin",
      reason: "Emergency release window approved after security note and follow-up ticket.",
      scope: "pr",
      createdAt: "2026-05-12T10:15:00.000Z",
      visibleInPr: true
    },
    checkHistory: [
      {
        status: "block",
        conclusion: "failure",
        publishedAt: "2026-05-12T09:48:00.000Z",
        message: "Merge Guard blocked merge because reviewer approval was pending."
      },
      {
        status: "pass",
        conclusion: "success",
        publishedAt: "2026-05-12T10:15:00.000Z",
        message: "Authorized override recorded."
      }
    ],
    record: {
      id: "ccr_override",
      organizationId: "org_local",
      repositoryId: "repo_identity",
      repositoryFullName: "acme/identity",
      pullRequestNumber: 477,
      headSha: "71d0fc3",
      baseBranch: "main",
      mode: "enforce",
      policyVersion: "healthcare-regulated@1.1.0",
      policyPackId: "healthcare-regulated",
      policyPackVersion: "1.1.0",
      verifiedFindings: [
        fact({
          id: "fact_auth",
          type: "sensitive_path_changed",
          path: "src/auth/session.ts",
          evidence: "Changed path matched auth policy: src/auth/session.ts",
          severity: "critical",
          metadata: { ruleId: "auth" }
        })
      ],
      requiredEvidence: [
        evidence("fact_auth", "security_note", "approved", {
          source: "review",
          providedBy: "jules",
          providedAt: "2026-05-12T09:54:00.000Z",
          approvedBy: "security-team",
          approvedAt: "2026-05-12T10:08:00.000Z",
          contentSummary: "Session cookie flags tightened and rollout validated in staging."
        })
      ],
      requiredReviewers: [
        reviewer("fact_auth", "security-team", "team", "required", false, {
          reason: "Auth path changed: src/auth/session.ts.",
          clearsWhen: "manual_clear"
        })
      ],
      checkStatus: "pass",
      lifecycle: "overridden",
      decision: {
        status: "merged_after_override",
        decidedAt: "2026-05-12T10:15:00.000Z",
        decidedBy: "nora",
        overrideBy: "nora",
        overrideReason:
          "Emergency release window approved after security note and follow-up ticket."
      },
      createdAt: "2026-05-12T09:48:00.000Z",
      updatedAt: "2026-05-12T10:15:00.000Z"
    }
  },
  {
    title: "Add cache client for invoice summaries",
    author: "lee",
    githubUrl: "https://github.com/acme/payments/pull/1838",
    team: "Billing",
    age: "2d 04h",
    checkHistory: [
      {
        status: "warn",
        conclusion: "neutral",
        publishedAt: "2026-05-11T07:10:00.000Z",
        message: "Non-blocking warning; dependency justification was required."
      }
    ],
    record: {
      id: "ccr_dependency",
      organizationId: "org_local",
      repositoryId: "repo_payments",
      repositoryFullName: "acme/payments",
      pullRequestNumber: 1838,
      headSha: "9aa182e",
      baseBranch: "main",
      mode: "warn",
      policyVersion: "fintech@1.4.0",
      policyPackId: "fintech",
      policyPackVersion: "1.4.0",
      verifiedFindings: [
        fact({
          id: "fact_dependency",
          type: "dependency_added",
          source: "manifest_parser",
          path: "package.json",
          evidence: "New dependency added: fast-cache-lib",
          confidence: "observed",
          severity: "medium",
          metadata: { packageName: "fast-cache-lib" }
        })
      ],
      requiredEvidence: [
        evidence("fact_dependency", "dependency_justification", "approved", {
          source: "pr_body",
          providedBy: "lee",
          providedAt: "2026-05-11T07:22:00.000Z",
          approvedBy: "security-team",
          approvedAt: "2026-05-11T08:02:00.000Z",
          contentSummary:
            "Dependency is scoped to invoice summary cache and has no native install step."
        })
      ],
      requiredReviewers: [
        reviewer("fact_dependency", "security-team", "team", "suggested", true, {
          reason: "New dependency added."
        })
      ],
      checkStatus: "warn",
      lifecycle: "warned",
      decision: {
        status: "passed",
        decidedAt: "2026-05-11T08:02:00.000Z",
        decidedBy: "security-team"
      },
      createdAt: "2026-05-11T07:10:00.000Z",
      updatedAt: "2026-05-11T08:02:00.000Z"
    }
  },
  {
    title: "Refresh contributor guide",
    author: "ren",
    githubUrl: "https://github.com/acme/open-source/pull/88",
    team: "Maintainers",
    age: "2d 09h",
    checkHistory: [
      {
        status: "pass",
        conclusion: "success",
        publishedAt: "2026-05-10T23:12:00.000Z",
        message: "Configured policy requirements are satisfied."
      }
    ],
    record: {
      id: "ccr_docs",
      organizationId: "org_local",
      repositoryId: "repo_open_source",
      repositoryFullName: "acme/open-source",
      pullRequestNumber: 88,
      headSha: "47abc90",
      baseBranch: "main",
      mode: "warn",
      policyVersion: "open-source-maintainer@1.0.0",
      policyPackId: "open-source-maintainer",
      policyPackVersion: "1.0.0",
      verifiedFindings: [
        fact({
          id: "fact_agent_docs",
          type: "agent_signal_detected",
          source: "github_metadata",
          evidence: "Label indicates agent assistance: ai-assisted",
          confidence: "observed",
          severity: "low",
          metadata: { signal: "ai_label" }
        })
      ],
      requiredEvidence: [],
      requiredReviewers: [],
      checkStatus: "pass",
      lifecycle: "passed",
      decision: {
        status: "passed",
        decidedAt: "2026-05-10T23:12:00.000Z"
      },
      createdAt: "2026-05-10T23:12:00.000Z",
      updatedAt: "2026-05-10T23:12:00.000Z"
    }
  }
];

export const demoRecords: ChangeControlRecord[] = dashboardRecords.map((item) => item.record);

export const policyYaml = `version: 1
policy_pack_id: fintech
policy_pack_version: 1.4.0
agentforge:
  mode: warn
  apply_to:
    - all_pull_requests
agent_assisted:
  stricter_controls: true
  detection_signals:
    - bot_author
    - branch_pattern
    - ai_label
    - commit_metadata
    - pr_body_marker
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
  ci_and_deploy:
    paths:
      - ".github/workflows/**"
      - "scripts/deploy/**"
      - "infra/prod/**"
    required_reviewers:
      - "platform-team"
    required_evidence:
      - "ci_change_reason"
tests:
  deleted_tests:
    action: block
    required_evidence:
      - "deleted_test_explanation"
  skipped_tests:
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
      - "migration_dry_run"
overrides:
  allowed_roles:
    - "engineering_manager"
    - "platform_admin"
  require_reason: true
  visible_in_pr: true
  audit: true
data_retention:
  source_code_storage: false
  full_diff_retention: "disabled"
  redact_secrets: true
  llm_features: false
  audit_record_retention: "365d"`;

export const onboardingSteps = [
  {
    title: "Connect GitHub App",
    detail: "Install the GitHub App and verify webhook delivery.",
    status: "complete"
  },
  {
    title: "Select organization",
    detail: "Choose the GitHub organization to govern.",
    status: "complete"
  },
  {
    title: "Select repositories",
    detail: "Enable repositories that should publish Merge Guard checks.",
    status: "active"
  },
  {
    title: "Choose policy pack",
    detail: "Start from Startup Default, Platform Engineering, Fintech, or Enterprise Strict.",
    status: "pending"
  },
  {
    title: "Choose mode",
    detail: "Start in observe, move to warn, then enforce mature rules.",
    status: "pending"
  },
  {
    title: "Map owners",
    detail: "Assign security team, platform team, billing owner, and database owner.",
    status: "pending"
  },
  {
    title: "Configure retention",
    detail: "Keep metadata by default and leave full diff retention disabled unless required.",
    status: "pending"
  },
  {
    title: "Preview policy",
    detail: "Run recent PRs through the policy pack before changing required checks.",
    status: "pending"
  },
  {
    title: "Finish setup",
    detail: "Publish checks and start recording Change Control Records.",
    status: "pending"
  }
] as const;

export async function loadDashboardData(): Promise<DashboardData> {
  try {
    const payload = await fetchApiJson<{ records: ChangeControlRecord[] }>(
      "/api/dashboard/records"
    );
    const records = decorateRecords(payload.records ?? []);
    if (records.length === 0) {
      if (demoMode) {
        return {
          records: dashboardRecords,
          source: "demo",
          message:
            "Demo data is shown because DEMO_MODE is enabled and no evaluated PRs are stored yet."
        };
      }
      return {
        records: [],
        source: "empty",
        message:
          "No evaluated PRs are stored yet. Send a GitHub webhook or run a policy preview to create Change Control Records."
      };
    }
    return {
      records,
      source: "api",
      message: `Loaded ${records.length} Change Control Record${records.length === 1 ? "" : "s"} from the API.`
    };
  } catch (error) {
    if (demoMode) {
      return {
        records: dashboardRecords,
        source: "demo",
        message: "Demo data is shown because DEMO_MODE is enabled and the API could not be reached."
      };
    }
    return {
      records: [],
      source: "unavailable",
      message:
        error instanceof Error
          ? `Dashboard API unavailable: ${error.message}. Start the API with pnpm dev:api.`
          : "Dashboard API unavailable. Start the API with pnpm dev:api."
    };
  }
}

export async function loadRecord(
  id: string
): Promise<DashboardData & { item: DashboardRecord | undefined }> {
  const data = await loadDashboardData();
  return {
    ...data,
    item: data.records.find((record) => record.record.id === id)
  };
}

export async function loadPolicyYaml(repositoryId: string): Promise<{
  repositoryId: string;
  policy: string;
  source: DashboardDataSource;
  message: string;
}> {
  try {
    const payload = await fetchApiJson<{ repositoryId: string; policy?: string }>(
      `/api/repositories/${encodeURIComponent(repositoryId)}/policy`
    );
    return {
      repositoryId: payload.repositoryId,
      policy: payload.policy ?? "",
      source: "api",
      message: "Loaded the active repository policy from the API."
    };
  } catch (error) {
    return {
      repositoryId,
      policy: policyYaml,
      source: demoMode ? "demo" : "unavailable",
      message:
        error instanceof Error
          ? `Policy API unavailable: ${error.message}. Showing the bundled Fintech policy pack.`
          : "Policy API unavailable. Showing the bundled Fintech policy pack."
    };
  }
}

export async function loadRepositories(): Promise<{
  repositories: RepositoryOption[];
  source: DashboardDataSource;
  message: string;
}> {
  try {
    const payload = await fetchApiJson<{ repositories: RepositoryOption[] }>("/api/repositories");
    return {
      repositories: payload.repositories ?? [],
      source: "api",
      message: "Loaded repository configuration from the API."
    };
  } catch (error) {
    const fallback = inferRepositories(dashboardRecords);
    return {
      repositories: demoMode ? fallback : [],
      source: demoMode ? "demo" : "unavailable",
      message:
        error instanceof Error
          ? `Repository API unavailable: ${error.message}.`
          : "Repository API unavailable."
    };
  }
}

export function getDashboardSummary(records = dashboardRecords) {
  const evidenceItems = records.flatMap((item) => item.record.requiredEvidence);
  const providedEvidence = evidenceItems.filter((item) => item.status !== "missing").length;
  const missingEvidence = evidenceItems.length - providedEvidence;
  const requiredReviewers = records.flatMap((item) =>
    item.record.requiredReviewers.filter((reviewer) => reviewer.tier === "required")
  );
  const pendingRequiredReviewers = requiredReviewers.filter((reviewer) => !reviewer.approved);
  const agentAssisted = records.filter((item) =>
    item.record.verifiedFindings.some((finding) => finding.type === "agent_signal_detected")
  );
  const overrides = records.filter((item) => item.record.lifecycle === "overridden");

  return {
    blockedPrs: records.filter((item) => item.record.checkStatus === "block").length,
    missingEvidence: missingEvidence,
    pendingRequiredReviewers: pendingRequiredReviewers.length,
    overrides: overrides.length,
    policyFindings: records.flatMap((item) => item.record.verifiedFindings).length,
    agentAssisted: agentAssisted.length,
    evidenceCompletion:
      evidenceItems.length === 0
        ? 100
        : Math.round((providedEvidence / evidenceItems.length) * 100),
    overrideRate: records.length === 0 ? 0 : Math.round((overrides.length / records.length) * 100),
    evaluatedAt: now
  };
}

export function actionRequiredRecords(records = dashboardRecords): DashboardRecord[] {
  return [...records]
    .filter(
      (item) =>
        item.record.checkStatus === "block" ||
        missingEvidence(item.record).length > 0 ||
        pendingRequiredReviewers(item.record).length > 0 ||
        item.record.lifecycle === "overridden"
    )
    .sort((a, b) => priorityRank(a) - priorityRank(b));
}

export function missingEvidence(record: ChangeControlRecord): EvidenceRequirement[] {
  return record.requiredEvidence.filter((item) => item.status === "missing");
}

export function pendingRequiredReviewers(record: ChangeControlRecord): ReviewerRequirement[] {
  return record.requiredReviewers.filter((item) => item.tier === "required" && !item.approved);
}

export function hasAgentSignal(record: ChangeControlRecord): boolean {
  return record.verifiedFindings.some((finding) => finding.type === "agent_signal_detected");
}

export function findingGroups(records = dashboardRecords) {
  const groups = new Map<
    VerifiedFact["type"],
    { type: VerifiedFact["type"]; count: number; severity: string; examples: string[] }
  >();
  for (const finding of records.flatMap((item) => item.record.verifiedFindings)) {
    const existing = groups.get(finding.type) ?? {
      type: finding.type,
      count: 0,
      severity: finding.severity ?? "medium",
      examples: []
    };
    existing.count += 1;
    existing.severity =
      severityRank(finding.severity) < severityRank(existing.severity)
        ? (finding.severity ?? existing.severity)
        : existing.severity;
    if (existing.examples.length < 3) {
      existing.examples.push(finding.evidence);
    }
    groups.set(finding.type, existing);
  }
  return [...groups.values()].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

export function evidenceByKind(records = dashboardRecords) {
  const groups = new Map<
    EvidenceRequirement["kind"],
    { kind: EvidenceRequirement["kind"]; total: number; missing: number; approved: number }
  >();
  for (const item of records.flatMap((record) => record.record.requiredEvidence)) {
    const existing = groups.get(item.kind) ?? {
      kind: item.kind,
      total: 0,
      missing: 0,
      approved: 0
    };
    existing.total += 1;
    if (item.status === "missing") {
      existing.missing += 1;
    }
    if (item.status === "approved") {
      existing.approved += 1;
    }
    groups.set(item.kind, existing);
  }
  return [...groups.values()].sort((a, b) => b.missing - a.missing || b.total - a.total);
}

export function getRecord(id: string): DashboardRecord {
  return dashboardRecords.find((item) => item.record.id === id) ?? dashboardRecords[0]!;
}

export function humanize(value: string): string {
  return value.replace(/_/g, " ");
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

async function fetchApiJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    cache: "no-store",
    headers: {
      accept: "application/json"
    }
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

function decorateRecords(records: ChangeControlRecord[]): DashboardRecord[] {
  return records.map((record) => {
    const item: DashboardRecord = {
      record,
      title: `PR #${record.pullRequestNumber}`,
      author: record.decision?.decidedBy ?? "unknown",
      githubUrl: `https://github.com/${record.repositoryFullName}/pull/${record.pullRequestNumber}`,
      team: inferTeam(record),
      age: relativeAge(record.updatedAt),
      checkHistory: [
        {
          status: record.checkStatus,
          conclusion:
            record.checkStatus === "block"
              ? "failure"
              : record.checkStatus === "warn"
                ? "neutral"
                : "success",
          publishedAt: record.updatedAt,
          message: checkMessage(record)
        }
      ]
    };
    if (record.decision?.status === "merged_after_override") {
      item.override = {
        actor: record.decision.overrideBy ?? record.decision.decidedBy ?? "unknown",
        actorRole: "authorized",
        reason: record.decision.overrideReason ?? "Override reason not recorded.",
        scope: "pr",
        createdAt: record.decision.decidedAt ?? record.updatedAt,
        visibleInPr: true
      };
    }
    return item;
  });
}

function inferRepositories(records: DashboardRecord[]): RepositoryOption[] {
  const repositories = new Map<string, RepositoryOption>();
  for (const item of records) {
    repositories.set(item.record.repositoryId, {
      id: item.record.repositoryId,
      fullName: item.record.repositoryFullName,
      enabled: true,
      mode: item.record.mode,
      currentPolicyPack: item.record.policyPackId ?? "custom"
    });
  }
  return [...repositories.values()];
}

function inferTeam(record: ChangeControlRecord): DashboardRecord["team"] {
  if (record.verifiedFindings.some((finding) => finding.type === "migration_added")) {
    return "Database";
  }
  if (record.verifiedFindings.some((finding) => finding.type === "ci_workflow_changed")) {
    return "Platform";
  }
  if (
    record.requiredReviewers.some((reviewer) => reviewer.reviewer.includes("security")) ||
    record.verifiedFindings.some((finding) =>
      String(finding.metadata?.ruleId ?? "").includes("auth")
    )
  ) {
    return "Security";
  }
  if (
    record.requiredReviewers.some((reviewer) => reviewer.reviewer.includes("billing")) ||
    record.verifiedFindings.some((finding) =>
      String(finding.metadata?.ruleId ?? "").includes("billing")
    )
  ) {
    return "Billing";
  }
  return "Maintainers";
}

function relativeAge(value: string): string {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return "unknown";
  }
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  return `${Math.round(hours / 24)}d`;
}

function checkMessage(record: ChangeControlRecord): string {
  if (record.lifecycle === "overridden") {
    return "Authorized override recorded.";
  }
  if (record.checkStatus === "block") {
    return "Merge Guard blocked merge because required policy evidence or approvals are missing.";
  }
  if (record.checkStatus === "warn") {
    return "Non-blocking warning; this shows what would block in enforce mode.";
  }
  return "Configured policy requirements are satisfied.";
}

function fact(input: Partial<VerifiedFact> & Pick<VerifiedFact, "id" | "type" | "evidence">) {
  return {
    source: "github_diff",
    confidence: "verified",
    ...input
  } satisfies VerifiedFact;
}

function evidence(
  findingId: string,
  kind: EvidenceRequirement["kind"],
  status: EvidenceRequirement["status"],
  extra: Partial<EvidenceRequirement> = {}
): EvidenceRequirement {
  return {
    id: `evidence:${findingId}:${kind}`,
    kind,
    status,
    requiredByFindingId: findingId,
    ...extra
  };
}

function reviewer(
  findingId: string,
  reviewerName: string,
  reviewerType: ReviewerRequirement["reviewerType"],
  tier: ReviewerRequirement["tier"],
  approved: boolean,
  extra: Partial<ReviewerRequirement> = {}
): ReviewerRequirement {
  return {
    id: `reviewer:${findingId}:${reviewerName}`,
    reviewer: reviewerName,
    reviewerType,
    tier,
    reason: "Reviewer approval required.",
    triggeredByFindingId: findingId,
    approved,
    ...extra
  };
}

function priorityRank(item: DashboardRecord): number {
  if (item.record.checkStatus === "block") {
    return 0;
  }
  if (missingEvidence(item.record).length > 0) {
    return 1;
  }
  if (pendingRequiredReviewers(item.record).length > 0) {
    return 2;
  }
  if (item.record.lifecycle === "overridden") {
    return 3;
  }
  return 4;
}

function severityRank(severity: string | undefined): number {
  if (severity === "critical") {
    return 0;
  }
  if (severity === "high") {
    return 1;
  }
  if (severity === "medium") {
    return 2;
  }
  return 3;
}
