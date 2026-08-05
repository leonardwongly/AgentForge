import { randomUUID } from "node:crypto";
import type { Queue } from "bullmq";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  type AuditEventRecord,
  getMembershipCacheKey,
  type ChangeControlRecord,
  type OverrideRecord,
  type PullRequestInput
} from "@agentforge/core";
import type { PrismaClient } from "@agentforge/db";
import {
  formatMergeGuardCheck,
  normalizeGithubWebhook,
  shouldEnqueueEvaluation,
  verifyGithubSignature,
  type GithubWebhookEnvelope
} from "@agentforge/github";
import {
  builtinPolicyPacks,
  getPolicyPack,
  hashPolicy,
  parsePolicyYaml,
  validatePolicyYaml
} from "@agentforge/policy";
import {
  applyOverride,
  createAuditEvent,
  exportChangeControlRecordsCsv,
  exportChangeControlRecordsJson,
  exportComplianceEvidencePackageJson,
  explainChangeControlRecord,
  generatePolicyTuningReport,
  proposePolicyTuningActions,
  sanitizeChangeControlRecord,
  withEvidenceDrafts
} from "@agentforge/records";
import { streamAuditEvents } from "@agentforge/notifications";
import { previewCodeowners } from "@agentforge/reviewers";
import { summarizeSafeSnippet, type MetadataStoragePolicy } from "@agentforge/security";
import {
  isAuthzFailure,
  requireApiActor,
  requireOrganizationAccess,
  requireRole,
  resolveApiActor,
  type ApiActor,
  type AuthzFailure
} from "../auth.js";
import { evaluateFixturePr } from "../evaluation.js";
import type { AppState } from "../app.js";
import type { loadConfig } from "@agentforge/config";
import type {
  ExportJob,
  ManualCcrMutationInput,
  ManualCcrMutationResult,
  ReplayableDelivery,
  RepositoryPolicyState,
  RepositoryPolicyVersionSummary,
  WebhookDeliveryStatus,
  WebhookReplayTarget
} from "../ports.js";

type RawBodyRequest = {
  rawBody?: Buffer;
};

const AGENTFORGE_VERSION = "1.1.0";

type RouteSchema<T = unknown> = {
  safeParse: (value: unknown) =>
    | { success: true; data: T }
    | {
        success: false;
        error: {
          issues: Array<{ path: PropertyKey[]; message: string }>;
          flatten: () => Record<string, unknown>;
        };
      };
};

type ApiConfig = ReturnType<typeof loadConfig>;
type MergeGuardEvaluationJobPayload = {
  deliveryId: string;
  envelope: GithubWebhookEnvelope;
};
type EvaluationQueue = Queue<MergeGuardEvaluationJobPayload> | undefined;
type QueueBackend = "redis" | "in_memory";
type QueueEnqueueResult = {
  jobId: string;
  deliveryId: string;
  backend: QueueBackend;
};
type QueueStatus = {
  status: "ready" | "not_ready";
  backend: QueueBackend;
  retryPolicy: Record<string, unknown>;
  counts: Record<string, number>;
  failedJobs: Array<Record<string, unknown>>;
  error?: { errorClass: string; message: string };
};
type AuditInput = Record<string, unknown>;
type OwnerMapping = {
  organizationId?: string | undefined;
  ownerKey: string;
  reviewer: string;
  reviewerType: "user" | "team";
  id?: string | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};
type RepositorySummary = {
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
};
type GithubInstallationSummary = {
  connected: boolean;
  [key: string]: unknown;
};
type GithubInstallation = {
  id: string;
  organizationId?: string | undefined;
  githubInstallationId: string;
  accountLogin?: string | undefined;
  accountType?: string | undefined;
  status?: string | undefined;
};
type RepositorySettingsPatch = {
  enabled?: boolean | undefined;
  mode?: ChangeControlRecord["mode"] | undefined;
  policyVersion?: string | undefined;
  dataHandling?: Record<string, unknown> | undefined;
  ownerMappings?: OwnerMapping[] | undefined;
  sourceCodeStorage?: boolean | undefined;
  fullDiffRetention?: string | undefined;
  redactSecrets?: boolean | undefined;
  llmFeatures?: boolean | undefined;
  auditRecordRetentionDays?: number | undefined;
};
type RepositorySettingsResult = {
  organizationId: string;
  repository: RepositorySummary;
  ownerMappings: OwnerMapping[];
};
type RecordPageQuery = {
  limit: number;
  offset: number;
  repositoryId?: string | undefined;
  status?: ChangeControlRecord["checkStatus"] | undefined;
  lifecycle?: ChangeControlRecord["lifecycle"] | undefined;
  mode?: ChangeControlRecord["mode"] | undefined;
  policyVersion?: string | undefined;
  queue?: "action_required" | undefined;
  sort: "updated_desc" | "updated_asc" | "created_desc" | "created_asc" | "pr_asc" | "pr_desc";
};
type PageInfo = {
  limit: number;
  offset: number;
  total: number;
  hasNextPage: boolean;
};
type PaginatedRecords = { records: ChangeControlRecord[]; pageInfo: PageInfo };
type QueueReplayTarget = WebhookReplayTarget;
type GithubInstallationVerifyInput = {
  githubInstallationId: string;
  accountLogin?: string | undefined;
  accountType: "Organization" | "User";
};
type GithubInstallationDecisionInput = { reason?: string | undefined };
type ExportRequest = { format: "json" | "csv"; maxRecords: number; offset: number };
type CompliancePackageRequest = ExportRequest & {
  format: "json";
  repositoryId?: string | undefined;
  policyPackId?: string | undefined;
  policyVersion?: string | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
};
type EvidenceSubmission = {
  evidenceId?: string | undefined;
  kind?: string | undefined;
  content: string;
  expectedRevision?: number | undefined;
};
type EvidenceRejection = {
  recordId: string;
  expectedRevision?: number | undefined;
  reason: string;
};
type RecordScopedAction = { recordId: string; expectedRevision?: number | undefined };
type PolicyUpdateInput = { contentYaml: string };
type PolicyRevertInput = { targetVersionId: string };
type PolicyPreviewInput = {
  contentYaml?: string | undefined;
  pr: PullRequestInput;
  persist?: boolean | undefined;
};
type CodeownersPreviewInput = { content: string; changedPaths?: string[] | undefined };

type ResolvedApiRouteContext = {
  apiCache: { del: (key: string) => Promise<unknown> };
  audit: (input: AuditInput) => Promise<unknown>;
  approveGithubInstallation: (input: {
    id: string;
    organizationId: string;
    actor: string;
  }) => Promise<GithubInstallation | undefined>;
  collectPrometheusMetrics: () => Promise<string>;
  commitManualCcrMutation: (input: ManualCcrMutationInput) => Promise<{
    result: ManualCcrMutationResult;
    reevaluation?: {
      deliveryId: string;
      status: "queued" | "enqueue_failed";
      recoverable?: boolean | undefined;
    };
  }>;
  config: ApiConfig;
  defaultDataHandlingSettings: () => Promise<Record<string, unknown>>;
  enqueueMergeGuardEvaluation: (input: {
    state: AppState;
    evaluationQueue: EvaluationQueue;
    deliveryId: string;
    envelope: GithubWebhookEnvelope;
    jobId?: string;
  }) => Promise<QueueEnqueueResult>;
  evaluationQueue: EvaluationQueue;
  fetchGithubInstallationAccount: (
    config: ApiConfig,
    githubInstallationId: string
  ) => Promise<{ accountLogin: string; accountType: "Organization" | "User" } | undefined>;
  findReplayableDelivery: (
    target: QueueReplayTarget,
    organizationId?: string
  ) => Promise<ReplayableDelivery | undefined>;
  findRepositoryIdByFullName: (fullName: string) => Promise<string | undefined>;
  getExportJob: (id: string) => Promise<ExportJob | undefined>;
  getRecord: (id: string) => Promise<ChangeControlRecord | undefined>;
  getRecordPolicyConfig: (record: ChangeControlRecord) => Promise<{
    overrides: {
      allowed_roles: string[];
      require_reason: boolean;
      visible_in_pr: boolean;
      audit: boolean;
    };
  }>;
  getRepositoryModeOverride: (
    repositoryId: string
  ) => Promise<ChangeControlRecord["mode"] | undefined>;
  getRepositoryPolicy: (repositoryId: string) => Promise<RepositoryPolicyState | undefined>;
  getRepositoryPolicyVersion: (
    repositoryId: string,
    policyVersionId: string
  ) => Promise<RepositoryPolicyState | undefined>;
  githubCredentialsConfigured: (config: ApiConfig) => boolean;
  githubInstallationSummary: (organizationId: string) => Promise<GithubInstallationSummary>;
  githubInstallUrl: (config: ApiConfig) => string | undefined;
  headerValue: (value: string | string[] | undefined) => string | undefined;
  isRecoverableWebhookDeliveryForEnqueue: (status: WebhookDeliveryStatus) => boolean;
  listAuditEvents: (organizationId?: string) => Promise<AuditEventRecord[]>;
  listAuditEventsForRecordExport: (records: ChangeControlRecord[]) => Promise<AuditEventRecord[]>;
  listGithubInstallations: (organizationId: string) => Promise<GithubInstallation[]>;
  listOwnerMappings: () => Promise<OwnerMapping[]>;
  listRecords: () => Promise<ChangeControlRecord[]>;
  listRecentWebhookDeliveryFailures: (
    organizationId?: string
  ) => Promise<Array<Record<string, unknown>>>;
  listRepositories: (organizationId?: string) => Promise<RepositorySummary[]>;
  listRepositoryPolicyVersions: (repositoryId: string) => Promise<RepositoryPolicyVersionSummary[]>;
  markWebhookDeliveryCompleted: (deliveryId: string) => Promise<void>;
  markWebhookDeliveryEnqueueFailed: (deliveryId: string, error: unknown) => Promise<void>;
  markWebhookDeliveryQueued: (deliveryId: string, queueJobId: string) => Promise<void>;
  markWebhookDeliveryReplayed: (deliveryId: string, actor: string) => Promise<void>;
  onboardingStepsFromRuntime: (input: {
    repositories: RepositorySummary[];
    records: ChangeControlRecord[];
    githubConnected: boolean;
    ownerMappingsConfigured: boolean;
  }) => unknown;
  ownerMappingForApi: (mapping: OwnerMapping) => Record<string, unknown>;
  prisma: PrismaClient | undefined;
  runtimeStore: "postgres" | "in_memory";
  processGithubInstallationWebhook: (envelope: GithubWebhookEnvelope) => Promise<void>;
  queueOperationalStatus: (input: {
    state: AppState;
    evaluationQueue: EvaluationQueue;
  }) => Promise<QueueStatus>;
  recomputeRequirementStatus: (
    record: ChangeControlRecord,
    now?: string
  ) => ChangeControlRecord;
  rejectGithubInstallation: (input: {
    id: string;
    organizationId: string;
    actor: string;
  }) => Promise<GithubInstallation | undefined>;
  repositoryOrganizationId: (repositoryId: string) => Promise<string | undefined>;
  repositoryReadinessScore: (input: {
    repositories: RepositorySummary[];
    records: ChangeControlRecord[];
    githubConnected: boolean;
    ownerMappingsConfigured: boolean;
  }) => unknown;
  recordsVisibleTo: (actor: ApiActor) => Promise<ChangeControlRecord[]>;
  recordRequiresAction: (record: ChangeControlRecord) => boolean;
  filterAndSortRecords: (
    records: ChangeControlRecord[],
    query: RecordPageQuery
  ) => ChangeControlRecord[];
  paginateRecords: (records: ChangeControlRecord[], query: RecordPageQuery) => PaginatedRecords;
  dashboardSummary: (records: ChangeControlRecord[]) => Record<string, unknown>;
  groupBy: <T>(items: T[], getKey: (item: T) => string) => Record<string, number>;
  requireReadActor: (request: FastifyRequest, reply: FastifyReply) => Promise<ApiActor | undefined>;
  routingDiagnosticsFromOwnerMappings: (
    mappings: OwnerMapping[],
    githubConnected: boolean
  ) => unknown;
  runtimeCapabilities: (input: { postgres: boolean; redisQueue: boolean }) => unknown;
  safe: <T>(value: T) => T;
  safeErrorSummary: (error: unknown) => { errorClass: string; message: string };
  saveAuditEvent: (event: AuditEventRecord) => Promise<void>;
  saveExportJob: (job: ExportJob, actor: string, actorRole: string) => Promise<void>;
  saveOverrideRecord: (record: OverrideRecord) => Promise<void>;
  saveRecord: (record: ChangeControlRecord, pr?: PullRequestInput) => Promise<ChangeControlRecord>;
  saveRepositoryPolicy: (
    repositoryId: string,
    contentYaml: string,
    actor: string,
    parsed: ReturnType<typeof parsePolicyYaml>
  ) => Promise<RepositoryPolicyState>;
  saveRepositorySettings: (
    repositoryId: string,
    patch: RepositorySettingsPatch
  ) => Promise<RepositorySettingsResult>;
  state: AppState;
  storagePolicy: MetadataStoragePolicy;
  syncRepositoriesFromCurrentGithubInstallation: (installation: {
    organizationId?: string | undefined;
    githubInstallationId: string;
    accountLogin?: string | undefined;
    accountType?: string | undefined;
  }) => Promise<unknown>;
  syncRepositoriesFromStoredInstallationEvents: (
    installation: GithubInstallation
  ) => Promise<unknown>;
  upsertPendingGithubInstallation: (
    input: GithubInstallationVerifyInput & { organizationId: string }
  ) => Promise<GithubInstallation | undefined>;
  recordWebhookDeliveryReceived: (envelope: GithubWebhookEnvelope) => Promise<{
    duplicate: boolean;
    status: WebhookDeliveryStatus;
  }>;
  codeownersPreviewSchema: RouteSchema<CodeownersPreviewInput>;
  compliancePackageRequestSchema: RouteSchema<CompliancePackageRequest>;
  evidenceRejectionSchema: RouteSchema<EvidenceRejection>;
  evidenceSubmissionSchema: RouteSchema<EvidenceSubmission>;
  exportRequestSchema: RouteSchema<ExportRequest>;
  githubInstallationDecisionSchema: RouteSchema<GithubInstallationDecisionInput>;
  githubInstallationVerifySchema: RouteSchema<GithubInstallationVerifyInput>;
  policyPreviewSchema: RouteSchema<PolicyPreviewInput>;
  policyRevertSchema: RouteSchema<PolicyRevertInput>;
  policyUpdateSchema: RouteSchema<PolicyUpdateInput>;
  queueReplaySchema: RouteSchema<QueueReplayTarget>;
  recordPageQuerySchema: RouteSchema<RecordPageQuery>;
  recordScopedActionSchema: RouteSchema<RecordScopedAction>;
  overrideRequestSchema: RouteSchema<{
    actorRole?: string | undefined;
    expectedRevision?: number | undefined;
    reason?: string | undefined;
    scope?: "pr" | "finding" | "evidence" | "reviewer" | undefined;
  }>;
  repositorySettingsPatchSchema: RouteSchema<RepositorySettingsPatch>;
};

