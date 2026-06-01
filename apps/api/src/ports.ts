import type {
  AuditEventRecord,
  ChangeControlRecord,
  OverrideRecord,
  PullRequestInput
} from "@agentforge/core";
import type { GithubWebhookEnvelope } from "@agentforge/github";

// Persistence port (assessment C1/C2). Request/domain logic should depend on
// this seam instead of branching on in-memory vs Prisma throughout app.ts. The
// existing in-memory and Prisma code paths are the two adapters to migrate
// behind it; the pure.ts extraction was the first strangler slice toward this.

export interface ChangeControlRecordStore {
  get(recordId: string): Promise<ChangeControlRecord | undefined>;
  save(record: ChangeControlRecord, pr?: PullRequestInput): Promise<ChangeControlRecord>;
  list(filter?: { organizationId?: string }): Promise<ChangeControlRecord[]>;
  page(query: RecordPageQuery): Promise<RecordPage>;
}

export interface AuditEventStore {
  append(event: AuditEventRecord): Promise<void>;
  list(filter?: { organizationId?: string }): Promise<AuditEventRecord[]>;
  listForRecordExport(records: ChangeControlRecord[]): Promise<AuditEventRecord[]>;
}

export interface WebhookDeliveryStore {
  recordReceived(envelope: GithubWebhookEnvelope): Promise<WebhookDeliveryReceipt>;
  markQueued(deliveryId: string, queueJobId: string): Promise<void>;
  markCompleted(deliveryId: string): Promise<void>;
  markEnqueueFailed(deliveryId: string, error: unknown): Promise<void>;
  markReplayed(deliveryId: string, actor: string): Promise<void>;
  findReplayable(
    target: WebhookReplayTarget,
    organizationId?: string
  ): Promise<ReplayableDelivery | undefined>;
  listRecentFailures(organizationId?: string): Promise<Array<Record<string, unknown>>>;
}

export interface GitHubInstallationStore {
  upsertPending(input: GitHubInstallationVerifyInput): Promise<GitHubInstallationState | undefined>;
  approve(input: GitHubInstallationDecision): Promise<GitHubInstallationState | undefined>;
  reject(input: GitHubInstallationDecision): Promise<GitHubInstallationState | undefined>;
  list(organizationId: string): Promise<GitHubInstallationState[]>;
  summary(organizationId: string): Promise<GitHubInstallationSummaryState>;
  recordWebhook(envelope: GithubWebhookEnvelope): Promise<GitHubInstallationState | undefined>;
  listStoredInstallationEvents(
    githubInstallationId: string
  ): Promise<Array<NonNullable<GithubWebhookEnvelope["installation"]>>>;
}

export interface ExportJobStore {
  save(job: ExportJob, actor: ExportJobActor): Promise<void>;
  get(id: string): Promise<ExportJob | undefined>;
}

export interface OverrideStore {
  save(override: OverrideRecord): Promise<void>;
}

export interface RepositoryStore {
  organizationId(repositoryId: string): Promise<string | undefined>;
  findIdByFullName(fullName: string): Promise<string | undefined>;
  modeOverride(repositoryId: string): Promise<ChangeControlRecord["mode"] | undefined>;
  defaultDataHandling(defaults: RepositoryDataHandlingState): Promise<RepositoryDataHandlingState>;
  listSummaries(
    defaultMode: ChangeControlRecord["mode"],
    organizationId?: string
  ): Promise<RepositorySummary[]>;
  getActivePolicy(repositoryId: string): Promise<RepositoryPolicyState | undefined>;
  saveActivePolicy(policy: RepositoryPolicyState): Promise<RepositoryPolicyState>;
  updateSettings(input: {
    repositoryId: string;
    patch: RepositorySettingsPatch;
    defaultDataHandling: RepositoryDataHandlingState;
    defaultMode: ChangeControlRecord["mode"];
  }): Promise<RepositorySettingsResult>;
  listOwnerMappings(repositoryId?: string): Promise<OwnerMappingState[]>;
  listGithubInstallationRepositories(input: {
    organizationId: string;
    accountLogin: string;
  }): Promise<GithubInstallationRepositoryState[]>;
  syncGithubInstallation(input: {
    organizationId: string;
    installation: NonNullable<GithubWebhookEnvelope["installation"]>;
  }): Promise<void>;
  archiveGithubRepositories(input: {
    organizationId: string;
    repositoriesRemoved: GithubRepositoryRef[];
  }): Promise<void>;
}

export interface EvaluationSnapshotStore {
  ensurePolicyVersion(input: PolicyVersionSnapshotInput): Promise<PolicyVersionSnapshotState>;
  persist(input: EvaluationSnapshotInput): Promise<void>;
}

export interface MetricStore {
  domainCounts(): Promise<DomainMetricCounts>;
}

export interface PersistencePort {
  records: ChangeControlRecordStore;
  auditEvents: AuditEventStore;
  webhookDeliveries: WebhookDeliveryStore;
  githubInstallations: GitHubInstallationStore;
  exportJobs: ExportJobStore;
  overrides: OverrideStore;
  repositories: RepositoryStore;
  evaluationSnapshots: EvaluationSnapshotStore;
  metrics: MetricStore;
}

export type WebhookDeliveryStatus =
  | "received"
  | "queued"
  | "processing"
  | "completed"
  | "enqueue_failed"
  | "failed";

export type WebhookDeliveryReceipt = {
  duplicate: boolean;
  status: WebhookDeliveryStatus;
};

