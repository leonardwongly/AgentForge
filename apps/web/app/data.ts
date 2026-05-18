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

export type DashboardDataSource = "api" | "empty" | "unavailable";

export type DashboardData = {
  records: DashboardRecord[];
  source: DashboardDataSource;
  message: string;
};

export type BlockingModeBadge = Extract<
  ChangeControlRecord["mode"],
  "warn" | "enforce" | "optimize"
>;

export function blockingModeBadge(mode: ChangeControlRecord["mode"]): BlockingModeBadge {
  return mode === "enforce" || mode === "optimize" ? mode : "warn";
}

export type RepositoryOption = {
  id: string;
  fullName: string;
  enabled: boolean;
  mode: string;
  currentPolicyPack?: string | undefined;
  currentPolicyVersion?: string | undefined;
  protected?: boolean | undefined;
  defaultBranch?: string | undefined;
  dataHandling?:
    | {
        sourceCodeStorage: boolean;
        fullDiffRetention: string;
        redactSecrets: boolean;
        llmFeatures: boolean;
        auditRecordRetentionDays: number;
      }
    | undefined;
};

export type PolicyPackOption = {
  id: string;
  name: string;
  description: string;
  version: string;
  builtIn: boolean;
  defaultMode: string;
  contentYaml: string;
};

export type OnboardingStep = {
  id: string;
  title: string;
  detail: string;
  status: "complete" | "active" | "pending";
};

export type SettingsData = {
  githubInstallation: {
    connected: boolean;
    accountLogin?: string | undefined;
    accountType?: string | undefined;
    githubInstallationId?: string | undefined;
  };
  repositories: RepositoryOption[];
  dataHandling: {
    sourceCodeStorage: boolean;
    fullDiffRetention: string;
    redactSecrets: boolean;
    llmFeatures: boolean;
    auditRecordRetentionDays: number;
  };
  ownerMappings: Array<{
    ownerKey?: string | undefined;
    reviewer: string;
    reviewerType: string;
    sources: string[];
  }>;
  exports: {
    json: boolean;
    csv: boolean;
    storageBucketConfigured: boolean;
    storageRegion?: string | undefined;
  };
};

const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:4000";
const API_FETCH_TIMEOUT_MS = 5_000;