type ApiRouteContext = {
  [Key in keyof ResolvedApiRouteContext]: unknown;
};

function manualMutationAuditTrail(input: {
  record: ChangeControlRecord;
  nextRecord: ChangeControlRecord;
  actor: ApiActor;
  requestId: string;
  triggerReason: ManualCcrMutationInput["triggerReason"];
  actionEvent?: AuditEventRecord | undefined;
}): AuditEventRecord[] {
  const deliveryId = `manual:${input.record.id}:r${input.record.revision + 1}`;
  const common = {
    organizationId: input.record.organizationId,
    repositoryId: input.record.repositoryId,
    pullRequestId: input.record.id,
    actor: input.actor.login,
    actorRole: input.actor.role,
    targetType: "change_control_record",
    targetId: input.record.id,
    requestId: input.requestId,
    policyVersion: input.record.policyVersion,
    policyPackId: input.record.policyPackId,
    policyPackVersion: input.record.policyPackVersion
  } as const;
  const reevaluated = createAuditEvent({
    ...common,
    action: "record_reevaluated",
    metadataJson: {
      recordId: input.record.id,
      previousStatus: input.record.checkStatus,
      checkStatus: input.nextRecord.checkStatus,
      lifecycle: input.nextRecord.lifecycle,
      policyVersion: input.record.policyVersion,
      actorRole: input.actor.role
    }
  });
  const requested = createAuditEvent({
    ...common,
    action: "record_reevaluation_requested",
    correlationId: deliveryId,
    metadataJson: {
      recordId: input.record.id,
      reason: input.triggerReason,
      policyVersion: input.record.policyVersion,
      deliveryId,
      expectedRevision: input.record.revision,
      actorRole: input.actor.role
    }
  });
  return [
    ...(input.actionEvent ? [input.actionEvent] : []),
    reevaluated,
    requested
  ];
}

function manualMutationFailure(
  reply: FastifyReply,
  result: Exclude<ManualCcrMutationResult, { status: "committed" }>
) {
  if (result.status === "conflict") {
    return reply.code(409).send({
      error: "Change Control Record changed; reload it before retrying.",
      currentRevision: result.currentRevision
    });
  }
  if (result.status === "trigger_unavailable") {
    return reply.code(409).send({
      error:
        "A current approved GitHub installation and replayable repository delivery are required before this mutation can be committed."
    });
  }
  return reply.code(404).send({ error: "Change Control Record not found" });
}

function authzErrorCode(failure: AuthzFailure): string {
  return failure.statusCode === 401 ? "api_actor_required" : "api_actor_not_authorized";
}

function handleAuthzFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  failure: AuthzFailure,
  errorCode = authzErrorCode(failure)
) {
  request.log.warn(
    {
      code: errorCode,
      method: request.method,
      requestId: request.id,
      route: request.routeOptions.url ?? request.url,
      statusCode: failure.statusCode
    },
    "Authorization failure"
  );
  return reply.code(failure.statusCode).send({
    code: errorCode,
    error: failure.reason,
    requestId: request.id
  });
}

async function requireOperationalEndpointAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  config: ApiConfig,
  endpointName: string
): Promise<true | ReturnType<typeof handleAuthzFailure>> {
  if (config.nodeEnv !== "production") {
    return true;
  }

  const actor = await requireApiActor(request);
  if (isAuthzFailure(actor)) {
    return handleAuthzFailure(request, reply, actor);
  }

  const allowed = requireRole(
    actor,
    ["platform_admin", "engineering_manager", "auditor"],
    endpointName
  );
  if (isAuthzFailure(allowed)) {
    return handleAuthzFailure(request, reply, allowed);
  }

  return true;
}