export type StoredWebhookDelivery = {
  deliveryId: string;
  event: string;
  action: string | null;
  repositoryFullName: string | null;
  organizationId?: string | null | undefined;
  repositoryId?: string | null | undefined;
  pullRequestNumber: number | null;
  headSha: string | null;
  enqueued: boolean;
  deliveryStatus?: WebhookDeliveryStatus | string | undefined;
  queueJobId?: string | null | undefined;
  queuedAt?: Date | string | null | undefined;
  processingStartedAt?: Date | string | null | undefined;
  completedAt?: Date | string | null | undefined;
  lastEnqueueFailureClass?: string | null | undefined;
  lastEnqueueFailureMessage?: string | null | undefined;
  lastEnqueueFailedAt?: Date | string | null | undefined;
  payloadJson: unknown;
  evaluationAttemptsMade?: number | undefined;
  evaluationTerminalFailure?: boolean | undefined;
  lastFailureClass?: string | null | undefined;
  lastFailureMessage?: string | null | undefined;
  lastFailureCorrelationId?: string | null | undefined;
  lastFailedAt?: Date | string | null | undefined;
  replayCount?: number | undefined;
  lastReplayedAt?: Date | string | null | undefined;
  lastReplayedBy?: string | null | undefined;
  createdAt?: Date | string | undefined;
};

export type ReplayableDelivery = {
  delivery: StoredWebhookDelivery;
  envelope: GithubWebhookEnvelope;
};

export type WebhookReplayTarget = {
  deliveryId?: string | undefined;
  repositoryFullName?: string | undefined;
  pullRequestNumber?: number | undefined;
};

export function hasCompleteWebhookReplayTarget(target: WebhookReplayTarget): boolean {
  return Boolean(
    target.deliveryId || (target.repositoryFullName && target.pullRequestNumber !== undefined)
  );
}

export type ExportJob = {
  id: string;
  organizationId: string;
  status: "completed";
  format: "json" | "csv";
  recordCount: number;
  totalMatchingRecords: number;
  truncated: boolean;
  content: string;
  createdAt: string;
};

export type ExportJobActor = {
  actor: string;
  actorRole: string;
};

export type GithubRepositoryRef = {
  id: number;
  fullName: string;
  githubRepositoryId?: bigint | undefined;
};

export type GithubInstallationStatus =
  | "pending_approval"
  | "approved"
  | "rejected"
  | "archived"
  | string;

export type GitHubInstallationState = {
  id: string;
  organizationId?: string | undefined;
  githubInstallationId: string;
  accountLogin: string;
  accountType: string;
  status: GithubInstallationStatus;
  approvedBy?: string | undefined;
  approvedAt?: string | undefined;
  rejectedBy?: string | undefined;
  rejectedAt?: string | undefined;
  archivedAt?: string | undefined;
  lastWebhookAt: string;
  createdAt: string;
  updatedAt: string;
};

export type GitHubInstallationVerifyInput = {
  githubInstallationId: string;
  accountLogin?: string | undefined;
  accountType?: "Organization" | "User" | undefined;
  organizationId: string;
};

export type GitHubInstallationDecision = {
  id: string;
  organizationId: string;
  actor: string;
};

export type GitHubInstallationSummaryState = {
  installation?: GitHubInstallationState | undefined;
  pendingApprovalCount: number;
};

export type GithubInstallationRepositoryState = {
  fullName: string;
  githubRepositoryId: string;
};

export type RepositoryDataHandlingState = {
  sourceCodeStorage: boolean;
  fullDiffRetention: "disabled" | "7d" | "30d" | "custom";
  redactSecrets: boolean;
  llmFeatures: boolean;
  auditRecordRetentionDays: number;
};

export type OwnerMapping = {
  organizationId?: string | undefined;
  ownerKey: string;
  reviewer: string;
  reviewerType: "user" | "team";
  id?: string | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};

export type OwnerMappingState = {
  id: string;
  organizationId: string;
  repositoryId?: string | undefined;
  ownerKey: string;
  reviewer: string;
  reviewerType: "user" | "team";
  createdAt: string;
  updatedAt: string;
};

export type RepositoryPolicyState = {
  repositoryId: string;
  version: string;
  mode: ChangeControlRecord["mode"];
  contentYaml: string;
  contentHash: string;
  createdBy: string;
  createdAt: string;
  policyPackId?: string | undefined;
  policyPackVersion?: string | undefined;
};

export type RepositorySettingsState = {
  repositoryId: string;
  organizationId?: string | undefined;
  enabled: boolean;
  mode?: ChangeControlRecord["mode"] | undefined;
  dataHandling?: RepositoryDataHandlingState | undefined;
  updatedAt: string;
};

export type RepositoryDataHandlingPatch = {
  sourceCodeStorage?: boolean | undefined;
  fullDiffRetention?: RepositoryDataHandlingState["fullDiffRetention"] | undefined;
  redactSecrets?: boolean | undefined;
  llmFeatures?: boolean | undefined;
  auditRecordRetentionDays?: number | undefined;
};

export type RepositorySummary = {
  id: string;
  organizationId?: string | undefined;
  fullName: string;
  enabled?: boolean | undefined;
  mode?: ChangeControlRecord["mode"] | undefined;
  currentPolicyPack?: string | undefined;
  currentPolicyVersion?: string | undefined;
  protected?: boolean | undefined;
  defaultBranch?: string | undefined;
  dataHandling?: Record<string, unknown> | undefined;
  archivedAt?: string | undefined;
  archiveReason?: string | undefined;
};