export async function loadDashboardData(): Promise<DashboardData> {
  try {
    const payload = await fetchApiJson<{ records: ChangeControlRecord[] }>(
      "/api/dashboard/records"
    );
    const records = decorateRecords(payload.records ?? []);
    if (records.length === 0) {
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
  mode?: string | undefined;
  version?: string | undefined;
  policyPackId?: string | undefined;
  policyPackVersion?: string | undefined;
}> {
  try {
    const payload = await fetchApiJson<{
      repositoryId: string;
      policy?: string | undefined;
      mode?: string | undefined;
      version?: string | undefined;
      policyPackId?: string | undefined;
      policyPackVersion?: string | undefined;
    }>(`/api/repositories/${encodeURIComponent(repositoryId)}/policy`);
    return {
      repositoryId: payload.repositoryId,
      policy: payload.policy ?? "",
      source: "api",
      message: "Loaded the active repository policy from the API.",
      mode: payload.mode,
      version: payload.version,
      policyPackId: payload.policyPackId,
      policyPackVersion: payload.policyPackVersion
    };
  } catch (error) {
    return {
      repositoryId,
      policy: "",
      source: "unavailable",
      message:
        error instanceof Error
          ? `Policy API unavailable or no active policy is configured: ${error.message}.`
          : "Policy API unavailable or no active policy is configured."
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
    return {
      repositories: [],
      source: "unavailable",
      message:
        error instanceof Error
          ? `Repository API unavailable: ${error.message}.`
          : "Repository API unavailable."
    };
  }
}

export async function loadPolicyPacks(): Promise<{
  policyPacks: PolicyPackOption[];
  source: DashboardDataSource;
  message: string;
}> {
  try {
    const payload = await fetchApiJson<{ policyPacks: PolicyPackOption[] }>("/api/policy-packs");
    return {
      policyPacks: payload.policyPacks ?? [],
      source: "api",
      message: "Loaded policy packs from the API."
    };
  } catch (error) {
    return {
      policyPacks: [],
      source: "unavailable",
      message:
        error instanceof Error
          ? `Policy pack API unavailable: ${error.message}.`
          : "Policy pack API unavailable."
    };
  }
}

export async function loadOnboardingStatus(): Promise<{
  steps: OnboardingStep[];
  source: DashboardDataSource;
  message: string;
}> {
  try {
    const payload = await fetchApiJson<{ steps: OnboardingStep[] }>("/api/onboarding/status");
    return {
      steps: payload.steps ?? [],
      source: "api",
      message: "Loaded onboarding status from the API."
    };
  } catch (error) {
    return {
      steps: [],
      source: "unavailable",
      message:
        error instanceof Error
          ? `Onboarding API unavailable: ${error.message}.`
          : "Onboarding API unavailable."
    };
  }
}

export async function loadSettings(): Promise<{
  settings: SettingsData | undefined;
  source: DashboardDataSource;
  message: string;
}> {
  try {
    const settings = await fetchApiJson<SettingsData>("/api/settings");
    return {
      settings,
      source: "api",
      message: "Loaded settings from the API."
    };
  } catch (error) {
    return {
      settings: undefined,
      source: "unavailable",
      message:
        error instanceof Error
          ? `Settings API unavailable: ${error.message}.`
          : "Settings API unavailable."
    };
  }
}

export function getDashboardSummary(records: DashboardRecord[] = []) {
  const evidenceItems = records.flatMap((item) => item.record.requiredEvidence);
  const approvedEvidence = evidenceItems.filter((item) => item.status === "approved").length;
  const incompleteEvidenceCount = evidenceItems.length - approvedEvidence;
  const requiredReviewers = records.flatMap((item) =>
    item.record.requiredReviewers.filter((reviewer) => reviewer.tier === "required")
  );
  const pendingReviewers = requiredReviewers.filter((reviewer) => !reviewer.approved);
  const agentAssisted = records.filter((item) =>
    item.record.verifiedFindings.some((finding) => finding.type === "agent_signal_detected")
  );
  const overrides = records.filter((item) => item.record.lifecycle === "overridden");

  return {
    blockedPrs: records.filter((item) => item.record.checkStatus === "block").length,
    missingEvidence: incompleteEvidenceCount,
    pendingRequiredReviewers: pendingReviewers.length,
    overrides: overrides.length,
    policyFindings: records.flatMap((item) => item.record.verifiedFindings).length,
    agentAssisted: agentAssisted.length,
    evidenceCompletion:
      evidenceItems.length === 0
        ? 100
        : Math.round((approvedEvidence / evidenceItems.length) * 100),
    overrideRate: records.length === 0 ? 0 : Math.round((overrides.length / records.length) * 100),
    evaluatedAt: records[0]?.record.updatedAt ?? new Date(0).toISOString()
  };
}

export function actionRequiredRecords(records: DashboardRecord[] = []): DashboardRecord[] {
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
  return record.requiredEvidence.filter((item) => item.status !== "approved");
}

export function pendingRequiredReviewers(record: ChangeControlRecord): ReviewerRequirement[] {
  return record.requiredReviewers.filter((item) => item.tier === "required" && !item.approved);
}

export function hasAgentSignal(record: ChangeControlRecord): boolean {
  return record.verifiedFindings.some((finding) => finding.type === "agent_signal_detected");
}

export function summarizeFindings(findings: VerifiedFact[], limit = 3): string {
  return summarizeLabels(
    findings
      .filter((finding) => finding.type !== "agent_signal_detected")
      .map((finding) => humanize(finding.type)),
    limit
  );
}

export function summarizeEvidenceRequirements(evidence: EvidenceRequirement[], limit = 3): string {
  return summarizeLabels(
    evidence.map((item) => humanize(item.kind)),
    limit
  );
}

export function summarizeReviewerRequirements(reviewers: ReviewerRequirement[], limit = 3): string {
  return summarizeLabels(
    reviewers.map((reviewer) => reviewer.reviewer),
    limit
  );
}

export function findingGroups(records: DashboardRecord[] = []) {
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

export function evidenceByKind(records: DashboardRecord[] = []) {
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
    },
    signal: AbortSignal.timeout(API_FETCH_TIMEOUT_MS)
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
    if (
      record.decision?.status === "override_approved" ||
      record.decision?.status === "merged_after_override"
    ) {
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

function summarizeLabels(labels: string[], limit: number): string {
  if (labels.length === 0) {
    return "none";
  }
  const counts = new Map<string, number>();
  for (const label of labels) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const visible = entries.slice(0, limit).map(([label, count]) => {
    return count > 1 ? `${label} x${count}` : label;
  });
  const remaining = entries.length - visible.length;
  return remaining > 0 ? `${visible.join(", ")} +${remaining} more` : visible.join(", ");
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