export function registerApiRoutes(app: FastifyInstance, context: ApiRouteContext): void {
  const {
    apiCache,
    audit,
    approveGithubInstallation,
    codeownersPreviewSchema,
    collectPrometheusMetrics,
    commitManualCcrMutation,
    compliancePackageRequestSchema,
    config,
    dashboardSummary,
    defaultDataHandlingSettings,
    enqueueMergeGuardEvaluation,
    evaluationQueue,
    evidenceRejectionSchema,
    evidenceSubmissionSchema,
    exportRequestSchema,
    filterAndSortRecords,
    findReplayableDelivery,
    findRepositoryIdByFullName,
    fetchGithubInstallationAccount,
    getExportJob,
    getRecord,
    getRecordPolicyConfig,
    getRepositoryModeOverride,
    getRepositoryPolicy,
    getRepositoryPolicyVersion,
    githubCredentialsConfigured,
    githubInstallationDecisionSchema,
    githubInstallationSummary,
    githubInstallationVerifySchema,
    githubInstallUrl,
    headerValue,
    isRecoverableWebhookDeliveryForEnqueue,
    listAuditEvents,
    listAuditEventsForRecordExport,
    listGithubInstallations,
    listOwnerMappings,
    listRecentWebhookDeliveryFailures,
    listRecords,
    listRepositories,
    listRepositoryPolicyVersions,
    markWebhookDeliveryCompleted,
    markWebhookDeliveryEnqueueFailed,
    markWebhookDeliveryQueued,
    markWebhookDeliveryReplayed,
    onboardingStepsFromRuntime,
    ownerMappingForApi,
    paginateRecords,
    policyPreviewSchema,
    policyRevertSchema,
    policyUpdateSchema,
    prisma,
    runtimeStore,
    processGithubInstallationWebhook,
    queueOperationalStatus,
    queueReplaySchema,
    recordPageQuerySchema,
    recordScopedActionSchema,
    overrideRequestSchema,
    recordsVisibleTo,
    recomputeRequirementStatus,
    rejectGithubInstallation,
    repositoryOrganizationId,
    repositoryReadinessScore,
    repositorySettingsPatchSchema,
    requireReadActor,
    routingDiagnosticsFromOwnerMappings,
    runtimeCapabilities,
    safe,
    safeErrorSummary,
    saveAuditEvent,
    saveExportJob,
    saveOverrideRecord,
    saveRecord,
    saveRepositoryPolicy,
    saveRepositorySettings,
    state,
    storagePolicy,
    syncRepositoriesFromCurrentGithubInstallation,
    syncRepositoriesFromStoredInstallationEvents,
    upsertPendingGithubInstallation,
    recordWebhookDeliveryReceived,
    recordRequiresAction,
    groupBy
  } = context as ResolvedApiRouteContext;

  void app.register(async function systemRoutes(app) {
    app.get("/health", async () => ({
      status: "ok",
      version: AGENTFORGE_VERSION
    }));

    app.get(
      "/ready",
      {
        config: {
          rateLimit: {
            max: config.nodeEnv === "test" ? 1_000 : 60,
            timeWindow: "1 minute"
          }
        }
      },
      async (request, reply) => {
        const operationalAccess = await requireOperationalEndpointAccess(
          request,
          reply,
          config,
          "Readiness inspection"
        );
        if (operationalAccess !== true) {
          return operationalAccess;
        }

        const queue = await queueOperationalStatus({ state, evaluationQueue });
        const ready = queue.status === "ready";
        return reply.code(ready ? 200 : 503).send({
          status: ready ? "ready" : "not_ready",
          database: config.databaseUrl ? "configured" : "not_configured",
          workerQueue: config.redisUrl ? "configured" : "in_memory",
          runtimeStore,
          queue,
          version: AGENTFORGE_VERSION
        });
      }
    );

    app.get(
      "/metrics",
      {
        config: {
          rateLimit: {
            max: config.nodeEnv === "test" ? 1_000 : 60,
            timeWindow: "1 minute"
          }
        }
      },
      async (request, reply) => {
        const operationalAccess = await requireOperationalEndpointAccess(
          request,
          reply,
          config,
          "Metrics inspection"
        );
        if (operationalAccess !== true) {
          return operationalAccess;
        }

        const body = await collectPrometheusMetrics();
        return reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8").send(body);
      }
    );
  });

  void app.register(async function githubWebhookRoutes(app) {
    app.post("/webhooks/github", async (request, reply) => {
      const deliveryId = headerValue(request.headers["x-github-delivery"]);
      const event = headerValue(request.headers["x-github-event"]);
      const signature = headerValue(request.headers["x-hub-signature-256"]);
      const rawBody =
        (request as RawBodyRequest).rawBody ?? Buffer.from(JSON.stringify(request.body ?? {}));

      if (!deliveryId || !event) {
        return reply.code(400).send({ error: "Missing GitHub webhook headers" });
      }
      if (config.github.webhookSecret) {
        const valid = verifyGithubSignature({
          secret: config.github.webhookSecret,
          rawBody,
          signatureHeader: signature
        });
        if (!valid) {
          return reply.code(401).send({ error: "Invalid GitHub webhook signature" });
        }
      } else if (!config.github.allowUnsignedWebhooks) {
        return reply.code(401).send({ error: "GitHub webhook secret is required" });
      }

      if (event === "membership") {
        const payload = (request.body ?? {}) as Record<string, any>;
        const org =
          typeof payload.organization?.login === "string" ? payload.organization.login : undefined;
        const teamSlug = typeof payload.team?.slug === "string" ? payload.team.slug : undefined;
        const username =
          typeof payload.member?.login === "string" ? payload.member.login : undefined;

        if (org && teamSlug && username) {
          const key = getMembershipCacheKey(org, teamSlug, username);
          await apiCache.del(key);
          app.log.info(
            { key, org, teamSlug, username },
            "Evicted membership cache key due to membership webhook event"
          );
        }
      }

      const envelope = normalizeGithubWebhook({
        deliveryId,
        event,
        payload: request.body as Record<string, unknown>
      });
      const shouldQueue = shouldEnqueueEvaluation(envelope);
      const delivery = await recordWebhookDeliveryReceived(envelope);
      await processGithubInstallationWebhook(envelope);

      if (!shouldQueue) {
        await markWebhookDeliveryCompleted(deliveryId);
        return reply.code(202).send({
          accepted: true,
          duplicate: delivery.duplicate,
          enqueued: false,
          deliveryStatus: "completed"
        });
      }

      if (!isRecoverableWebhookDeliveryForEnqueue(delivery.status)) {
        return reply.code(202).send({
          accepted: true,
          duplicate: true,
          enqueued: delivery.status !== "received" && delivery.status !== "enqueue_failed",
          deliveryStatus: delivery.status
        });
      }

      try {
        const queued = await enqueueMergeGuardEvaluation({
          state,
          evaluationQueue,
          deliveryId,
          envelope
        });
        await markWebhookDeliveryQueued(deliveryId, queued.jobId);
      } catch (error) {
        await markWebhookDeliveryEnqueueFailed(deliveryId, error);
        app.log.error(
          {
            deliveryId,
            event,
            error: safeErrorSummary(error)
          },
          "Failed to enqueue Merge Guard evaluation for webhook delivery"
        );
        return reply.code(503).send({
          accepted: true,
          duplicate: delivery.duplicate,
          enqueued: false,
          deliveryStatus: "enqueue_failed",
          error: "Webhook delivery was recorded but evaluation enqueue failed; GitHub may retry."
        });
      }

      return reply.code(202).send({
        accepted: true,
        duplicate: delivery.duplicate,
        enqueued: true,
        deliveryStatus: "queued"
      });
    });
  });

  void app.register(async function queueAdminRoutes(app) {
    app.get("/api/admin/queue", async (request, reply) => {
      const actor = await requireApiActor(request);
      if (isAuthzFailure(actor)) {
        return handleAuthzFailure(request, reply, actor);
      }
      const allowed = requireRole(actor, ["platform_admin"], "Queue inspection");
      if (isAuthzFailure(allowed)) {
        return handleAuthzFailure(request, reply, allowed);
      }

      const queue = await queueOperationalStatus({ state, evaluationQueue });
      const deliveryFailures = await listRecentWebhookDeliveryFailures(actor.organizationId);
      return {
        queue: safe(queue),
        deliveryFailures: safe(deliveryFailures),
        payloadsIncluded: false
      };
    });

    app.post("/api/admin/queue/replay", async (request, reply) => {
      const actor = await requireApiActor(request);
      if (isAuthzFailure(actor)) {
        return handleAuthzFailure(request, reply, actor);
      }
      const allowed = requireRole(actor, ["platform_admin"], "Webhook replay");
      if (isAuthzFailure(allowed)) {
        return handleAuthzFailure(request, reply, allowed);
      }
      const parsed = queueReplaySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: parsed.error.issues[0]?.message ?? "Invalid replay request" });
      }

      const replayable = await findReplayableDelivery(parsed.data, actor.organizationId);
      if (!replayable) {
        return reply.code(404).send({ error: "Replayable webhook delivery was not found." });
      }
      const replayOrganizationId =
        replayable.delivery.organizationId ??
        (replayable.delivery.repositoryId
          ? await repositoryOrganizationId(replayable.delivery.repositoryId)
          : undefined);
      if (!replayOrganizationId) {
        return reply
          .code(403)
          .send({ error: "Webhook replay requires a tenant-scoped delivery record." });
      }
      const tenantAccess = requireOrganizationAccess(actor, replayOrganizationId, "Webhook replay");
      if (!tenantAccess.ok) {
        return handleAuthzFailure(request, reply, tenantAccess);
      }
      if (!shouldEnqueueEvaluation(replayable.envelope)) {
        return reply.code(400).send({ error: "Webhook delivery is not an evaluation event." });
      }

      const replayJobId = `replay:${replayable.envelope.deliveryId}:${randomUUID()}`;
      let queued: QueueEnqueueResult;
      try {
        queued = await enqueueMergeGuardEvaluation({
          state,
          evaluationQueue,
          deliveryId: replayable.envelope.deliveryId,
          envelope: replayable.envelope,
          jobId: replayJobId
        });
        await markWebhookDeliveryQueued(replayable.envelope.deliveryId, queued.jobId);
      } catch (error) {
        await markWebhookDeliveryEnqueueFailed(replayable.envelope.deliveryId, error);
        const summary = safeErrorSummary(error);
        request.log.error(
          {
            deliveryId: replayable.envelope.deliveryId,
            error: summary
          },
          "Failed to enqueue replayed webhook delivery"
        );
        await audit({
          organizationId: replayOrganizationId,
          repositoryId: replayable.delivery.repositoryId ?? undefined,
          actor: actor.login,
          actorRole: actor.role,
          action: "webhook_replay_enqueue_failed",
          targetType: "webhook_delivery",
          targetId: replayable.envelope.deliveryId,
          source: "api",
          requestId: request.id,
          correlationId: replayable.envelope.deliveryId,
          metadataJson: {
            deliveryId: replayable.envelope.deliveryId,
            replayJobId,
            errorClass: summary.errorClass,
            repositoryFullName: replayable.delivery.repositoryFullName,
            pullRequestNumber: replayable.delivery.pullRequestNumber
          }
        });
        return reply.code(503).send({
          replayed: false,
          deliveryId: replayable.envelope.deliveryId,
          error: "Webhook replay enqueue failed."
        });
      }
      await markWebhookDeliveryReplayed(replayable.envelope.deliveryId, actor.login);
      await audit({
        organizationId: replayOrganizationId,
        repositoryId: replayable.delivery.repositoryId ?? undefined,
        actor: actor.login,
        actorRole: actor.role,
        action: "webhook_replayed",
        targetType: "webhook_delivery",
        targetId: replayable.envelope.deliveryId,
        source: "api",
        requestId: request.id,
        correlationId: replayable.envelope.deliveryId,
        metadataJson: {
          deliveryId: replayable.envelope.deliveryId,
          replayJobId,
          backend: queued.backend,
          repositoryFullName: replayable.delivery.repositoryFullName,
          pullRequestNumber: replayable.delivery.pullRequestNumber
        }
      });

      return reply.code(202).send({
        replayed: true,
        jobId: queued.jobId,
        backend: queued.backend,
        deliveryId: queued.deliveryId,
        repositoryFullName: replayable.delivery.repositoryFullName,
        pullRequestNumber: replayable.delivery.pullRequestNumber,
        payloadIncluded: false
      });
    });

    // SIEM-style streaming of tamper-evident audit events (G7). Best-effort;
    // requires AUDIT_STREAM_WEBHOOK_URL and a platform-admin actor.
    app.post("/api/admin/audit-stream", async (request, reply) => {
      const actor = await requireApiActor(request);
      if (isAuthzFailure(actor)) {
        return handleAuthzFailure(request, reply, actor);
      }
      const allowed = requireRole(actor, ["platform_admin"], "Audit stream");
      if (isAuthzFailure(allowed)) {
        return handleAuthzFailure(request, reply, allowed);
      }
      if (!config.auditStreamWebhookUrl) {
        return reply.code(400).send({ error: "AUDIT_STREAM_WEBHOOK_URL is not configured." });
      }
      const events = await listAuditEvents(actor.organizationId);
      const result = await streamAuditEvents(config.auditStreamWebhookUrl, events);
      return {
        streamed: result.ok,
        eventCount: events.length,
        status: result.status,
        error: result.error
      };
    });
  });

  void app.register(async function repositorySettingsRoutes(app) {
    app.get("/api/repositories", async (request, reply) => {
      const actor = await requireReadActor(request, reply);
      if (!actor) {
        return;
      }
      return {
        repositories: safe(await listRepositories(actor.organizationId))
      };
    });

    app.get("/api/settings", async (request, reply) => {
      const actor = await requireReadActor(request, reply);
      if (!actor) {
        return;
      }
      const repositories = await listRepositories(actor.organizationId);
      const ownerMappings = (await listOwnerMappings()).filter(
        (mapping) => mapping.organizationId === actor.organizationId
      );
      const githubInstallation = await githubInstallationSummary(actor.organizationId);
      return safe({
        runtimeStore,
        githubInstallation,
        auth: {
          builtInGithubOAuthConfigured: Boolean(
            config.github.clientId && config.github.clientSecret
          ),
          trustedProxyConfigured: config.auth.apiTrustProxyHeaders
        },
        repositories,
        dataHandling: await defaultDataHandlingSettings(),
        ownerMappings: ownerMappings.map(ownerMappingForApi),
        routingDiagnostics: routingDiagnosticsFromOwnerMappings(
          ownerMappings,
          githubInstallation.connected
        ),
        exports: {
          json: true,
          csv: true,
          deliveryModel: "api_job_download",
          storageBucketConfigured: false,
          storageRegion: undefined
        },
        runtimeCapabilities: runtimeCapabilities({
          postgres: Boolean(prisma),
          redisQueue: Boolean(config.redisUrl)
        })
      });
    });

    app.get("/api/onboarding/status", async (request, reply) => {
      const actor = await requireReadActor(request, reply);
      if (!actor) {
        return;
      }
      const repositories = await listRepositories(actor.organizationId);
      const records = await recordsVisibleTo(actor);
      const settings = {
        githubInstallation: await githubInstallationSummary(actor.organizationId),
        ownerMappings: (await listOwnerMappings()).filter(
          (mapping) => mapping.organizationId === actor.organizationId
        )
      };
      return safe({
        steps: onboardingStepsFromRuntime({
          repositories,
          records,
          githubConnected: settings.githubInstallation.connected,
          ownerMappingsConfigured: settings.ownerMappings.length > 0
        }),
        readiness: repositoryReadinessScore({
          repositories,
          records,
          githubConnected: settings.githubInstallation.connected,
          ownerMappingsConfigured: settings.ownerMappings.length > 0
        })
      });
    });

    app.get("/api/github/installations", async (request, reply) => {
      const actor = await requireApiActor(request);
      if (isAuthzFailure(actor)) {
        return handleAuthzFailure(request, reply, actor);
      }
      const allowed = requireRole(
        actor,
        ["platform_admin", "engineering_manager"],
        "GitHub installation administration"
      );
      if (!allowed.ok) {
        return handleAuthzFailure(request, reply, allowed);
      }
      return safe({
        installations: await listGithubInstallations(actor.organizationId),
        installUrl: githubInstallUrl(config),
        credentialsConfigured: githubCredentialsConfigured(config)
      });
    });

    app.post("/api/github/installations/verify", async (request, reply) => {
      const actor = await requireApiActor(request);
      if (isAuthzFailure(actor)) {
        return handleAuthzFailure(request, reply, actor);
      }
      const allowed = requireRole(actor, ["platform_admin"], "GitHub installation verification");
      if (!allowed.ok) {
        return handleAuthzFailure(request, reply, allowed);
      }
      const parsed = githubInstallationVerifySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid GitHub installation verification request",
          details: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message
          }))
        });
      }
      const githubAccount = parsed.data.accountLogin
        ? undefined
        : await fetchGithubInstallationAccount(config, parsed.data.githubInstallationId);
      const installation = await upsertPendingGithubInstallation({
        ...parsed.data,
        accountLogin: parsed.data.accountLogin ?? githubAccount?.accountLogin,
        accountType: githubAccount?.accountType ?? parsed.data.accountType,
        organizationId: actor.organizationId
      });
      if (!installation) {
        return reply.code(409).send({
          error:
            "GitHub installation must be confirmed by webhook delivery or manual account details before approval."
        });
      }
      await audit({
        organizationId: actor.organizationId,
        actor: actor.login,
        actorRole: actor.role,
        action: "github_installation_verification_recorded",
        targetType: "github_installation",
        targetId: installation.id,
        requestId: request.id,
        metadataJson: {
          githubInstallationId: installation.githubInstallationId,
          accountLogin: installation.accountLogin,
          accountType: installation.accountType,
          status: installation.status,
          organizationId: actor.organizationId
        }
      });
      return safe({ installation });
    });

    app.post("/api/github/installations/:id/approve", async (request, reply) => {
      const actor = await requireApiActor(request);
      if (isAuthzFailure(actor)) {
        return handleAuthzFailure(request, reply, actor);
      }
      const allowed = requireRole(actor, ["platform_admin"], "GitHub installation approval");
      if (!allowed.ok) {
        return handleAuthzFailure(request, reply, allowed);
      }
      const parsed = githubInstallationDecisionSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid GitHub installation approval request" });
      }
      const installation = await approveGithubInstallation({
        id: (request.params as { id: string }).id,
        organizationId: actor.organizationId,
        actor: actor.login
      });
      if (!installation) {
        return reply.code(404).send({ error: "GitHub installation was not found." });
      }
      await syncRepositoriesFromStoredInstallationEvents(installation);
      await syncRepositoriesFromCurrentGithubInstallation({
        organizationId: installation.organizationId,
        githubInstallationId: installation.githubInstallationId,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType
      });
      await audit({
        organizationId: actor.organizationId,
        actor: actor.login,
        actorRole: actor.role,
        action: "github_installation_approved",
        targetType: "github_installation",
        targetId: installation.id,
        requestId: request.id,
        metadataJson: {
          githubInstallationId: installation.githubInstallationId,
          accountLogin: installation.accountLogin,
          reason: parsed.data.reason,
          organizationId: actor.organizationId
        }
      });
      return safe({ installation });
    });

    app.post("/api/github/installations/:id/reject", async (request, reply) => {
      const actor = await requireApiActor(request);
      if (isAuthzFailure(actor)) {
        return handleAuthzFailure(request, reply, actor);
      }
      const allowed = requireRole(actor, ["platform_admin"], "GitHub installation rejection");
      if (!allowed.ok) {
        return handleAuthzFailure(request, reply, allowed);
      }
      const parsed = githubInstallationDecisionSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid GitHub installation rejection request" });
      }
      const installation = await rejectGithubInstallation({
        id: (request.params as { id: string }).id,
        organizationId: actor.organizationId,
        actor: actor.login
      });
      if (!installation) {
        return reply.code(404).send({ error: "GitHub installation was not found." });
      }
      await audit({
        organizationId: actor.organizationId,
        actor: actor.login,
        actorRole: actor.role,
        action: "github_installation_rejected",
        targetType: "github_installation",
        targetId: installation.id,
        requestId: request.id,
        metadataJson: {
          githubInstallationId: installation.githubInstallationId,
          accountLogin: installation.accountLogin,
          reason: parsed.data.reason,
          organizationId: actor.organizationId
        }
      });
      return safe({ installation });
    });

    app.patch("/api/repositories/:id/settings", async (request, reply) => {
      const actor = await requireApiActor(request);
      if (isAuthzFailure(actor)) {
        return handleAuthzFailure(request, reply, actor);
      }
      const allowed = requireRole(
        actor,
        ["platform_admin", "engineering_manager"],
        "Repository settings update"
      );
      if (!allowed.ok) {
        return handleAuthzFailure(request, reply, allowed);
      }
      const repositoryId = (request.params as { id: string }).id;
      const organizationId = await repositoryOrganizationId(repositoryId);
      if (!organizationId) {
        return reply.code(404).send({ error: "Repository not found" });
      }
      const tenantAccess = requireOrganizationAccess(
        actor,
        organizationId,
        "Repository settings update"
      );
      if (!tenantAccess.ok) {
        return handleAuthzFailure(request, reply, tenantAccess);
      }
      const parsed = repositorySettingsPatchSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid repository settings",
          details: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message
          }))
        });
      }
      try {
        const settings = await saveRepositorySettings(repositoryId, parsed.data);
        const auditEvents = [];
        const changedRepositoryState =
          parsed.data.enabled !== undefined ||
          parsed.data.mode !== undefined ||
          parsed.data.policyVersion !== undefined;
        const changedRetention = Boolean(
          parsed.data.dataHandling ||
          parsed.data.sourceCodeStorage !== undefined ||
          parsed.data.fullDiffRetention !== undefined ||
          parsed.data.redactSecrets !== undefined ||
          parsed.data.llmFeatures !== undefined ||
          parsed.data.auditRecordRetentionDays !== undefined
        );
        if (changedRepositoryState) {
          auditEvents.push(
            await audit({
              organizationId: settings.organizationId,
              repositoryId,
              actor: actor.login,
              actorRole: actor.role,
              action: "repository_settings_changed",
              targetType: "repository",
              targetId: repositoryId,
              requestId: request.id,
              metadataJson: {
                enabled: settings.repository.enabled,
                mode: settings.repository.mode,
                policyVersion: parsed.data.policyVersion,
                actorRole: actor.role
              }
            })
          );
        }
        if (changedRetention) {
          auditEvents.push(
            await audit({
              organizationId: settings.organizationId,
              repositoryId,
              actor: actor.login,
              actorRole: actor.role,
              action: "retention_changed",
              targetType: "repository_setting",
              targetId: repositoryId,
              requestId: request.id,
              metadataJson: {
                dataHandling: settings.repository.dataHandling,
                actorRole: actor.role
              }
            })
          );
        }
        if (parsed.data.ownerMappings) {
          auditEvents.push(
            await audit({
              organizationId: settings.organizationId,
              repositoryId,
              actor: actor.login,
              actorRole: actor.role,
              action: "owner_mapping_changed",
              targetType: "owner_mapping",
              targetId: repositoryId,
              requestId: request.id,
              metadataJson: {
                ownerMappings: settings.ownerMappings.map(ownerMappingForApi),
                actorRole: actor.role
              }
            })
          );
        }
        return {
          id: repositoryId,
          updated: true,
          repository: safe(settings.repository),
          ownerMappings: safe(settings.ownerMappings.map(ownerMappingForApi)),
          auditEvents: safe(auditEvents)
        };
      } catch (error) {
        return reply.code(404).send({
          error: error instanceof Error ? error.message : "Repository settings could not be updated"
        });
      }
    });
  });

  void app.register(async function policyRoutes(app) {
    app.get("/api/policy-packs", async () => ({ policyPacks: builtinPolicyPacks }));
    app.post("/api/codeowners/preview", async (request, reply) => {
      const actor = await requireReadActor(request, reply);
      if (!actor) {
        return;
      }
      const parsed = codeownersPreviewSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid CODEOWNERS preview request",
          details: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message
          }))
        });
      }
      return safe(
        previewCodeowners(parsed.data.content, parsed.data.changedPaths?.filter(Boolean) ?? [])
      );
    });

    app.get("/api/policy-packs/:id", async (request, reply) => {
      const pack = getPolicyPack((request.params as { id: string }).id);
      if (!pack) {
        return reply.code(404).send({ error: "Policy pack not found" });
      }
      return pack;
    });
    app.post("/api/policy-packs/:id/fork", async (request, reply) => {
      const actor = await requireApiActor(request);
      if (isAuthzFailure(actor)) {
        return handleAuthzFailure(request, reply, actor);
      }
      const allowed = requireRole(
        actor,
        ["platform_admin", "engineering_manager"],
        "Policy pack fork"
      );
      if (!allowed.ok) {
        return handleAuthzFailure(request, reply, allowed);
      }
      const pack = getPolicyPack((request.params as { id: string }).id);
      if (!pack) {
        return reply.code(404).send({ error: "Policy pack not found" });
      }
      return reply.code(201).send({
        ...pack,
        id: `${pack.id}-fork-${Date.now()}`,
        builtIn: false,
        name: `${pack.name} Fork`
      });
    });

    app.get("/api/repositories/:id/policy", async (request, reply) => {
      const actor = await requireReadActor(request, reply);
      if (!actor) {
        return;
      }
      const repositoryId = (request.params as { id: string }).id;
      const organizationId = await repositoryOrganizationId(repositoryId);
      if (!organizationId) {
        return reply.code(404).send({ error: "Repository not found" });
      }
      const tenantAccess = requireOrganizationAccess(actor, organizationId, "Policy access");
      if (!tenantAccess.ok) {
        return handleAuthzFailure(request, reply, tenantAccess);
      }
      const policy = await getRepositoryPolicy(repositoryId);
      if (!policy) {
        return reply
          .code(404)
          .send({ error: "Active policy is not configured for this repository" });
      }
      return {
        repositoryId,
        policy: policy.contentYaml,
        contentHash: policy.contentHash,
        mode: policy.mode,
        version: policy.version,
        policyPackId: policy.policyPackId,
        policyPackVersion: policy.policyPackVersion
      };
    });

    app.put("/api/repositories/:id/policy", async (request, reply) => {
      const actor = await requireApiActor(request);
      if (isAuthzFailure(actor)) {
        return handleAuthzFailure(request, reply, actor);
      }
      const allowed = requireRole(
        actor,
        ["platform_admin", "engineering_manager"],
        "Policy update"
      );
      if (!allowed.ok) {
        return handleAuthzFailure(request, reply, allowed);
      }
      const repositoryId = (request.params as { id: string }).id;
      const organizationId = await repositoryOrganizationId(repositoryId);
      if (!organizationId) {
        return reply.code(404).send({ error: "Repository not found" });
      }
      const tenantAccess = requireOrganizationAccess(actor, organizationId, "Policy update");
      if (!tenantAccess.ok) {
        return handleAuthzFailure(request, reply, tenantAccess);
      }
      const parsedBody = policyUpdateSchema.safeParse(request.body ?? {});
      if (!parsedBody.success) {
        return reply.code(400).send({
          error: "Invalid policy update input",
          details: parsedBody.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message
          }))
        });
      }
      const body = parsedBody.data;
      const validation = validatePolicyYaml(body.contentYaml ?? "");
      if (!validation.valid) {
        return reply.code(400).send(validation);
      }
      const parsed = parsePolicyYaml(body.contentYaml ?? "");
      let policy: RepositoryPolicyState;
      try {
        policy = await saveRepositoryPolicy(
          repositoryId,
          body.contentYaml ?? "",
          actor.login,
          parsed
        );
      } catch (error) {
        return reply.code(404).send({
          error: error instanceof Error ? error.message : "Repository policy could not be updated"
        });
      }
      await audit({
        organizationId,
        repositoryId,
        actor: actor.login,
        actorRole: actor.role,
        action: "policy_changed",
        targetType: "policy",
        targetId: policy.contentHash,
        policyVersion: policy.version,
        policyPackId: policy.policyPackId,
        policyPackVersion: policy.policyPackVersion,
        requestId: request.id,
        metadataJson: {
          contentHash: parsed.contentHash,
          policyVersion: policy.version,
          policyPackId: policy.policyPackId,
          policyPackVersion: policy.policyPackVersion,
          actorRole: actor.role
        }
      });
      return {
        repositoryId,
        contentHash: policy.contentHash,
        version: policy.version,
        valid: true
      };
    });

    app.get("/api/repositories/:id/policy/versions", async (request, reply) => {
      const actor = await requireReadActor(request, reply);
      if (!actor) {
        return;
      }
      const repositoryId = (request.params as { id: string }).id;
      const organizationId = await repositoryOrganizationId(repositoryId);
      if (!organizationId) {
        return reply.code(404).send({ error: "Repository not found" });
      }
      const tenantAccess = requireOrganizationAccess(actor, organizationId, "Policy access");
      if (!tenantAccess.ok) {
        return handleAuthzFailure(request, reply, tenantAccess);
      }
      const versions = await listRepositoryPolicyVersions(repositoryId);
      return { repositoryId, versions };
    });

    app.post(
      "/api/repositories/:id/policy/revert",
      {
        config: {
          rateLimit: {
            max: config.nodeEnv === "test" ? 1_000 : 60,
            timeWindow: "1 minute"
          }
        }
      },
      async (request, reply) => {
        const actor = await requireApiActor(request);
        if (isAuthzFailure(actor)) {
          return handleAuthzFailure(request, reply, actor);
        }
        const allowed = requireRole(
          actor,
          ["platform_admin", "engineering_manager"],
          "Policy revert"
        );
        if (!allowed.ok) {
          return handleAuthzFailure(request, reply, allowed);
        }
        const repositoryId = (request.params as { id: string }).id;
        const organizationId = await repositoryOrganizationId(repositoryId);
        if (!organizationId) {
          return reply.code(404).send({ error: "Repository not found" });
        }
        const tenantAccess = requireOrganizationAccess(actor, organizationId, "Policy revert");
        if (!tenantAccess.ok) {
          return handleAuthzFailure(request, reply, tenantAccess);
        }
        const parsedBody = policyRevertSchema.safeParse(request.body ?? {});
        if (!parsedBody.success) {
          return reply.code(400).send({
            error: "Invalid policy revert input",
            details: parsedBody.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message
            }))
          });
        }
        const { targetVersionId } = parsedBody.data;
        // getRepositoryPolicyVersion is scoped to repositoryId by the persistence
        // layer, so a targetVersionId belonging to a different repository or
        // organization can never resolve here, regardless of what the client sends.
        const targetVersion = await getRepositoryPolicyVersion(repositoryId, targetVersionId);
        if (!targetVersion) {
          return reply.code(404).send({ error: "Target policy version not found" });
        }
        const validation = validatePolicyYaml(targetVersion.contentYaml);
        if (!validation.valid) {
          return reply.code(400).send({
            error:
              "Stored policy version no longer passes validation against the current policy schema and cannot be reverted to.",
            ...validation
          });
        }
        const parsed = parsePolicyYaml(targetVersion.contentYaml);
        let policy: RepositoryPolicyState;
        try {
          policy = await saveRepositoryPolicy(
            repositoryId,
            targetVersion.contentYaml,
            actor.login,
            parsed
          );
        } catch (error) {
          return reply.code(404).send({
            error:
              error instanceof Error ? error.message : "Repository policy could not be reverted"
          });
        }
        await audit({
          organizationId,
          repositoryId,
          actor: actor.login,
          actorRole: actor.role,
          action: "policy_reverted",
          targetType: "policy",
          targetId: policy.contentHash,
          policyVersion: policy.version,
          policyPackId: policy.policyPackId,
          policyPackVersion: policy.policyPackVersion,
          requestId: request.id,
          metadataJson: {
            contentHash: policy.contentHash,
            policyVersion: policy.version,
            policyPackId: policy.policyPackId,
            policyPackVersion: policy.policyPackVersion,
            revertedFromVersion: targetVersion.version,
            actorRole: actor.role
          }
        });
        return {
          repositoryId,
          contentHash: policy.contentHash,
          version: policy.version,
          revertedFromVersion: targetVersion.version,
          valid: true
        };
      }
    );

    app.post("/api/policies/validate", async (request, reply) => {
      const parsedBody = policyUpdateSchema.safeParse(request.body ?? {});
      if (!parsedBody.success) {
        return reply.code(400).send({
          error: "Invalid policy validation input",
          details: parsedBody.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message
          }))
        });
      }
      return validatePolicyYaml(parsedBody.data.contentYaml);
    });

    app.post(
      "/api/policies/preview",
      {
        config: {
          rateLimit: {
            max: config.nodeEnv === "test" ? 1_000 : 60,
            timeWindow: "1 minute"
          }
        }
      },
      async (request, reply) => {
        const parsedBody = policyPreviewSchema.safeParse(request.body ?? {});
        if (!parsedBody.success) {
          return reply.code(400).send({
            error: "Invalid policy preview input",
            details: parsedBody.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message
            }))
          });
        }
        const body = parsedBody.data;
        let actor: ApiActor | undefined;
        const requiresStoredPolicyAccess = body.persist || body.contentYaml === undefined;
        if (requiresStoredPolicyAccess) {
          const resolvedActor = await requireApiActor(request);
          if (isAuthzFailure(resolvedActor)) {
            return handleAuthzFailure(request, reply, resolvedActor);
          }
          actor = resolvedActor;
          if (body.persist) {
            const allowed = requireRole(
              resolvedActor,
              ["platform_admin", "engineering_manager"],
              "Persisted policy preview"
            );
            if (!allowed.ok) {
              return handleAuthzFailure(request, reply, allowed);
            }
          }
        } else {
          actor = await resolveApiActor(request);
        }
        if (!body.pr) {
          return reply.code(400).send({ error: "pull request input is required" });
        }
        if (
          typeof body.pr.repositoryFullName !== "string" ||
          body.pr.repositoryFullName.trim().length === 0
        ) {
          return reply.code(400).send({ error: "pr.repositoryFullName is required" });
        }
        const repositoryId =
          requiresStoredPolicyAccess || actor
            ? await findRepositoryIdByFullName(body.pr.repositoryFullName)
            : undefined;
        const repositoryOrganization = repositoryId
          ? await repositoryOrganizationId(repositoryId)
          : undefined;
        if (repositoryId && !repositoryOrganization) {
          return reply.code(404).send({ error: "Repository not found" });
        }
        if (body.persist && !repositoryId && config.nodeEnv === "production") {
          return reply
            .code(404)
            .send({ error: "Repository must be registered before persisted policy preview" });
        }
        if (repositoryId && actor && repositoryOrganization) {
          const tenantAccess = requireOrganizationAccess(
            actor,
            repositoryOrganization,
            body.persist ? "Persisted policy preview" : "Stored policy preview"
          );
          if (!tenantAccess.ok) {
            return handleAuthzFailure(request, reply, tenantAccess);
          }
        }
        const activePolicy = repositoryId ? await getRepositoryPolicy(repositoryId) : undefined;
        const contentYaml = body.contentYaml ?? activePolicy?.contentYaml;
        if (!contentYaml) {
          return reply
            .code(400)
            .send({ error: "contentYaml is required when the repository has no active policy" });
        }
        const evaluationInput: Parameters<typeof evaluateFixturePr>[0] = {
          pr: body.pr,
          policyYaml: contentYaml,
          organizationId: actor?.organizationId ?? "org_local",
          storagePolicy
        };
        if (repositoryId) {
          evaluationInput.repositoryId = repositoryId;
          const modeOverride = await getRepositoryModeOverride(repositoryId);
          if (modeOverride) {
            evaluationInput.modeOverride = modeOverride;
          }
        }
        const output = evaluateFixturePr(evaluationInput);
        if (!body.persist && actor && repositoryId && activePolicy && repositoryOrganization) {
          const previewContentHash = body.contentYaml
            ? hashPolicy(body.contentYaml)
            : activePolicy.contentHash;
          await audit({
            organizationId: repositoryOrganization,
            repositoryId,
            actor: actor.login,
            actorRole: actor.role,
            action: "policy_previewed",
            targetType: "policy",
            targetId: previewContentHash,
            policyVersion: output.result.policyVersion,
            policyPackId: output.result.policyPackId,
            policyPackVersion: output.result.policyPackVersion,
            requestId: request.id,
            metadataJson: {
              contentHash: previewContentHash,
              mode: output.result.mode,
              status: output.result.status,
              policyVersion: output.result.policyVersion,
              policyPackId: output.result.policyPackId,
              policyPackVersion: output.result.policyPackVersion,
              repositoryFullName: body.pr.repositoryFullName,
              previewPersisted: false,
              actorRole: actor.role
            }
          });
        }
        if (!body.persist) {
          return safe({ ...output, persisted: false });
        }

        if (!actor) {
          const resolvedActor = await requireApiActor(request);
          if (isAuthzFailure(resolvedActor)) {
            return handleAuthzFailure(request, reply, resolvedActor);
          }
          actor = resolvedActor;
        }
        const record = await saveRecord(
          sanitizeChangeControlRecord(output.record, storagePolicy),
          body.pr
        );
        await audit({
          organizationId: record.organizationId,
          repositoryId: record.repositoryId,
          pullRequestId: record.id,
          actor: actor.login,
          actorRole: actor.role,
          action: "check_published",
          targetType: "change_control_record",
          targetId: record.id,
          policyVersion: output.result.policyVersion,
          policyPackId: output.result.policyPackId,
          policyPackVersion: output.result.policyPackVersion,
          requestId: request.id,
          metadataJson: {
            conclusion: output.checkRun.conclusion,
            status: output.result.status,
            mode: output.result.mode,
            policyVersion: output.result.policyVersion,
            policyPackId: output.result.policyPackId,
            policyPackVersion: output.result.policyPackVersion,
            previewPersisted: true,
            actorRole: actor.role
          }
        });
        return safe({ ...output, record, persisted: true });
      }
    );
  });

  void app.register(async function recordEvidenceReviewerRoutes(app) {
    app.get("/api/pull-requests", async (request, reply) => {
      const actor = await requireReadActor(request, reply);
      if (!actor) {
        return;
      }
      return {
        pullRequests: (await recordsVisibleTo(actor)).map((record) => ({
          id: record.id,
          repositoryFullName: record.repositoryFullName,
          pullRequestNumber: record.pullRequestNumber,
          headSha: record.headSha,
          mode: record.mode,
          checkStatus: record.checkStatus,
          missingEvidence: record.requiredEvidence.filter((item) => item.status !== "approved")
            .length,
          pendingReviewers: record.requiredReviewers.filter(
            (item) => item.tier === "required" && !item.approved
          ).length
        }))
      };
    });

    app.get("/api/pull-requests/:id/change-control-record", async (request, reply) => {
      const actor = await requireReadActor(request, reply);
      if (!actor) {
        return;
      }
      const record = await getRecord((request.params as { id: string }).id);
      if (!record) {
        return reply.code(404).send({ error: "Change Control Record not found" });
      }
      const tenantAccess = requireOrganizationAccess(
        actor,
        record.organizationId,
        "Change Control Record access"
      );
      if (!tenantAccess.ok) {
        return handleAuthzFailure(request, reply, tenantAccess);
      }
      return {
        record: sanitizeChangeControlRecord(withEvidenceDrafts(record), storagePolicy),
        explanation: explainChangeControlRecord(record)
      };
    });

    app.get(
      "/api/repositories/:id/pull-requests/:number/change-control-record",
      async (request, reply) => {
        const actor = await requireReadActor(request, reply);
        if (!actor) {
          return;
        }
        const params = request.params as { id: string; number: string };
        const record = (await recordsVisibleTo(actor)).find(
          (item) =>
            item.repositoryId === params.id && item.pullRequestNumber === Number(params.number)
        );
        if (!record) {
          return reply.code(404).send({ error: "Change Control Record not found" });
        }
        return {
          record: sanitizeChangeControlRecord(withEvidenceDrafts(record), storagePolicy),
          explanation: explainChangeControlRecord(record)
        };
      }
    );

    app.post("/api/pull-requests/:id/evidence", async (request, reply) => {
      const actor = await requireApiActor(request);
      if (isAuthzFailure(actor)) {
        return handleAuthzFailure(request, reply, actor);
      }
      const params = request.params as { id: string };
      const record = await getRecord(params.id);
      if (!record) {
        return reply.code(404).send({ error: "Change Control Record not found" });
      }
      const tenantAccess = requireOrganizationAccess(
        actor,
        record.organizationId,
        "Evidence submission"
      );
      if (!tenantAccess.ok) {
        return handleAuthzFailure(request, reply, tenantAccess);
      }
      const parsedBody = evidenceSubmissionSchema.safeParse(request.body ?? {});
      if (!parsedBody.success) {
        return reply.code(400).send({
          error: "Invalid evidence submission",
          details: parsedBody.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message
          }))
        });
      }
      const body = parsedBody.data;
      const matches = body.evidenceId
        ? record.requiredEvidence.filter((item) => item.id === body.evidenceId)
        : record.requiredEvidence.filter((item) => item.kind === body.kind);
      if (!body.evidenceId && matches.length > 1) {
        return reply.code(409).send({
          error: "evidenceId is required when multiple requirements share the same kind."
        });
      }
      const [evidence] = matches;
      if (!evidence) {
        return reply.code(404).send({ error: "Evidence requirement not found" });
      }
      if (body.kind && body.kind !== evidence.kind) {
        return reply.code(400).send({ error: "Evidence kind does not match the requirement id." });
      }
      if (evidence.status === "approved") {
        return reply.code(409).send({ error: "Approved evidence cannot be replaced." });
      }
      const now = new Date().toISOString();
      const nextRecord = structuredClone(record);
      nextRecord.requiredEvidence = nextRecord.requiredEvidence.map((item) =>
        item.id === evidence.id
          ? {
              ...item,
              status: "provided",
              source: "manual_attestation",
              providedBy: actor.login,
              providedAt: now,
              approvedBy: undefined,
              approvedAt: undefined,
              contentSummary: summarizeSafeSnippet(body.content)
            }
          : item
      );
      const recomputed = recomputeRequirementStatus(nextRecord, now);
      const actionEvent = createAuditEvent({
        organizationId: record.organizationId,
        repositoryId: record.repositoryId,
        pullRequestId: record.id,
        actor: actor.login,
        actorRole: actor.role,
        action: "evidence_provided",
        targetType: "evidence_requirement",
        targetId: evidence.id,
        requestId: request.id,
        policyVersion: record.policyVersion,
        policyPackId: record.policyPackId,
        policyPackVersion: record.policyPackVersion,
        metadataJson: {
          kind: evidence.kind,
          recordId: record.id,
          evidenceSource: "manual_attestation",
          actorRole: actor.role
        }
      });
      const mutation = await commitManualCcrMutation({
        organizationId: record.organizationId,
        recordId: record.id,
        expectedRevision: body.expectedRevision ?? record.revision,
        expectedHeadSha: record.headSha,
        expectedPolicyVersion: record.policyVersion,
        nextRecord: recomputed,
        auditEvents: manualMutationAuditTrail({
          record,
          nextRecord: recomputed,
          actor,
          requestId: request.id,
          triggerReason: "evidence_provided",
          actionEvent
        }),
        triggerReason: "evidence_provided"
      });
      if (mutation.result.status !== "committed") {
        return manualMutationFailure(reply, mutation.result);
      }
      return reply
        .code(mutation.reevaluation?.status === "enqueue_failed" ? 202 : 200)
        .send({
          evidence: safe(
            mutation.result.record.requiredEvidence.find((item) => item.id === evidence.id)
          ),
          record: sanitizeChangeControlRecord(mutation.result.record, storagePolicy),
          reevaluation: mutation.reevaluation
        });
    });

    app.patch("/api/evidence/:id/approve", async (request, reply) => {
      const actor = await requireApiActor(request);
      if (isAuthzFailure(actor)) {
        return handleAuthzFailure(request, reply, actor);
      }
      const allowed = requireRole(
        actor,
        ["engineering_manager", "platform_admin", "security_reviewer"],
        "Evidence approval"
      );
      if (!allowed.ok) {
        return handleAuthzFailure(request, reply, allowed);
      }
      const parsedBody = recordScopedActionSchema.safeParse(request.body ?? {});
      if (!parsedBody.success) {
        return reply.code(400).send({
          error: "Invalid evidence approval",
          details: parsedBody.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message
          }))
        });
      }
      const record = await getRecord(parsedBody.data.recordId);
      if (!record || record.organizationId !== actor.organizationId) {
        return reply.code(404).send({ error: "Change Control Record not found" });
      }
      const tenantAccess = requireOrganizationAccess(actor, record.organizationId, "Evidence approval");
      if (!tenantAccess.ok) {
        return handleAuthzFailure(request, reply, tenantAccess);
      }
      const evidence = record.requiredEvidence.find(
        (item) => item.id === (request.params as { id: string }).id
      );
      if (!evidence) {
        return reply.code(404).send({ error: "Evidence requirement not found" });
      }
      if (evidence.status === "missing" || evidence.status === "rejected") {
        return reply
          .code(409)
          .send({ error: "Evidence must be provided before it can be approved." });
      }
      const approvedAt = new Date().toISOString();
      const nextRecord = structuredClone(record);
      nextRecord.requiredEvidence = nextRecord.requiredEvidence.map((item) =>
        item.id === evidence.id
          ? { ...item, status: "approved", approvedBy: actor.login, approvedAt }
          : item
      );
      const recomputed = recomputeRequirementStatus(nextRecord, approvedAt);
      const actionEvent = createAuditEvent({
        organizationId: record.organizationId,
        repositoryId: record.repositoryId,
        pullRequestId: record.id,
        actor: actor.login,
        actorRole: actor.role,
        action: "evidence_approved",
        targetType: "evidence_requirement",
        targetId: evidence.id,
        requestId: request.id,
        policyVersion: record.policyVersion,
        policyPackId: record.policyPackId,
        policyPackVersion: record.policyPackVersion,
        metadataJson: { kind: evidence.kind, recordId: record.id, actorRole: actor.role }
      });
      const mutation = await commitManualCcrMutation({
        organizationId: record.organizationId,
        recordId: record.id,
        expectedRevision: parsedBody.data.expectedRevision ?? record.revision,
        expectedHeadSha: record.headSha,
        expectedPolicyVersion: record.policyVersion,
        nextRecord: recomputed,
        auditEvents: manualMutationAuditTrail({
          record,
          nextRecord: recomputed,
          actor,
          requestId: request.id,
          triggerReason: "evidence_approved",
          actionEvent
        }),
        triggerReason: "evidence_approved"
      });
      if (mutation.result.status !== "committed") {
        return manualMutationFailure(reply, mutation.result);
      }
      return reply
        .code(mutation.reevaluation?.status === "enqueue_failed" ? 202 : 200)
        .send({
          evidence: safe(
            mutation.result.record.requiredEvidence.find((item) => item.id === evidence.id)
          ),
          record: sanitizeChangeControlRecord(mutation.result.record, storagePolicy),
          reevaluation: mutation.reevaluation
        });
    });

    app.patch("/api/evidence/:id/reject", async (request, reply) => {
      const actor = await requireApiActor(request);
      if (isAuthzFailure(actor)) {
        return handleAuthzFailure(request, reply, actor);
      }
      const allowed = requireRole(
        actor,
        ["engineering_manager", "platform_admin", "security_reviewer"],
        "Evidence rejection"
      );
      if (!allowed.ok) {
        return handleAuthzFailure(request, reply, allowed);
      }
      const parsedBody = evidenceRejectionSchema.safeParse(request.body ?? {});
      if (!parsedBody.success) {
        return reply.code(400).send({
          error: "Invalid evidence rejection",
          details: parsedBody.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message
          }))
        });
      }
      const record = await getRecord(parsedBody.data.recordId);
      if (!record || record.organizationId !== actor.organizationId) {
        return reply.code(404).send({ error: "Change Control Record not found" });
      }
      const tenantAccess = requireOrganizationAccess(actor, record.organizationId, "Evidence rejection");
      if (!tenantAccess.ok) {
        return handleAuthzFailure(request, reply, tenantAccess);
      }
      const evidence = record.requiredEvidence.find(
        (item) => item.id === (request.params as { id: string }).id
      );
      if (!evidence) {
        return reply.code(404).send({ error: "Evidence requirement not found" });
      }
      if (evidence.status !== "provided" && evidence.status !== "approved") {
        return reply
          .code(409)
          .send({ error: "Only provided or approved evidence can be rejected." });
      }
      const rejectedAt = new Date().toISOString();
      const reasonSummary = summarizeSafeSnippet(parsedBody.data.reason);
      const nextRecord = structuredClone(record);
      nextRecord.requiredEvidence = nextRecord.requiredEvidence.map((item) =>
        item.id === evidence.id
          ? {
              ...item,
              status: "rejected",
              approvedBy: undefined,
              approvedAt: undefined,
              contentSummary: `Rejected: ${reasonSummary}`,
              providedAt: item.providedAt ?? rejectedAt
            }
          : item
      );
      const recomputed = recomputeRequirementStatus(nextRecord, rejectedAt);
      const actionEvent = createAuditEvent({
        organizationId: record.organizationId,
        repositoryId: record.repositoryId,
        pullRequestId: record.id,
        actor: actor.login,
        actorRole: actor.role,
        action: "evidence_rejected",
        targetType: "evidence_requirement",
        targetId: evidence.id,
        requestId: request.id,
        policyVersion: record.policyVersion,
        policyPackId: record.policyPackId,
        policyPackVersion: record.policyPackVersion,
        metadataJson: {
          kind: evidence.kind,
          reason: reasonSummary,
          recordId: record.id,
          actorRole: actor.role
        }
      });
      const mutation = await commitManualCcrMutation({
        organizationId: record.organizationId,
        recordId: record.id,
        expectedRevision: parsedBody.data.expectedRevision ?? record.revision,
        expectedHeadSha: record.headSha,
        expectedPolicyVersion: record.policyVersion,
        nextRecord: recomputed,
        auditEvents: manualMutationAuditTrail({
          record,
          nextRecord: recomputed,
          actor,
          requestId: request.id,
          triggerReason: "evidence_rejected",
          actionEvent
        }),
        triggerReason: "evidence_rejected"
      });
      if (mutation.result.status !== "committed") {
        return manualMutationFailure(reply, mutation.result);
      }
      return reply
        .code(mutation.reevaluation?.status === "enqueue_failed" ? 202 : 200)
        .send({
          evidence: safe(
            mutation.result.record.requiredEvidence.find((item) => item.id === evidence.id)
          ),
          record: sanitizeChangeControlRecord(mutation.result.record, storagePolicy),
          reevaluation: mutation.reevaluation
        });
    });

    app.patch("/api/reviewers/:id/approve", async (request, reply) => {
      const actor = await requireApiActor(request);
      if (isAuthzFailure(actor)) {
        return handleAuthzFailure(request, reply, actor);
      }
      const parsedBody = recordScopedActionSchema.safeParse(request.body ?? {});
      if (!parsedBody.success) {
        return reply.code(400).send({
          error: "Invalid reviewer approval",
          details: parsedBody.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message
          }))
        });
      }
      const record = await getRecord(parsedBody.data.recordId);
      if (!record || record.organizationId !== actor.organizationId) {
        return reply.code(404).send({ error: "Change Control Record not found" });
      }
      const tenantAccess = requireOrganizationAccess(actor, record.organizationId, "Reviewer approval");
      if (!tenantAccess.ok) {
        return handleAuthzFailure(request, reply, tenantAccess);
      }
      const reviewer = record.requiredReviewers.find(
        (item) => item.id === (request.params as { id: string }).id
      );
      if (!reviewer) {
        return reply.code(404).send({ error: "Reviewer requirement not found" });
      }
      const canApprove =
        actor.login === reviewer.reviewer ||
        ["engineering_manager", "platform_admin", "security_reviewer"].includes(actor.role);
      if (!canApprove) {
        return reply
          .code(403)
          .send({ error: "Reviewer approval requires the reviewer or an authorized role." });
      }
      const approvedAt = new Date().toISOString();
      const nextRecord = structuredClone(record);
      nextRecord.requiredReviewers = nextRecord.requiredReviewers.map((item) =>
        item.id === reviewer.id
          ? {
              ...item,
              approved: true,
              approvalSource: "manual",
              approvedBy: actor.login,
              approvedAt
            }
          : item
      );
      const recomputed = recomputeRequirementStatus(nextRecord, approvedAt);
      const actionEvent = createAuditEvent({
        organizationId: record.organizationId,
        repositoryId: record.repositoryId,
        pullRequestId: record.id,
        actor: actor.login,
        actorRole: actor.role,
        action: "reviewer_approved",
        targetType: "reviewer_requirement",
        targetId: reviewer.id,
        requestId: request.id,
        policyVersion: record.policyVersion,
        policyPackId: record.policyPackId,
        policyPackVersion: record.policyPackVersion,
        metadataJson: {
          reviewer: reviewer.reviewer,
          tier: reviewer.tier,
          recordId: record.id,
          actorRole: actor.role
        }
      });
      const mutation = await commitManualCcrMutation({
        organizationId: record.organizationId,
        recordId: record.id,
        expectedRevision: parsedBody.data.expectedRevision ?? record.revision,
        expectedHeadSha: record.headSha,
        expectedPolicyVersion: record.policyVersion,
        nextRecord: recomputed,
        auditEvents: manualMutationAuditTrail({
          record,
          nextRecord: recomputed,
          actor,
          requestId: request.id,
          triggerReason: "reviewer_approved",
          actionEvent
        }),
        triggerReason: "reviewer_approved"
      });
      if (mutation.result.status !== "committed") {
        return manualMutationFailure(reply, mutation.result);
      }
      return reply
        .code(mutation.reevaluation?.status === "enqueue_failed" ? 202 : 200)
        .send({
          reviewer: safe(
            mutation.result.record.requiredReviewers.find((item) => item.id === reviewer.id)
          ),
          record: sanitizeChangeControlRecord(mutation.result.record, storagePolicy),
          reevaluation: mutation.reevaluation
        });
    });

    app.post("/api/pull-requests/:id/override", async (request, reply) => {
      const actor = await requireApiActor(request);
      if (isAuthzFailure(actor)) {
        return handleAuthzFailure(request, reply, actor);
      }
      const parsedBody = overrideRequestSchema.safeParse(request.body ?? {});
      if (!parsedBody.success) {
        return reply.code(400).send({
          error: "Invalid override request",
          details: parsedBody.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message
          }))
        });
      }
      const body = parsedBody.data;
      const record = await getRecord((request.params as { id: string }).id);
      if (!record) {
        return reply.code(404).send({ error: "Change Control Record not found" });
      }
      const tenantAccess = requireOrganizationAccess(actor, record.organizationId, "Override");
      if (!tenantAccess.ok) {
        return handleAuthzFailure(request, reply, tenantAccess);
      }
      try {
        const policy = await getRecordPolicyConfig(record);
        const output = applyOverride({
          record: structuredClone(record),
          policy: {
            allowedRoles: policy.overrides.allowed_roles,
            requireReason: policy.overrides.require_reason,
            visibleInPr: policy.overrides.visible_in_pr,
            audit: policy.overrides.audit
          },
          override: {
            actor: actor.login,
            actorRole: actor.role,
            reason: body.reason,
            scope: body.scope ?? "pr"
          },
          pullRequestId: record.id
        });
        if (output.auditEvent) {
          output.auditEvent.requestId = request.id;
          output.auditEvent.metadataJson = {
            ...(output.auditEvent.metadataJson ?? {}),
            recordId: record.id,
            requestId: request.id,
            actorRole: actor.role
          };
        }
        const mutation = await commitManualCcrMutation({
          organizationId: record.organizationId,
          recordId: record.id,
          expectedRevision: body.expectedRevision ?? record.revision,
          expectedHeadSha: record.headSha,
          expectedPolicyVersion: record.policyVersion,
          nextRecord: output.record,
          auditEvents: manualMutationAuditTrail({
            record,
            nextRecord: output.record,
            actor,
            requestId: request.id,
            triggerReason: "override_created",
            actionEvent: output.auditEvent
          }),
          override: output.overrideRecord,
          triggerReason: "override_created"
        });
        if (mutation.result.status !== "committed") {
          return manualMutationFailure(reply, mutation.result);
        }
        return reply
          .code(mutation.reevaluation?.status === "enqueue_failed" ? 202 : 201)
          .send({
            override: safe(output.overrideRecord),
            record: sanitizeChangeControlRecord(mutation.result.record, storagePolicy),
            auditEvent: output.auditEvent,
            reevaluation: mutation.reevaluation,
            prVisibleMessage:
              "Merge Guard override recorded. Merge was allowed after authorized override with reason."
          });
      } catch (error) {
        return reply
          .code(403)
          .send({ error: error instanceof Error ? error.message : "Override rejected" });
      }
    });

    app.get("/api/dashboard/summary", async (request, reply) => {
      const actor = await requireReadActor(request, reply);
      if (!actor) {
        return;
      }
      return safe(dashboardSummary(await recordsVisibleTo(actor)));
    });
    app.get("/api/dashboard/records", async (request, reply) => {
      const actor = await requireReadActor(request, reply);
      if (!actor) {
        return;
      }
      const query = recordPageQuerySchema.safeParse(request.query ?? {});
      if (!query.success) {
        return reply.code(400).send({
          error: "Invalid record query parameters",
          details: query.error.flatten().fieldErrors
        });
      }
      const page = paginateRecords(
        filterAndSortRecords(await recordsVisibleTo(actor), query.data),
        query.data
      );
      return {
        records: safe(
          page.records.map((record) => sanitizeChangeControlRecord(record, storagePolicy))
        ),
        pageInfo: page.pageInfo
      };
    });
    app.get("/api/dashboard/blocked-prs", async (request, reply) => {
      const actor = await requireReadActor(request, reply);
      if (!actor) {
        return;
      }
      const query = recordPageQuerySchema.safeParse(request.query ?? {});
      if (!query.success) {
        return reply.code(400).send({
          error: "Invalid blocked PR query parameters",
          details: query.error.flatten().fieldErrors
        });
      }
      const filtered = filterAndSortRecords(await recordsVisibleTo(actor), query.data).filter(
        (record) => recordRequiresAction(record)
      );
      const page = paginateRecords(filtered, query.data);
      return {
        blockedPullRequests: safe(page.records),
        pageInfo: page.pageInfo
      };
    });
    app.get("/api/dashboard/policy-violations", async (request, reply) => {
      const actor = await requireReadActor(request, reply);
      if (!actor) {
        return;
      }
      const query = recordPageQuerySchema.safeParse(request.query ?? {});
      if (!query.success) {
        return reply.code(400).send({
          error: "Invalid policy violation query parameters",
          details: query.error.flatten().fieldErrors
        });
      }
      const page = paginateRecords(
        filterAndSortRecords(await recordsVisibleTo(actor), query.data),
        query.data
      );
      return {
        violations: safe(
          groupBy(
            page.records.flatMap((record) => record.verifiedFindings),
            (finding) => finding.type
          )
        ),
        pageInfo: page.pageInfo
      };
    });
    app.get("/api/dashboard/overrides", async (request, reply) => {
      const actor = await requireReadActor(request, reply);
      if (!actor) {
        return;
      }
      const query = recordPageQuerySchema.safeParse({
        ...(request.query ?? {}),
        lifecycle: "overridden"
      });
      if (!query.success) {
        return reply.code(400).send({
          error: "Invalid override query parameters",
          details: query.error.flatten().fieldErrors
        });
      }
      const page = paginateRecords(
        filterAndSortRecords(await recordsVisibleTo(actor), query.data),
        query.data
      );
      return {
        overrides: safe(page.records),
        pageInfo: page.pageInfo
      };
    });
    app.get("/api/dashboard/evidence-completion", async (request, reply) => {
      const actor = await requireReadActor(request, reply);
      if (!actor) {
        return;
      }
      const query = recordPageQuerySchema.safeParse(request.query ?? {});
      if (!query.success) {
        return reply.code(400).send({
          error: "Invalid evidence query parameters",
          details: query.error.flatten().fieldErrors
        });
      }
      const page = paginateRecords(
        filterAndSortRecords(await recordsVisibleTo(actor), query.data),
        query.data
      );
      const evidence = page.records.flatMap((record) => record.requiredEvidence);
      const complete = evidence.filter((item) => item.status === "approved").length;
      return {
        total: evidence.length,
        complete,
        completionRate: evidence.length === 0 ? 1 : complete / evidence.length,
        evidence: safe(evidence),
        pageInfo: page.pageInfo
      };
    });
    app.get("/api/dashboard/reviewers", async (request, reply) => {
      const actor = await requireReadActor(request, reply);
      if (!actor) {
        return;
      }
      const query = recordPageQuerySchema.safeParse(request.query ?? {});
      if (!query.success) {
        return reply.code(400).send({
          error: "Invalid reviewer query parameters",
          details: query.error.flatten().fieldErrors
        });
      }
      const page = paginateRecords(
        filterAndSortRecords(await recordsVisibleTo(actor), query.data),
        query.data
      );
      return {
        reviewers: safe(page.records.flatMap((record) => record.requiredReviewers)),
        pageInfo: page.pageInfo
      };
    });
    app.get("/api/dashboard/policy-insights", async (request, reply) => {
      const actor = await requireReadActor(request, reply);
      if (!actor) {
        return;
      }
      const query = recordPageQuerySchema.safeParse({ limit: 100, ...(request.query ?? {}) });
      if (!query.success) {
        return reply.code(400).send({
          error: "Invalid policy insight query parameters",
          details: query.error.flatten().fieldErrors
        });
      }
      const page = paginateRecords(
        filterAndSortRecords(await recordsVisibleTo(actor), query.data),
        query.data
      );
      const report = generatePolicyTuningReport(page.records);
      return {
        ...safe(report),
        proposals: safe(proposePolicyTuningActions(report)),
        pageInfo: page.pageInfo
      };
    });
  });

  void app.register(async function exportAuditRoutes(app) {
    app.post("/api/exports/change-control-records", async (request, reply) => {
      const actor = await requireApiActor(request);
      if (isAuthzFailure(actor)) {
        return handleAuthzFailure(request, reply, actor);
      }
      const allowed = requireRole(
        actor,
        ["auditor", "platform_admin", "engineering_manager"],
        "Change Control Record export"
      );
      if (!allowed.ok) {
        return handleAuthzFailure(request, reply, allowed);
      }
      const parsedBody = exportRequestSchema.safeParse(request.body ?? {});
      if (!parsedBody.success) {
        return reply.code(400).send({
          error: "Invalid export request",
          details: parsedBody.error.flatten().fieldErrors
        });
      }
      const { format, maxRecords, offset } = parsedBody.data;
      const matchingRecords = (await listRecords()).filter(
        (record) => record.organizationId === actor.organizationId
      );
      const records = matchingRecords.slice(offset, offset + maxRecords);
      const jobId = randomUUID();
      const auditEvents = await listAuditEventsForRecordExport(records);
      const exportAuditEvent = createAuditEvent({
        organizationId: actor.organizationId,
        actor: actor.login,
        action: "record_exported",
        targetType: "change_control_records_export",
        targetId: jobId,
        actorRole: actor.role,
        requestId: request.id,
        metadataJson: {
          format,
          recordCount: records.length,
          totalMatchingRecords: matchingRecords.length,
          offset,
          maxRecords,
          truncated: offset + records.length < matchingRecords.length,
          recordIds: records.map((record) => record.id),
          repositoryIds: [...new Set(records.map((record) => record.repositoryId))],
          actorRole: actor.role
        }
      });
      const content =
        format === "csv"
          ? exportChangeControlRecordsCsv(records, storagePolicy, [
              ...auditEvents,
              exportAuditEvent
            ])
          : exportChangeControlRecordsJson(records, storagePolicy, [
              ...auditEvents,
              exportAuditEvent
            ]);
      const job: ExportJob = {
        id: jobId,
        organizationId: actor.organizationId,
        status: "completed",
        format,
        recordCount: records.length,
        totalMatchingRecords: matchingRecords.length,
        truncated: offset + records.length < matchingRecords.length,
        content,
        createdAt: new Date().toISOString()
      };
      await saveExportJob(job, actor.login, actor.role);
      await saveAuditEvent(exportAuditEvent);
      return reply.code(201).send({
        id: job.id,
        status: job.status,
        recordCount: job.recordCount,
        totalMatchingRecords: job.totalMatchingRecords,
        truncated: job.truncated
      });
    });

    app.post("/api/exports/compliance-evidence-package", async (request, reply) => {
      const actor = await requireApiActor(request);
      if (isAuthzFailure(actor)) {
        return handleAuthzFailure(request, reply, actor);
      }
      const allowed = requireRole(
        actor,
        ["auditor", "platform_admin"],
        "Compliance evidence package export"
      );
      if (!allowed.ok) {
        return handleAuthzFailure(request, reply, allowed);
      }
      const parsedBody = compliancePackageRequestSchema.safeParse(request.body ?? {});
      if (!parsedBody.success) {
        return reply.code(400).send({
          error: "Invalid compliance evidence package request",
          details: parsedBody.error.flatten().fieldErrors
        });
      }
      const {
        format,
        maxRecords,
        offset,
        repositoryId,
        policyPackId,
        policyVersion,
        startDate,
        endDate
      } = parsedBody.data;
      const matchingRecords = (await listRecords())
        .filter((record) => record.organizationId === actor.organizationId)
        .filter((record) => !repositoryId || record.repositoryId === repositoryId)
        .filter((record) => !policyPackId || record.policyPackId === policyPackId)
        .filter((record) => !policyVersion || record.policyVersion === policyVersion)
        .filter((record) => !startDate || Date.parse(record.updatedAt) >= Date.parse(startDate))
        .filter((record) => !endDate || Date.parse(record.updatedAt) <= Date.parse(endDate))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      const records = matchingRecords.slice(offset, offset + maxRecords);
      const jobId = randomUUID();
      const auditEvents = await listAuditEventsForRecordExport(records);
      const filters = {
        repositoryId,
        policyPackId,
        policyVersion,
        startDate,
        endDate,
        maxRecords,
        offset,
        totalMatchingRecords: matchingRecords.length,
        truncated: offset + records.length < matchingRecords.length
      };
      const exportAuditEvent = createAuditEvent({
        organizationId: actor.organizationId,
        actor: actor.login,
        action: "record_exported",
        targetType: "compliance_evidence_package_export",
        targetId: jobId,
        actorRole: actor.role,
        requestId: request.id,
        metadataJson: {
          format,
          recordCount: records.length,
          totalMatchingRecords: matchingRecords.length,
          offset,
          maxRecords,
          truncated: offset + records.length < matchingRecords.length,
          recordIds: records.map((record) => record.id),
          repositoryIds: [...new Set(records.map((record) => record.repositoryId))],
          policyPackIds: [...new Set(records.map((record) => record.policyPackId).filter(Boolean))],
          controlPackage: "compliance_evidence",
          actorRole: actor.role
        }
      });
      const content = exportComplianceEvidencePackageJson({
        records,
        storagePolicy,
        auditEvents: [...auditEvents, exportAuditEvent],
        filters
      });
      const job: ExportJob = {
        id: jobId,
        organizationId: actor.organizationId,
        status: "completed",
        format,
        recordCount: records.length,
        totalMatchingRecords: matchingRecords.length,
        truncated: offset + records.length < matchingRecords.length,
        content,
        createdAt: new Date().toISOString()
      };
      await saveExportJob(job, actor.login, actor.role);
      await saveAuditEvent(exportAuditEvent);
      return reply.code(201).send({
        id: job.id,
        status: job.status,
        recordCount: job.recordCount,
        totalMatchingRecords: job.totalMatchingRecords,
        truncated: job.truncated,
        packageType: "compliance_evidence"
      });
    });

    app.get("/api/exports/:id", async (request, reply) => {
      const actor = await requireApiActor(request);
      if (isAuthzFailure(actor)) {
        return handleAuthzFailure(request, reply, actor);
      }
      const allowed = requireRole(
        actor,
        ["auditor", "platform_admin", "engineering_manager"],
        "Change Control Record export"
      );
      if (!allowed.ok) {
        return handleAuthzFailure(request, reply, allowed);
      }
      const job = await getExportJob((request.params as { id: string }).id);
      if (!job) {
        return reply.code(404).send({ error: "Export job not found" });
      }
      const tenantAccess = requireOrganizationAccess(
        actor,
        job.organizationId,
        "Export job access"
      );
      if (!tenantAccess.ok) {
        return handleAuthzFailure(request, reply, tenantAccess);
      }
      return job;
    });

    app.get("/api/audit-events", async (request, reply) => {
      const actor = await requireApiActor(request);
      if (isAuthzFailure(actor)) {
        return handleAuthzFailure(request, reply, actor);
      }
      const allowed = requireRole(
        actor,
        ["auditor", "platform_admin", "engineering_manager"],
        "Audit event access"
      );
      if (!allowed.ok) {
        return handleAuthzFailure(request, reply, allowed);
      }
      return { auditEvents: safe(await listAuditEvents(actor.organizationId)) };
    });

    app.get("/api/check-output/:recordId", async (request, reply) => {
      const actor = await requireReadActor(request, reply);
      if (!actor) {
        return;
      }
      const record = await getRecord((request.params as { recordId: string }).recordId);
      if (!record) {
        return reply.code(404).send({ error: "Change Control Record not found" });
      }
      const tenantAccess = requireOrganizationAccess(
        actor,
        record.organizationId,
        "Check output access"
      );
      if (!tenantAccess.ok) {
        return handleAuthzFailure(request, reply, tenantAccess);
      }
      return formatMergeGuardCheck({
        mode: record.mode,
        status: record.checkStatus,
        policyVersion: record.policyVersion,
        policyPackId: record.policyPackId,
        policyPackVersion: record.policyPackVersion,
        findings: record.verifiedFindings,
        requiredEvidence: record.requiredEvidence,
        requiredReviewers: record.requiredReviewers,
        explanation: [],
        evaluatedAt: record.updatedAt
      });
    });
  });
}