export type RepositorySettingsPatch = {
  enabled?: boolean | undefined;
  mode?: ChangeControlRecord["mode"] | undefined;
  policyVersion?: string | undefined;
  dataHandling?: RepositoryDataHandlingPatch | undefined;
  ownerMappings?: OwnerMapping[] | undefined;
  sourceCodeStorage?: boolean | undefined;
  fullDiffRetention?: RepositoryDataHandlingState["fullDiffRetention"] | undefined;
  redactSecrets?: boolean | undefined;
  llmFeatures?: boolean | undefined;
  auditRecordRetentionDays?: number | undefined;
};

export type RepositorySettingsRepository = {
  id: string;
  enabled: boolean;
  mode: ChangeControlRecord["mode"];
  dataHandling: RepositoryDataHandlingState;
};

export type RepositorySettingsResult = {
  organizationId: string;
  repository: RepositorySettingsRepository;
  ownerMappings: OwnerMappingState[];
};

export type PolicyVersionSnapshotInput = {
  organizationId: string;
  repositoryId: string;
  record: ChangeControlRecord;
};

export type PolicyVersionSnapshotState = {
  id: string;
  organizationId: string;
  repositoryId: string;
  policyPackId?: string | undefined;
  version: string;
  mode: ChangeControlRecord["mode"];
  contentYaml: string;
  contentHash: string;
  createdBy: string;
};

export type EvaluationSnapshotInput = PolicyVersionSnapshotInput & {
  pullRequestId: string;
};

export type EvaluationSnapshotState = {
  id: string;
  organizationId: string;
  repositoryId: string;
  pullRequestId: string;
  policyVersionId: string;
  mode: ChangeControlRecord["mode"];
  status: ChangeControlRecord["checkStatus"];
  headSha: string;
  completedAt: string;
  explanation: string[];
  verifiedFindings: ChangeControlRecord["verifiedFindings"];
  requiredEvidence: ChangeControlRecord["requiredEvidence"];
  requiredReviewers: ChangeControlRecord["requiredReviewers"];
  checkRun: {
    conclusion: "success" | "neutral" | "failure";
    outputTitle: string;
    outputSummary: string;
    updatedAt: string;
  };
};

export type DomainMetricCounts = {
  webhookDeliveriesByStatus: Record<string, number>;
  recordsByStatus: Record<string, number>;
  checkRuns: number;
  exports: number;
  auditEventsByAction: Record<string, number>;
};

export type RecordPageQuery = {
  limit: number;
  offset: number;
  organizationId?: string | undefined;
  repositoryId?: string | undefined;
  status?: ChangeControlRecord["checkStatus"] | undefined;
  lifecycle?: ChangeControlRecord["lifecycle"] | undefined;
  mode?: ChangeControlRecord["mode"] | undefined;
  policyVersion?: string | undefined;
  queue?: "action_required" | undefined;
  sort: "updated_desc" | "updated_asc" | "created_desc" | "created_asc" | "pr_asc" | "pr_desc";
};

export type PageInfo = {
  limit: number;
  offset: number;
  total: number;
  nextOffset?: number | undefined;
  hasMore: boolean;
};

export type RecordPage = {
  records: ChangeControlRecord[];
  pageInfo: PageInfo;
};

type InMemoryPersistenceState = {
  records: ChangeControlRecord[];
  auditEvents: AuditEventRecord[];
  exports: ExportJob[];
  overrides: OverrideRecord[];
  repositoryPolicies: Map<string, RepositoryPolicyState>;
  repositorySettings: Map<string, RepositorySettingsState>;
  ownerMappings: OwnerMappingState[];
  policyVersionSnapshots: Map<string, PolicyVersionSnapshotState>;
  evaluationSnapshots: EvaluationSnapshotState[];
  deliveries: Set<string>;
  queuedEvaluations: Array<{
    deliveryId: string;
    envelope: GithubWebhookEnvelope;
    queuedAt: string;
  }>;
  githubInstallations?: GitHubInstallationState[] | undefined;
  githubInstallationEvents?:
    | Array<{
        githubInstallationId: string;
        installation: NonNullable<GithubWebhookEnvelope["installation"]>;
        createdAt: string;
      }>
    | undefined;
};

// The C2 test double: a single in-memory adapter behind the port so domain
// behavior can be exercised without Postgres, and so the in-memory and Prisma
// adapters can be held to one shared contract during migration.
export function createInMemoryPersistencePort(state?: InMemoryPersistenceState): PersistencePort {
  const records = new Map<string, ChangeControlRecord>();
  const auditEvents: AuditEventRecord[] = [];
  const exports = new Map<string, ExportJob>();
  const overrides = new Map<string, OverrideRecord>();
  const repositoryPolicies = new Map<string, RepositoryPolicyState>();
  const repositorySettings = new Map<string, RepositorySettingsState>();
  const policyVersionSnapshots = new Map<string, PolicyVersionSnapshotState>();
  let evaluationSnapshots: EvaluationSnapshotState[] = [];
  let ownerMappings: OwnerMappingState[] = [];
  let githubInstallations: GitHubInstallationState[] = [];
  let githubInstallationEvents: Array<{
    githubInstallationId: string;
    installation: NonNullable<GithubWebhookEnvelope["installation"]>;
    createdAt: string;
  }> = [];
  const listRecords = () => state?.records ?? [...records.values()];
  const listAuditEvents = () => state?.auditEvents ?? auditEvents;
  const listExports = () => state?.exports ?? [...exports.values()];
  const policyMap = () => state?.repositoryPolicies ?? repositoryPolicies;
  const settingsMap = () => state?.repositorySettings ?? repositorySettings;
  const listOwnerMappings = () => state?.ownerMappings ?? ownerMappings;
  const policySnapshotMap = () => state?.policyVersionSnapshots ?? policyVersionSnapshots;
  const listEvaluationSnapshots = () => state?.evaluationSnapshots ?? evaluationSnapshots;
  const listGithubInstallations = () => state?.githubInstallations ?? githubInstallations;
  const listGithubInstallationEvents = () =>
    state?.githubInstallationEvents ?? githubInstallationEvents;
  const saveGithubInstallations = (items: GitHubInstallationState[]) => {
    if (state) {
      state.githubInstallations = items;
    } else {
      githubInstallations = items;
    }
  };
  const saveGithubInstallationEvents = (
    items: Array<{
      githubInstallationId: string;
      installation: NonNullable<GithubWebhookEnvelope["installation"]>;
      createdAt: string;
    }>
  ) => {
    if (state) {
      state.githubInstallationEvents = items;
    } else {
      githubInstallationEvents = items;
    }
  };
  const policySnapshotKey = (input: PolicyVersionSnapshotInput) =>
    `${input.organizationId}:${input.repositoryId}:${input.record.policyVersion}`;
  const ensurePolicyVersionSnapshot = (
    input: PolicyVersionSnapshotInput
  ): PolicyVersionSnapshotState => {
    const key = policySnapshotKey(input);
    const existing = policySnapshotMap().get(key);
    if (existing) {
      return existing;
    }
    const snapshot: PolicyVersionSnapshotState = {
      id: `policy_version:${key}`,
      organizationId: input.organizationId,
      repositoryId: input.repositoryId,
      policyPackId: input.record.policyPackId,
      version: input.record.policyVersion,
      mode: input.record.mode,
      contentYaml: `# Runtime policy snapshot for ${input.record.repositoryFullName}#${input.record.pullRequestNumber}\n# Full policy content was not attached to this evaluation snapshot.`,
      contentHash: `${input.record.policyVersion}:${input.record.policyPackId ?? ""}`,
      createdBy: "system"
    };
    policySnapshotMap().set(key, snapshot);
    return snapshot;
  };
  const byOrg = <T extends { organizationId: string }>(items: T[], organizationId?: string): T[] =>
    organizationId ? items.filter((item) => item.organizationId === organizationId) : items;

  return {
    records: {
      async get(recordId) {
        return state
          ? state.records.find((record) => record.id === recordId)
          : records.get(recordId);
      },
      async save(record) {
        if (state) {
          state.records = [record, ...state.records.filter((item) => item.id !== record.id)];
        } else {
          records.set(record.id, record);
        }
        return record;
      },
      async list(filter) {
        return byOrg(listRecords(), filter?.organizationId);
      },
      async page(query) {
        return paginateRecords(filterAndSortRecords(listRecords(), query), query);
      }
    },
    auditEvents: {
      async append(event) {
        if (state) {
          state.auditEvents.push(event);
        } else {
          auditEvents.push(event);
        }
      },
      async list(filter) {
        return byOrg(listAuditEvents(), filter?.organizationId);
      },
      async listForRecordExport(records) {
        return auditEventsForRecordExport(listAuditEvents(), records);
      }
    },
    exportJobs: {
      async save(job, _actor) {
        if (state) {
          state.exports = [job, ...(state.exports ?? []).filter((item) => item.id !== job.id)];
        } else {
          exports.set(job.id, job);
        }
      },
      async get(id) {
        return state ? (state.exports ?? []).find((job) => job.id === id) : exports.get(id);
      }
    },
    overrides: {
      async save(override) {
        if (state) {
          state.overrides = [
            override,
            ...state.overrides.filter((item) => item.id !== override.id)
          ];
        } else {
          overrides.set(override.id, override);
        }
      }
    },
    repositories: {
      async organizationId(repositoryId) {
        return (
          settingsMap().get(repositoryId)?.organizationId ??
          listRecords().find((record) => record.repositoryId === repositoryId)?.organizationId
        );
      },
      async findIdByFullName(fullName) {
        return listRecords().find((record) => record.repositoryFullName === fullName)?.repositoryId;
      },
      async modeOverride(repositoryId) {
        return settingsMap().get(repositoryId)?.mode;
      },
      async defaultDataHandling(defaults) {
        return defaults;
      },
      async listSummaries(defaultMode, organizationId) {
        const repositories = new Map<string, RepositorySummary>();

        for (const record of listRecords()) {
          if (organizationId && record.organizationId !== organizationId) {
            continue;
          }
          const policy = policyMap().get(record.repositoryId);
          const settings = settingsMap().get(record.repositoryId);
          repositories.set(record.repositoryId, {
            id: record.repositoryId,
            organizationId: record.organizationId,
            fullName: record.repositoryFullName,
            enabled: settings?.enabled ?? true,
            mode: settings?.mode ?? policy?.mode ?? record.mode,
            currentPolicyPack: policy?.policyPackId ?? record.policyPackId,
            currentPolicyVersion: policy?.version ?? record.policyVersion,
            protected: false,
            defaultBranch: record.baseBranch,
            dataHandling: settings?.dataHandling
          });
        }

        for (const policy of policyMap().values()) {
          const settings = settingsMap().get(policy.repositoryId);
          const policyOrganizationId =
            settings?.organizationId ??
            listRecords().find((record) => record.repositoryId === policy.repositoryId)
              ?.organizationId;
          if (organizationId && policyOrganizationId !== organizationId) {
            continue;
          }
          if (!repositories.has(policy.repositoryId)) {
            repositories.set(policy.repositoryId, {
              id: policy.repositoryId,
              ...(policyOrganizationId ? { organizationId: policyOrganizationId } : {}),
              fullName: policy.repositoryId,
              enabled: settings?.enabled ?? true,
              mode: settings?.mode ?? policy.mode,
              currentPolicyPack: policy.policyPackId,
              currentPolicyVersion: policy.version,
              protected: false,
              defaultBranch: "main",
              dataHandling: settings?.dataHandling
            });
          }
        }

        for (const settings of settingsMap().values()) {
          if (organizationId && settings.organizationId !== organizationId) {
            continue;
          }
          if (!repositories.has(settings.repositoryId)) {
            repositories.set(settings.repositoryId, {
              id: settings.repositoryId,
              organizationId: settings.organizationId,
              fullName: settings.repositoryId,
              enabled: settings.enabled,
              mode: settings.mode ?? defaultMode,
              protected: false,
              defaultBranch: "main",
              dataHandling: settings.dataHandling
            });
          }
        }

        return [...repositories.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
      },
      async getActivePolicy(repositoryId) {
        return policyMap().get(repositoryId);
      },
      async saveActivePolicy(policy) {
        policyMap().set(policy.repositoryId, policy);
        return policy;
      },
      async updateSettings({ repositoryId, patch, defaultDataHandling, defaultMode }) {
        const existingRecord = listRecords().find((record) => record.repositoryId === repositoryId);
        const existingPolicy = policyMap().get(repositoryId);
        const existingSettings = settingsMap().get(repositoryId);
        if (!existingRecord && !existingPolicy && !existingSettings) {
          throw new Error("Repository must exist before updating settings.");
        }
        if (patch.policyVersion && existingPolicy?.version !== patch.policyVersion) {
          throw new Error("Requested policy version is not available for this repository.");
        }
        const dataHandling = {
          ...(existingSettings?.dataHandling ?? defaultDataHandling),
          ...(repositoryDataHandlingPatch(patch) ?? {})
        };
        const nextSettings: RepositorySettingsState = {
          repositoryId,
          organizationId: existingRecord?.organizationId ?? existingSettings?.organizationId,
          enabled: patch.enabled ?? existingSettings?.enabled ?? true,
          mode:
            patch.mode ?? existingSettings?.mode ?? existingPolicy?.mode ?? existingRecord?.mode,
          dataHandling,
          updatedAt: new Date().toISOString()
        };
        settingsMap().set(repositoryId, nextSettings);
        if (patch.ownerMappings) {
          const organizationId = nextSettings.organizationId ?? "org_local";
          const mapped = patch.ownerMappings.map((mapping) => {
            const now = new Date().toISOString();
            return {
              id: `owner_mapping:${repositoryId}:${mapping.ownerKey}`,
              organizationId,
              repositoryId,
              ownerKey: mapping.ownerKey,
              reviewer: mapping.reviewer,
              reviewerType: mapping.reviewerType,
              createdAt: now,
              updatedAt: now
            } satisfies OwnerMappingState;
          });
          if (state) {
            state.ownerMappings = [
              ...state.ownerMappings.filter((mapping) => mapping.repositoryId !== repositoryId),
              ...mapped
            ];
          } else {
            ownerMappings = [
              ...ownerMappings.filter((mapping) => mapping.repositoryId !== repositoryId),
              ...mapped
            ];
          }
        }
        const repositoryOwnerMappings = listOwnerMappings()
          .filter((mapping) => mapping.repositoryId === repositoryId)
          .sort((a, b) =>
            `${a.repositoryId ?? ""}:${a.ownerKey}`.localeCompare(
              `${b.repositoryId ?? ""}:${b.ownerKey}`
            )
          );
        return {
          organizationId: nextSettings.organizationId ?? "org_local",
          repository: {
            id: repositoryId,
            enabled: nextSettings.enabled,
            mode: nextSettings.mode ?? defaultMode,
            dataHandling
          },
          ownerMappings: repositoryOwnerMappings
        };
      },
      async listOwnerMappings(repositoryId) {
        return listOwnerMappings()
          .filter((mapping) => !repositoryId || mapping.repositoryId === repositoryId)
          .sort((a, b) =>
            `${a.repositoryId ?? ""}:${a.ownerKey}`.localeCompare(
              `${b.repositoryId ?? ""}:${b.ownerKey}`
            )
          );
      },
      async listGithubInstallationRepositories({ organizationId, accountLogin }) {
        return [...settingsMap().values()]
          .filter(
            (settings) =>
              settings.organizationId === organizationId &&
              settings.repositoryId.startsWith(`${accountLogin}/`)
          )
          .map((settings) => ({
            fullName: settings.repositoryId,
            githubRepositoryId: stableInMemoryGithubRepositoryId(settings.repositoryId).toString()
          }));
      },
      async syncGithubInstallation({ organizationId, installation }) {
        const now = new Date().toISOString();
        for (const repo of installation.repositoriesAdded) {
          if (!repo.fullName) {
            continue;
          }
          settingsMap().set(repo.fullName, {
            repositoryId: repo.fullName,
            organizationId,
            enabled: true,
            updatedAt: now
          });
        }
        for (const repo of installation.repositoriesRemoved) {
          if (!repo.fullName) {
            continue;
          }
          const existing = settingsMap().get(repo.fullName);
          settingsMap().set(repo.fullName, {
            repositoryId: repo.fullName,
            organizationId,
            enabled: false,
            mode: existing?.mode,
            dataHandling: existing?.dataHandling,
            updatedAt: now
          });
        }
      },
      async archiveGithubRepositories({ organizationId, repositoriesRemoved }) {
        const now = new Date().toISOString();
        for (const repo of repositoriesRemoved) {
          if (!repo.fullName) {
            continue;
          }
          const existing = settingsMap().get(repo.fullName);
          settingsMap().set(repo.fullName, {
            repositoryId: repo.fullName,
            organizationId,
            enabled: false,
            mode: existing?.mode,
            dataHandling: existing?.dataHandling,
            updatedAt: now
          });
        }
      }
    },
    evaluationSnapshots: {
      async ensurePolicyVersion(input) {
        return ensurePolicyVersionSnapshot(input);
      },
      async persist(input) {
        const policyVersion = ensurePolicyVersionSnapshot(input);
        const explanation = [
          `${input.record.checkStatus}:${input.record.lifecycle}`,
          ...input.record.verifiedFindings.map((finding) => finding.evidence)
        ];
        const snapshot: EvaluationSnapshotState = {
          id: `evaluation:${input.record.id}:${listEvaluationSnapshots().length + 1}`,
          organizationId: input.organizationId,
          repositoryId: input.repositoryId,
          pullRequestId: input.pullRequestId,
          policyVersionId: policyVersion.id,
          mode: input.record.mode,
          status: input.record.checkStatus,
          headSha: input.record.headSha,
          completedAt: input.record.updatedAt,
          explanation,
          verifiedFindings: input.record.verifiedFindings,
          requiredEvidence: input.record.requiredEvidence,
          requiredReviewers: input.record.requiredReviewers,
          checkRun: {
            conclusion: checkConclusionForRecord(input.record),
            outputTitle: "AgentForge Merge Guard",
            outputSummary: explanation.join(" "),
            updatedAt: input.record.updatedAt
          }
        };
        if (state) {
          state.evaluationSnapshots = [...state.evaluationSnapshots, snapshot];
        } else {
          evaluationSnapshots = [...evaluationSnapshots, snapshot];
        }
      }
    },
    webhookDeliveries: {
      async recordReceived(envelope) {
        if (!state) {
          return { duplicate: false, status: "received" };
        }
        const duplicate = state.deliveries.has(envelope.deliveryId);
        state.deliveries.add(envelope.deliveryId);
        return { duplicate, status: duplicate ? "queued" : "received" };
      },
      async markQueued(deliveryId) {
        state?.deliveries.add(deliveryId);
      },
      async markCompleted(deliveryId) {
        state?.deliveries.add(deliveryId);
      },
      async markEnqueueFailed(deliveryId) {
        state?.deliveries.add(deliveryId);
      },
      async markReplayed() {
        return;
      },
      async findReplayable(target, organizationId) {
        if (!state) {
          return undefined;
        }
        if (!hasCompleteWebhookReplayTarget(target)) {
          return undefined;
        }
        const candidates = [...state.queuedEvaluations].reverse();
        const queued = target.deliveryId
          ? candidates.find((item) => item.deliveryId === target.deliveryId)
          : candidates.find(
              (item) =>
                item.envelope.repository?.fullName === target.repositoryFullName &&
                item.envelope.pullRequest?.number === target.pullRequestNumber
            );
        if (!queued) {
          return undefined;
        }
        const matchingRecord = state.records.find(
          (record) => record.repositoryFullName === queued.envelope.repository?.fullName
        );
        const deliveryOrganizationId = matchingRecord?.organizationId ?? "org_local";
        if (organizationId && deliveryOrganizationId !== organizationId) {
          return undefined;
        }
        return {
          envelope: queued.envelope,
          delivery: {
            deliveryId: queued.deliveryId,
            event: queued.envelope.event,
            action: queued.envelope.action ?? null,
            organizationId: deliveryOrganizationId,
            repositoryId: matchingRecord?.repositoryId ?? null,
            repositoryFullName: queued.envelope.repository?.fullName ?? null,
            pullRequestNumber: queued.envelope.pullRequest?.number ?? null,
            headSha:
              queued.envelope.pullRequest?.headSha ?? queued.envelope.checkRun?.headSha ?? null,
            enqueued: true,
            deliveryStatus: "queued",
            payloadJson: {},
            createdAt: queued.queuedAt
          }
        };
      },
      async listRecentFailures() {
        return [];
      }
    },
    githubInstallations: {
      async upsertPending(input) {
        const existing = listGithubInstallations().find(
          (row) => row.githubInstallationId === input.githubInstallationId
        );
        if (existing?.organizationId && existing.organizationId !== input.organizationId) {
          return undefined;
        }
        if (!existing && !input.accountLogin) {
          return undefined;
        }
        const now = new Date().toISOString();
        const status = existing?.status === "approved" ? "approved" : "pending_approval";
        const row: GitHubInstallationState = {
          id: existing?.id ?? `github_installation:${input.githubInstallationId}`,
          organizationId: input.organizationId,
          githubInstallationId: input.githubInstallationId,
          accountLogin:
            input.accountLogin ??
            existing?.accountLogin ??
            `installation-${input.githubInstallationId}`,
          accountType: input.accountType ?? existing?.accountType ?? "Organization",
          status,
          ...(status === "approved" && existing?.approvedBy
            ? { approvedBy: existing.approvedBy }
            : {}),
          ...(status === "approved" && existing?.approvedAt
            ? { approvedAt: existing.approvedAt }
            : {}),
          lastWebhookAt: now,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now
        };
        saveGithubInstallations([
          row,
          ...listGithubInstallations().filter((item) => item.id !== row.id)
        ]);
        return row;
      },
      async approve(input) {
        const existing = listGithubInstallations().find(
          (row) => row.id === input.id && row.organizationId === input.organizationId
        );
        if (!existing) {
          return undefined;
        }
        const now = new Date().toISOString();
        const row: GitHubInstallationState = {
          id: existing.id,
          organizationId: input.organizationId,
          githubInstallationId: existing.githubInstallationId,
          accountLogin: existing.accountLogin,
          accountType: existing.accountType,
          status: "approved",
          approvedBy: input.actor,
          approvedAt: now,
          lastWebhookAt: existing.lastWebhookAt,
          createdAt: existing.createdAt,
          updatedAt: now
        };
        saveGithubInstallations([
          row,
          ...listGithubInstallations().filter((item) => item.id !== row.id)
        ]);
        return row;
      },
      async reject(input) {
        const existing = listGithubInstallations().find(
          (row) => row.id === input.id && row.organizationId === input.organizationId
        );
        if (!existing) {
          return undefined;
        }
        const now = new Date().toISOString();
        const row: GitHubInstallationState = {
          id: existing.id,
          ...(existing.organizationId ? { organizationId: existing.organizationId } : {}),
          githubInstallationId: existing.githubInstallationId,
          accountLogin: existing.accountLogin,
          accountType: existing.accountType,
          status: "rejected",
          rejectedBy: input.actor,
          rejectedAt: now,
          archivedAt: now,
          lastWebhookAt: existing.lastWebhookAt,
          createdAt: existing.createdAt,
          updatedAt: now
        };
        saveGithubInstallations([
          row,
          ...listGithubInstallations().filter((item) => item.id !== row.id)
        ]);
        return row;
      },
      async list(organizationId) {
        return listGithubInstallations()
          .filter((row) => row.organizationId === organizationId)
          .sort(
            (left, right) =>
              left.status.localeCompare(right.status) ||
              right.updatedAt.localeCompare(left.updatedAt)
          );
      },
      async summary(organizationId) {
        const rows = listGithubInstallations().filter(
          (row) => row.organizationId === organizationId && !row.archivedAt
        );
        return {
          installation: rows
            .filter((row) => row.status === "approved")
            .sort((left, right) =>
              (right.approvedAt ?? "").localeCompare(left.approvedAt ?? "")
            )[0],
          pendingApprovalCount: rows.filter((row) => row.status === "pending_approval").length
        };
      },
      async recordWebhook(envelope) {
        const installation = envelope.installation;
        if (!installation) {
          return undefined;
        }
        const existing = listGithubInstallations().find(
          (row) => row.githubInstallationId === String(installation.id)
        );
        const now = new Date().toISOString();
        const archiveAction =
          envelope.event === "installation" &&
          (envelope.action === "deleted" || envelope.action === "suspend");
        const status = archiveAction
          ? "archived"
          : existing?.status === "approved"
            ? "approved"
            : "pending_approval";
        const row: GitHubInstallationState = {
          id: existing?.id ?? `github_installation:${installation.id}`,
          ...(existing?.organizationId ? { organizationId: existing.organizationId } : {}),
          githubInstallationId: String(installation.id),
          accountLogin:
            installation.accountLogin ||
            existing?.accountLogin ||
            `installation-${installation.id}`,
          accountType: installation.accountType || existing?.accountType || "Organization",
          status,
          ...(status === "approved" && existing?.approvedBy
            ? { approvedBy: existing.approvedBy }
            : {}),
          ...(status === "approved" && existing?.approvedAt
            ? { approvedAt: existing.approvedAt }
            : {}),
          ...(archiveAction ? { archivedAt: now } : {}),
          lastWebhookAt: now,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now
        };
        saveGithubInstallations([
          row,
          ...listGithubInstallations().filter((item) => item.id !== row.id)
        ]);
        saveGithubInstallationEvents([
          ...listGithubInstallationEvents(),
          {
            githubInstallationId: row.githubInstallationId,
            installation,
            createdAt: now
          }
        ]);
        return row;
      },
      async listStoredInstallationEvents(githubInstallationId) {
        return listGithubInstallationEvents()
          .filter((event) => event.githubInstallationId === githubInstallationId)
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
          .map((event) => event.installation);
      }
    },
    metrics: {
      async domainCounts() {
        return {
          webhookDeliveriesByStatus: {
            recorded: state?.deliveries.size ?? 0
          },
          recordsByStatus: countItemsBy(listRecords(), (record) => record.checkStatus),
          checkRuns: 0,
          exports: listExports().length,
          auditEventsByAction: countItemsBy(listAuditEvents(), (event) => event.action)
        };
      }
    }
  };
}

export function auditEventsForRecordExport(
  auditEvents: AuditEventRecord[],
  records: ChangeControlRecord[]
): AuditEventRecord[] {
  const repositoryIds = new Set(records.map((record) => record.repositoryId));
  const recordIds = new Set(records.map((record) => record.id));
  const organizationId = records[0]?.organizationId;
  if ((repositoryIds.size === 0 && recordIds.size === 0) || !organizationId) {
    return [];
  }
  return auditEvents.filter(
    (event) =>
      event.organizationId === organizationId &&
      ((event.targetType === "change_control_record" && recordIds.has(event.targetId)) ||
        (event.repositoryId ? repositoryIds.has(event.repositoryId) : false))
  );
}

function stableInMemoryGithubRepositoryId(value: string): bigint {
  let hash = 0n;
  for (const char of value) {
    hash = (hash * 31n + BigInt(char.charCodeAt(0))) % 9_007_199_254_740_991n;
  }
  return hash || 1n;
}

function repositoryDataHandlingPatch(
  patch: RepositorySettingsPatch
): Partial<RepositoryDataHandlingState> | undefined {
  const output: Partial<RepositoryDataHandlingState> = {};
  const nested = patch.dataHandling;
  const fullDiffRetention = nested?.fullDiffRetention ?? patch.fullDiffRetention;
  if (typeof nested?.sourceCodeStorage === "boolean") {
    output.sourceCodeStorage = nested.sourceCodeStorage;
  }
  if (
    fullDiffRetention === "disabled" ||
    fullDiffRetention === "7d" ||
    fullDiffRetention === "30d" ||
    fullDiffRetention === "custom"
  ) {
    output.fullDiffRetention = fullDiffRetention;
  }
  if (typeof nested?.redactSecrets === "boolean") {
    output.redactSecrets = nested.redactSecrets;
  }
  if (typeof nested?.llmFeatures === "boolean") {
    output.llmFeatures = nested.llmFeatures;
  }
  if (typeof nested?.auditRecordRetentionDays === "number") {
    output.auditRecordRetentionDays = nested.auditRecordRetentionDays;
  }
  if (patch.sourceCodeStorage !== undefined) {
    output.sourceCodeStorage = patch.sourceCodeStorage;
  }
  if (patch.redactSecrets !== undefined) {
    output.redactSecrets = patch.redactSecrets;
  }
  if (patch.llmFeatures !== undefined) {
    output.llmFeatures = patch.llmFeatures;
  }
  if (patch.auditRecordRetentionDays !== undefined) {
    output.auditRecordRetentionDays = patch.auditRecordRetentionDays;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

export function checkConclusionForRecord(
  record: Pick<ChangeControlRecord, "mode" | "checkStatus">
): "success" | "neutral" | "failure" {
  if (record.mode === "observe") {
    return "success";
  }
  if (record.mode === "warn") {
    return "neutral";
  }
  return record.checkStatus === "block" ? "failure" : "success";
}

function countItemsBy<T>(items: T[], getKey: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((accumulator, item) => {
    const key = getKey(item);
    accumulator[key] = (accumulator[key] ?? 0) + 1;
    return accumulator;
  }, {});
}

export function filterAndSortRecords(
  records: ChangeControlRecord[],
  query: RecordPageQuery
): ChangeControlRecord[] {
  return [...records]
    .filter(
      (record) =>
        (!query.organizationId || record.organizationId === query.organizationId) &&
        (!query.repositoryId || record.repositoryId === query.repositoryId) &&
        (!query.status || record.checkStatus === query.status) &&
        (!query.lifecycle || record.lifecycle === query.lifecycle) &&
        (!query.mode || record.mode === query.mode) &&
        (!query.policyVersion || record.policyVersion === query.policyVersion) &&
        (!query.queue || recordRequiresAction(record))
    )
    .sort((a, b) => compareRecords(a, b, query.sort));
}

export function recordRequiresAction(record: ChangeControlRecord): boolean {
  return (
    record.checkStatus === "block" ||
    record.requiredEvidence.some((item) => item.status !== "approved") ||
    record.requiredReviewers.some((item) => item.tier === "required" && !item.approved)
  );
}

export function paginateRecords(
  records: ChangeControlRecord[],
  query: RecordPageQuery
): RecordPage {
  return {
    records: records.slice(query.offset, query.offset + query.limit),
    pageInfo: pageInfo(records.length, query)
  };
}

export function pageInfo(total: number, query: RecordPageQuery): PageInfo {
  const nextOffset = query.offset + query.limit;
  const hasMore = nextOffset < total;
  return {
    limit: query.limit,
    offset: query.offset,
    total,
    ...(hasMore ? { nextOffset } : {}),
    hasMore
  };
}

function compareRecords(
  a: ChangeControlRecord,
  b: ChangeControlRecord,
  sort: RecordPageQuery["sort"]
): number {
  if (sort === "created_asc") {
    return a.createdAt.localeCompare(b.createdAt);
  }
  if (sort === "created_desc") {
    return b.createdAt.localeCompare(a.createdAt);
  }
  if (sort === "updated_asc") {
    return a.updatedAt.localeCompare(b.updatedAt);
  }
  if (sort === "pr_asc") {
    return a.pullRequestNumber - b.pullRequestNumber;
  }
  if (sort === "pr_desc") {
    return b.pullRequestNumber - a.pullRequestNumber;
  }
  return b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt);
}
