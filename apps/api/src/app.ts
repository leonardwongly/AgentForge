import { createHash, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import { z } from "zod";
import { loadConfig } from "@agentforge/config";
import type {
  AuditEventRecord,
  ChangeControlRecord,
  EvidenceRequirement,
  OverrideRecord,
  PullRequestInput
} from "@agentforge/core";
import {
  MERGE_GUARD_EVALUATION_ATTEMPTS,
  MERGE_GUARD_EVALUATION_BACKOFF_MS,
  MERGE_GUARD_EVALUATION_JOB_NAME,
  MERGE_GUARD_EVALUATION_QUEUE,
  RedisCacheManager,
  getMembershipCacheKey
} from "@agentforge/core";
import { PrismaClient } from "@agentforge/db";
import {
  createGithubAppToken,
  createGithubInstallationToken,
  formatMergeGuardCheck,
  normalizeGithubWebhook,
  shouldEnqueueEvaluation,
  verifyGithubSignature,
  type GithubWebhookEnvelope
} from "@agentforge/github";
import {
  builtinPolicyPacks,
  getPolicyPack,
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
  sanitizeChangeControlRecord
} from "@agentforge/records";
import { previewCodeowners } from "@agentforge/reviewers";
import {
  sanitizeForMetadataStorage,
  summarizeSafeSnippet,
  type MetadataStoragePolicy
} from "@agentforge/security";
import {
  isAuthzFailure,
  requireApiActor,
  requireOrganizationAccess,
  requireRole,
  type ApiActor
} from "./auth.js";
import { evaluateFixturePr } from "./evaluation.js";
import {
  createInMemoryPersistencePort,
  filterAndSortRecords,
  hasCompleteWebhookReplayTarget,
  pageInfo,
  paginateRecords,
  recordRequiresAction,
  type ExportJob,
  type PersistencePort,
  type ReplayableDelivery,
  type StoredWebhookDelivery,
  type WebhookDeliveryStatus
} from "./ports.js";
import { registerApiRoutes } from "./routes/api-routes.js";
import {
  countBy,
  groupBy,
  headerValue,
  metricLine,
  percent,
  prometheusLabelValue
} from "./pure.js";

type QueuedEvaluation = {
  id: string;
  deliveryId: string;
  envelope: GithubWebhookEnvelope;
  queuedAt: string;
};

type MergeGuardEvaluationJobPayload = {
  deliveryId: string;
  envelope: GithubWebhookEnvelope;
};

type QueueBackend = "redis" | "in_memory";

type QueueEnqueueResult = {
  jobId: string;
  deliveryId: string;
  backend: QueueBackend;
};

type RepositoryInstallationRow = {
  fullName: string;
  githubRepositoryId: bigint;
};

type CountGroup<Key extends string> = Record<Key, string | null> & {
  _count: { _all: number };
};

type WebhookFailureRow = {
  deliveryId: string;
  deliveryStatus: string | null;
  queueJobId: string | null;
  repositoryFullName: string | null;
  pullRequestNumber: number | null;
  headSha: string | null;
  evaluationAttemptsMade: number;
  evaluationTerminalFailure: boolean;
  lastEnqueueFailureClass: string | null;
  lastEnqueueFailureMessage: string | null;
  lastEnqueueFailedAt: Date | string | null;
  lastFailureClass: string | null;
  lastFailureMessage: string | null;
  lastFailureCorrelationId: string | null;
  lastFailedAt: Date | string | null;
  replayCount: number;
  lastReplayedAt: Date | string | null;
  lastReplayedBy: string | null;
};

type AppDependencyOverrides = {
  prisma?: PrismaClient | undefined;
  evaluationQueue?: Queue<MergeGuardEvaluationJobPayload> | undefined;
};

type PageInfo = {
  limit: number;
  offset: number;
  total: number;
  nextOffset?: number | undefined;
  hasMore: boolean;
};

type RecordPageQuery = z.infer<typeof recordPageQuerySchema>;

type RecordPage = {
  records: ChangeControlRecord[];
  pageInfo: PageInfo;
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

type RepositoryDataHandlingState = {
  sourceCodeStorage: boolean;
  fullDiffRetention: "disabled" | "7d" | "30d" | "custom";
  redactSecrets: boolean;
  llmFeatures: boolean;
  auditRecordRetentionDays: number;
};

type GithubRepositoryRef = {
  id: number;
  fullName: string;
  githubRepositoryId?: bigint | undefined;
};

type RepositorySummaryRow = {
  id: string;
  organizationId: string;
  fullName: string;
  enabled: boolean;
  archivedAt: Date | null;
  archiveReason: string | null;
  mode: ChangeControlRecord["mode"] | null;
  protected: boolean;
  defaultBranch: string;
  currentPolicyVersion: {
    contentYaml: string;
    version: string;
    mode: ChangeControlRecord["mode"] | null;
  } | null;
  settings: {
    sourceCodeStorage: boolean;
    fullDiffRetention: string;
    redactSecrets: boolean;
    llmFeatures: boolean;
    auditRecordRetentionDays: number;
  } | null;
};

type OwnerMappingRow = {
  id: string;
  organizationId: string;
  repositoryId: string | null;
  ownerKey: string;
  reviewer: string;
  reviewerType: string;
  createdAt: Date;
  updatedAt: Date;
};

type GitHubInstallationRow = {
  id: string;
  organizationId: string | null;
  githubInstallationId: bigint;
  accountLogin: string;
  accountType: string;
  status: string;
  approvedBy: string | null;
  approvedAt: Date | null;
  rejectedBy: string | null;
  rejectedAt: Date | null;
  archivedAt: Date | null;
  lastWebhookAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

type AuditEventRow = {
  id: string;
  schemaVersion: number;
  organizationId: string;
  repositoryId: string | null;
  pullRequestId: string | null;
  actor: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string;
  source: string;
  requestId: string | null;
  correlationId: string | null;
  policyVersion: string | null;
  policyPackId: string | null;
  policyPackVersion: string | null;
  metadataJson: unknown;
  createdAt: Date;
};

type RepositorySettingsState = {
  repositoryId: string;
  organizationId?: string | undefined;
  enabled: boolean;
  mode?: ChangeControlRecord["mode"] | undefined;
  dataHandling?: RepositoryDataHandlingState | undefined;
  updatedAt: string;
};

type OwnerMappingState = {
  id: string;
  organizationId: string;
  repositoryId?: string | undefined;
  ownerKey: string;
  reviewer: string;
  reviewerType: "user" | "team";
  createdAt: string;
  updatedAt: string;
};

export type AppState = {
  deliveries: Set<string>;
  queuedEvaluations: QueuedEvaluation[];
  records: ChangeControlRecord[];
  auditEvents: AuditEventRecord[];
  exports: ExportJob[];
  overrides: OverrideRecord[];
  repositoryPolicies: Map<string, RepositoryPolicyState>;
  repositorySettings: Map<string, RepositorySettingsState>;
  ownerMappings: OwnerMappingState[];
};

type RawBodyRequest = {
  rawBody?: Buffer;
};

const QUEUE_STATUS_TIMEOUT_MS = 750;
const QUEUE_FAILED_JOB_LIMIT = 25;
const DASHBOARD_DEFAULT_PAGE_SIZE = 50;
const DASHBOARD_MAX_PAGE_SIZE = 100;
const EXPORT_DEFAULT_RECORD_LIMIT = 500;
const EXPORT_MAX_RECORD_LIMIT = 1_000;
const COMPLIANCE_EXPORT_DEFAULT_RECORD_LIMIT = 250;
const COMPLIANCE_EXPORT_MAX_RECORD_LIMIT = 500;
const POLICY_YAML_MAX_BYTES = 200_000;
const POSTGRES_SIGNED_BIGINT_MAX = "9223372036854775807";
const GITHUB_API_TIMEOUT_MS = 10_000;
const GITHUB_INSTALLATION_REPOSITORY_PAGE_SIZE = 100;
const GITHUB_INSTALLATION_REPOSITORY_PAGE_LIMIT = 100;

const optionalQueryString = z.string().trim().min(1).max(240).optional();
const policyModeSchema = z.enum(["observe", "warn", "enforce", "optimize"]);
const recordStatusSchema = z.enum(["pass", "warn", "block"]);
const lifecycleSchema = z.enum([
  "opened",
  "evaluated",
  "blocked",
  "warned",
  "passed",
  "overridden",
  "merged",
  "closed"
]);
const recordSortSchema = z.enum([
  "updated_desc",
  "updated_asc",
  "created_desc",
  "created_asc",
  "pr_asc",
  "pr_desc"
]);
const recordPageQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(DASHBOARD_MAX_PAGE_SIZE)
      .default(DASHBOARD_DEFAULT_PAGE_SIZE),
    offset: z.coerce.number().int().min(0).default(0),
    repositoryId: optionalQueryString,
    status: recordStatusSchema.optional(),
    lifecycle: lifecycleSchema.optional(),
    mode: policyModeSchema.optional(),
    policyVersion: optionalQueryString,
    queue: z.enum(["action_required"]).optional(),
    sort: recordSortSchema.default("updated_desc")
  })
  .strict();
const githubInstallationStatusSchema = z.enum([
  "pending_approval",
  "approved",
  "rejected",
  "archived"
]);
const githubInstallationIdSchema = z
  .union([z.string(), z.number(), z.bigint()])
  .transform((value) => String(value).trim())
  .refine((value) => {
    if (!/^\d{1,20}$/u.test(value)) {
      return false;
    }
    const normalized = value.replace(/^0+/u, "") || "0";
    return (
      normalized.length < POSTGRES_SIGNED_BIGINT_MAX.length ||
      (normalized.length === POSTGRES_SIGNED_BIGINT_MAX.length &&
        normalized <= POSTGRES_SIGNED_BIGINT_MAX)
    );
  }, "GitHub installation id must be numeric and fit in a signed 64-bit integer");
const githubInstallationVerifySchema = z
  .object({
    githubInstallationId: githubInstallationIdSchema,
    accountLogin: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_.-]+$/u)
      .optional(),
    accountType: z.enum(["Organization", "User"]).default("Organization")
  })
  .strict();
const githubInstallationDecisionSchema = z
  .object({
    reason: z.string().trim().min(3).max(500).optional()
  })
  .strict();
const exportRequestSchema = z
  .object({
    format: z.enum(["json", "csv"]).default("json"),
    maxRecords: z.coerce
      .number()
      .int()
      .min(1)
      .max(EXPORT_MAX_RECORD_LIMIT)
      .default(EXPORT_DEFAULT_RECORD_LIMIT),
    offset: z.coerce.number().int().min(0).default(0)
  })
  .strict();
const compliancePackageRequestSchema = z
  .object({
    format: z.literal("json").default("json"),
    maxRecords: z.coerce
      .number()
      .int()
      .min(1)
      .max(COMPLIANCE_EXPORT_MAX_RECORD_LIMIT)
      .default(COMPLIANCE_EXPORT_DEFAULT_RECORD_LIMIT),
    offset: z.coerce.number().int().min(0).default(0),
    repositoryId: optionalQueryString,
    policyPackId: optionalQueryString,
    policyVersion: optionalQueryString,
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional()
  })
  .strict()
  .refine(
    (value) =>
      !value.startDate ||
      !value.endDate ||
      Date.parse(value.startDate) <= Date.parse(value.endDate),
    {
      path: ["endDate"],
      message: "endDate must be greater than or equal to startDate"
    }
  );
const evidenceKindSchema = z.enum([
  "rollback_plan",
  "migration_dry_run",
  "dependency_justification",
  "deleted_test_explanation",
  "benchmark_before_after",
  "security_note",
  "ci_change_reason",
  "manual_attestation"
]);
const diffRetentionSchema = z.enum(["disabled", "7d", "30d", "custom"]);
const evidenceSubmissionSchema = z
  .object({
    evidenceId: z.string().trim().min(1).max(240).optional(),
    kind: evidenceKindSchema.optional(),
    content: z.string().trim().min(10).max(4_000)
  })
  .strict()
  .refine((value) => value.evidenceId || value.kind, {
    message: "evidenceId or kind is required",
    path: ["evidenceId"]
  });
const evidenceRejectionSchema = z
  .object({
    recordId: z.string().trim().min(1).max(240).optional(),
    reason: z.string().trim().min(10).max(1_000)
  })
  .strict();
const recordScopedActionSchema = z
  .object({
    recordId: z.string().trim().min(1).max(240).optional()
  })
  .strict();
const dataHandlingPatchSchema = z
  .object({
    sourceCodeStorage: z.boolean().optional(),
    fullDiffRetention: diffRetentionSchema.optional(),
    redactSecrets: z.boolean().optional(),
    llmFeatures: z.boolean().optional(),
    auditRecordRetentionDays: z.number().int().positive().max(3650).optional()
  })
  .strict();
const ownerMappingBaseSchema = z
  .object({
    ownerKey: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_-]+$/u),
    reviewer: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^@?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/u),
    reviewerType: z.enum(["user", "team"])
  })
  .strict()
  .superRefine((mapping, context) => {
    if (!validReviewerForType(mapping.reviewer, mapping.reviewerType)) {
      context.addIssue({
        code: "custom",
        path: ["reviewer"],
        message:
          mapping.reviewerType === "team"
            ? "Team reviewers must be a GitHub team slug or org/team value."
            : "User reviewers must be a GitHub user login and cannot include a team path."
      });
    }
  });
const ownerMappingPatchSchema = ownerMappingBaseSchema.transform((mapping) => ({
  ownerKey: mapping.ownerKey.toLowerCase(),
  reviewer: normalizeReviewerForStorage(mapping.reviewer, mapping.reviewerType),
  reviewerType: mapping.reviewerType
}));
const ownerMappingsPatchSchema = z
  .array(ownerMappingPatchSchema)
  .max(20)
  .superRefine((mappings, context) => {
    const seenOwnerKeys = new Set<string>();
    for (const [index, mapping] of mappings.entries()) {
      if (seenOwnerKeys.has(mapping.ownerKey)) {
        context.addIssue({
          code: "custom",
          path: [index, "ownerKey"],
          message: "Owner mapping keys must be unique after normalization."
        });
      }
      seenOwnerKeys.add(mapping.ownerKey);
    }
  });
const repositorySettingsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: policyModeSchema.optional(),
    policyVersion: z.string().trim().min(1).max(160).optional(),
    dataHandling: dataHandlingPatchSchema.optional(),
    ownerMappings: ownerMappingsPatchSchema.optional(),
    sourceCodeStorage: z.boolean().optional(),
    fullDiffRetention: diffRetentionSchema.optional(),
    redactSecrets: z.boolean().optional(),
    llmFeatures: z.boolean().optional(),
    auditRecordRetentionDays: z.number().int().positive().max(3650).optional()
  })
  .strict();
const policyYamlPayloadSchema = z.string().superRefine((value, context) => {
  if (Buffer.byteLength(value, "utf8") > POLICY_YAML_MAX_BYTES) {
    context.addIssue({
      code: "custom",
      message: "Policy YAML must be 200 KB or smaller."
    });
  }
});
const policyUpdateSchema = z
  .object({
    contentYaml: policyYamlPayloadSchema
  })
  .strict();
const policyPreviewSchema = z
  .object({
    contentYaml: policyYamlPayloadSchema.optional(),
    pr: z.custom<PullRequestInput>((value) => Boolean(value && typeof value === "object")),
    persist: z.boolean().optional()
  })
  .strict();
const codeownersPreviewSchema = z
  .object({
    content: z.string().min(1).max(200_000),
    changedPaths: z.array(z.string().trim().min(1).max(500)).max(200).optional()
  })
  .strict();
const queueReplaySchema = z
  .object({
    deliveryId: z.string().trim().min(1).max(160).optional(),
    repositoryFullName: z
      .string()
      .trim()
      .min(3)
      .max(240)
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)
      .optional(),
    pullRequestNumber: z.number().int().positive().max(1_000_000).optional()
  })
  .strict()
  .superRefine((value, context) => {
    const hasDeliveryId = Boolean(value.deliveryId);
    const hasPrTarget = Boolean(value.repositoryFullName && value.pullRequestNumber);
    if (hasDeliveryId === hasPrTarget) {
      context.addIssue({
        code: "custom",
        path: ["deliveryId"],
        message:
          "Provide either deliveryId or repositoryFullName with pullRequestNumber, but not both."
      });
    }
  });

export function mergeGuardEvaluationJobOptions(jobId: string): JobsOptions {
  return {
    jobId,
    attempts: MERGE_GUARD_EVALUATION_ATTEMPTS,
    backoff: {
      type: "exponentialWithJitter",
      delay: MERGE_GUARD_EVALUATION_BACKOFF_MS
    },
    removeOnComplete: 100,
    removeOnFail: 500
  };
}

export function createApp(
  state: AppState = createInitialState(),
  overrides: AppDependencyOverrides = {}
): FastifyInstance {
  const config = loadConfig();
  const storagePolicy: MetadataStoragePolicy = {
    sourceCodeStorage: config.sourceCodeStorage,
    fullDiffRetention: config.fullDiffRetention,
    redactSecrets: config.redactSecrets
  };
  const safe = <T>(value: T): T => sanitizeForMetadataStorage(value, storagePolicy);
  const ownsPrisma = !Object.hasOwn(overrides, "prisma");
  const ownsEvaluationQueue = !Object.hasOwn(overrides, "evaluationQueue");
  const prisma = Object.hasOwn(overrides, "prisma")
    ? overrides.prisma
    : config.databaseUrl && config.nodeEnv !== "test"
      ? new PrismaClient({ datasourceUrl: config.databaseUrl })
      : undefined;
  const apiCache = new RedisCacheManager(
    config.redisUrl && config.nodeEnv !== "test" ? config.redisUrl : undefined
  );
  const queueConnection =
    config.redisUrl && config.nodeEnv !== "test"
      ? new Redis(config.redisUrl, {
          maxRetriesPerRequest: null,
          enableOfflineQueue: false,
          lazyConnect: true,
          connectTimeout: QUEUE_STATUS_TIMEOUT_MS
        })
      : undefined;
  const evaluationQueue = Object.hasOwn(overrides, "evaluationQueue")
    ? overrides.evaluationQueue
    : queueConnection
      ? new Queue<MergeGuardEvaluationJobPayload>(MERGE_GUARD_EVALUATION_QUEUE, {
          connection: queueConnection
        })
      : undefined;
  const persistence = prisma
    ? createPrismaPersistencePort(state, prisma)
    : createInMemoryPersistencePort(state);
  const listRecords = (filter?: { organizationId?: string }) =>
    listChangeControlRecords(persistence, filter);
  const getRecord = (id: string) => getChangeControlRecord(persistence, id);
  const saveRecord = (record: ChangeControlRecord, pr?: PullRequestInput) =>
    saveChangeControlRecord(persistence, record, pr);
  const listRepositories = (organizationId?: string) =>
    listRepositorySummaries(state, prisma, config.defaultPolicyMode, organizationId);
  const getRepositoryPolicy = (id: string) => getActiveRepositoryPolicy(state, prisma, id);
  const getRecordPolicyConfig = async (record: ChangeControlRecord) => {
    const activePolicy = await getRepositoryPolicy(record.repositoryId);
    const contentYaml =
      activePolicy?.contentYaml ??
      getPolicyPack(record.policyPackId ?? "")?.contentYaml ??
      getPolicyPack("fintech")?.contentYaml;
    if (!contentYaml) {
      throw new Error("Policy configuration is unavailable for this Change Control Record.");
    }
    const parsed = parsePolicyYaml(contentYaml);
    if (parsed.errors.length > 0) {
      throw new Error(`Policy validation failed: ${parsed.errors.join("; ")}`);
    }
    return parsed.config;
  };
  const saveRepositoryPolicy = (
    repositoryId: string,
    contentYaml: string,
    actor: string,
    parsed: ReturnType<typeof parsePolicyYaml>
  ) => saveActiveRepositoryPolicy(state, prisma, repositoryId, contentYaml, actor, parsed);
  const listOwnerMappings = () => listConfiguredOwnerMappings(state, prisma);
  const saveRepositorySettings = (
    repositoryId: string,
    body: z.infer<typeof repositorySettingsPatchSchema>
  ) => updateRepositorySettings(state, prisma, repositoryId, body, config);
  const audit = (input: Parameters<typeof createAuditEvent>[0]) =>
    recordAuditEvent(persistence, input);
  const auditReevaluation = (
    record: ChangeControlRecord,
    actor: ApiActor,
    previousStatus: ChangeControlRecord["checkStatus"],
    requestId?: string | undefined
  ) =>
    audit({
      organizationId: record.organizationId,
      repositoryId: record.repositoryId,
      pullRequestId: record.id,
      actor: actor.login,
      action: "record_reevaluated",
      targetType: "change_control_record",
      targetId: record.id,
      requestId,
      metadataJson: {
        previousStatus,
        checkStatus: record.checkStatus,
        lifecycle: record.lifecycle,
        policyVersion: record.policyVersion,
        policyPackId: record.policyPackId,
        policyPackVersion: record.policyPackVersion,
        openEvidence: record.requiredEvidence.filter((item) => item.status !== "approved").length,
        pendingRequiredReviewers: record.requiredReviewers.filter(
          (item) => item.tier === "required" && !item.approved
        ).length,
        actorRole: actor.role
      }
    });
  const recordsForAction = async (recordId?: string): Promise<ChangeControlRecord[]> => {
    if (!recordId) {
      return listRecords();
    }
    const record = await getRecord(recordId);
    return record ? [record] : [];
  };
  const requireReadActor = (request: FastifyRequest, reply: FastifyReply) => {
    const actor = requireApiActor(request);
    if (isAuthzFailure(actor)) {
      const errorCode =
        actor.statusCode === 401 ? "api_actor_required" : "api_actor_not_authorized";
      request.log.warn(
        {
          code: errorCode,
          method: request.method,
          requestId: request.id,
          route: request.routeOptions.url ?? request.url,
          statusCode: actor.statusCode
        },
        "Rejected governance read request"
      );
      void reply.code(actor.statusCode).send({
        code: errorCode,
        error: actor.reason,
        requestId: request.id
      });
      return undefined;
    }
    return actor;
  };
  const recordsVisibleTo = async (actor: ApiActor) =>
    listRecords({ organizationId: actor.organizationId });
  const app = Fastify({
    logger: {
      level: config.nodeEnv === "test" ? "silent" : "info",
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers.x-hub-signature-256",
        "req.body.token",
        "req.body.secret",
        "req.body.password",
        "req.body.content",
        "body.GITHUB_APP_PRIVATE_KEY",
        "body.GITHUB_WEBHOOK_SECRET",
        "body.GITHUB_CLIENT_SECRET",
        "body.SESSION_SECRET"
      ]
    },
    bodyLimit: 1024 * 1024
  });
  queueConnection?.on("error", (error) => {
    app.log.debug(
      { errorClass: error.name, message: error.message },
      "Worker queue connection error"
    );
  });

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    try {
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
      (request as RawBodyRequest).rawBody = buffer;
      const parsed = buffer.length > 0 ? JSON.parse(buffer.toString("utf8")) : {};
      done(null, parsed);
    } catch (error) {
      done(error as Error);
    }
  });

  void app.register(cors, {
    origin: [config.appBaseUrl],
    credentials: true
  });
  void app.register(rateLimit, {
    max: config.nodeEnv === "test" ? 1_000 : 120,
    timeWindow: "1 minute"
  });

  app.addHook("onClose", async () => {
    if (ownsEvaluationQueue) {
      await evaluationQueue?.close().catch(() => undefined);
    }
    if (queueConnection) {
      queueConnection.removeAllListeners("error");
      if (queueConnection.status === "ready") {
        await queueConnection.quit().catch(() => undefined);
      } else {
        queueConnection.disconnect(false);
      }
    }
    await apiCache.disconnect();
    if (ownsPrisma) {
      await prisma?.$disconnect();
    }
  });

  registerApiRoutes(app, {
    apiCache,
    audit,
    auditReevaluation,
    approveGithubInstallation,
    codeownersPreviewSchema,
    collectPrometheusMetrics,
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
    findReplayableDelivery: (target: z.infer<typeof queueReplaySchema>, organizationId?: string) =>
      findReplayableDelivery(persistence, target, organizationId),
    findRepositoryIdByFullName,
    fetchGithubInstallationAccount,
    getExportJob: (id: string) => getExportJob(persistence, id),
    getRecord,
    getRecordPolicyConfig,
    getRepositoryModeOverride,
    getRepositoryPolicy,
    githubCredentialsConfigured,
    githubInstallationDecisionSchema,
    githubInstallationSummary,
    githubInstallationVerifySchema,
    githubInstallUrl,
    headerValue,
    isRecoverableWebhookDeliveryForEnqueue,
    listAuditEvents: (organizationId?: string) => listAuditEvents(persistence, organizationId),
    listAuditEventsForRecordExport: (records: ChangeControlRecord[]) =>
      listAuditEventsForRecordExport(persistence, records),
    listGithubInstallations,
    listOwnerMappings,
    listRecentWebhookDeliveryFailures: (organizationId?: string) =>
      listRecentWebhookDeliveryFailures(persistence, organizationId),
    listRecords,
    listRepositories,
    markWebhookDeliveryCompleted: (deliveryId: string) =>
      markWebhookDeliveryCompleted(persistence, deliveryId),
    markWebhookDeliveryEnqueueFailed: (deliveryId: string, error: unknown) =>
      markWebhookDeliveryEnqueueFailed(persistence, deliveryId, error),
    markWebhookDeliveryQueued: (deliveryId: string, queueJobId: string) =>
      markWebhookDeliveryQueued(persistence, deliveryId, queueJobId),
    markWebhookDeliveryReplayed: (deliveryId: string, actor: string) =>
      markWebhookDeliveryReplayed(persistence, deliveryId, actor),
    onboardingStepsFromRuntime,
    ownerMappingForApi,
    paginateRecords,
    policyPreviewSchema,
    policyUpdateSchema,
    prisma,
    processGithubInstallationWebhook,
    queueOperationalStatus,
    queueReplaySchema,
    recordPageQuerySchema,
    recordScopedActionSchema,
    recordsForAction,
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
    saveAuditEvent: (event: AuditEventRecord) => saveAuditEvent(persistence, event),
    saveExportJob: (job: ExportJob, actor: string, actorRole: string) =>
      saveExportJob(persistence, job, actor, actorRole),
    saveOverrideRecord: (override: OverrideRecord) => saveOverrideRecord(persistence, override),
    saveRecord,
    saveRepositoryPolicy,
    saveRepositorySettings,
    state,
    storagePolicy,
    syncRepositoriesFromCurrentGithubInstallation,
    syncRepositoriesFromStoredInstallationEvents,
    upsertPendingGithubInstallation,
    recordWebhookDeliveryReceived: (envelope: GithubWebhookEnvelope) =>
      recordWebhookDeliveryReceived(persistence, envelope),
    recordRequiresAction,
    groupBy
  });

  return app;
}

export function createInitialState(): AppState {
  return {
    deliveries: new Set(),
    queuedEvaluations: [],
    records: [],
    auditEvents: [],
    exports: [],
    overrides: [],
    repositoryPolicies: new Map(),
    repositorySettings: new Map(),
    ownerMappings: []
  };
}

async function repositoryOrganizationId(
  state: AppState,
  prisma: PrismaClient | undefined,
  repositoryId: string
): Promise<string | undefined> {
  if (prisma) {
    const repository = await prisma.repository.findUnique({
      where: { id: repositoryId },
      select: { organizationId: true }
    });
    return repository?.organizationId;
  }
  return (
    state.repositorySettings.get(repositoryId)?.organizationId ??
    state.records.find((record) => record.repositoryId === repositoryId)?.organizationId
  );
}

async function listRepositorySummaries(
  state: AppState,
  prisma: PrismaClient | undefined,
  defaultMode: ChangeControlRecord["mode"],
  organizationId?: string
) {
  if (prisma) {
    const rows = await prisma.repository.findMany({
      ...(organizationId ? { where: { organizationId } } : {}),
      include: { currentPolicyVersion: true, settings: true },
      orderBy: { fullName: "asc" }
    });
    return rows.map((row: RepositorySummaryRow) => {
      const parsedPolicy = row.currentPolicyVersion
        ? parsePolicyYaml(row.currentPolicyVersion.contentYaml)
        : undefined;
      return {
        id: row.id,
        organizationId: row.organizationId,
        fullName: row.fullName,
        enabled: row.enabled,
        mode: effectiveRepositoryMode(row.mode, row.currentPolicyVersion?.mode, defaultMode),
        currentPolicyPack: parsedPolicy?.config.policy_pack_id,
        currentPolicyVersion: row.currentPolicyVersion?.version,
        protected: row.protected,
        defaultBranch: row.defaultBranch,
        archivedAt: row.archivedAt?.toISOString(),
        archiveReason: row.archiveReason ?? undefined,
        dataHandling: row.settings ? dataHandlingFromRepositorySetting(row.settings) : undefined
      };
    });
  }

  const repositories = new Map<
    string,
    {
      id: string;
      organizationId?: string | undefined;
      fullName: string;
      enabled: boolean;
      mode: ChangeControlRecord["mode"];
      currentPolicyPack?: string | undefined;
      currentPolicyVersion?: string | undefined;
      protected: boolean;
      defaultBranch: string;
      dataHandling?: RepositoryDataHandlingState | undefined;
      archivedAt?: string | undefined;
      archiveReason?: string | undefined;
    }
  >();

  for (const record of state.records) {
    if (organizationId && record.organizationId !== organizationId) {
      continue;
    }
    const policy = state.repositoryPolicies.get(record.repositoryId);
    const settings = state.repositorySettings.get(record.repositoryId);
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

  for (const policy of state.repositoryPolicies.values()) {
    const settings = state.repositorySettings.get(policy.repositoryId);
    const policyOrganizationId =
      settings?.organizationId ??
      state.records.find((record) => record.repositoryId === policy.repositoryId)?.organizationId;
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

  for (const settings of state.repositorySettings.values()) {
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
}

async function getActiveRepositoryPolicy(
  state: AppState,
  prisma: PrismaClient | undefined,
  repositoryId: string
): Promise<RepositoryPolicyState | undefined> {
  const cached = state.repositoryPolicies.get(repositoryId);
  if (cached) {
    return cached;
  }
  if (!prisma) {
    return undefined;
  }
  const repository = await prisma.repository.findUnique({
    where: { id: repositoryId },
    include: { currentPolicyVersion: true }
  });
  const version = repository?.currentPolicyVersion;
  if (!version) {
    return undefined;
  }
  const parsed = parsePolicyYaml(version.contentYaml);
  return {
    repositoryId,
    version: version.version,
    mode: version.mode,
    contentYaml: version.contentYaml,
    contentHash: version.contentHash,
    createdBy: version.createdBy,
    createdAt: version.createdAt.toISOString(),
    policyPackId: parsed.config.policy_pack_id,
    policyPackVersion: parsed.config.policy_pack_version
  };
}

async function saveActiveRepositoryPolicy(
  state: AppState,
  prisma: PrismaClient | undefined,
  repositoryId: string,
  contentYaml: string,
  actor: string,
  parsed: ReturnType<typeof parsePolicyYaml>
): Promise<RepositoryPolicyState> {
  const policy: RepositoryPolicyState = {
    repositoryId,
    version: `${parsed.config.policy_pack_id ?? "custom"}@${parsed.config.policy_pack_version ?? parsed.config.version}+${parsed.contentHash.slice(0, 8)}`,
    mode: parsed.config.agentforge.mode,
    contentYaml,
    contentHash: parsed.contentHash,
    createdBy: actor,
    createdAt: new Date().toISOString(),
    policyPackId: parsed.config.policy_pack_id,
    policyPackVersion: parsed.config.policy_pack_version
  };
  state.repositoryPolicies.set(repositoryId, policy);

  if (!prisma) {
    return policy;
  }

  const repository = await prisma.repository.findUnique({
    where: { id: repositoryId },
    select: { id: true, organizationId: true }
  });
  if (!repository) {
    throw new Error("Repository must exist before assigning an active policy.");
  }
  const row = await prisma.policyVersion.create({
    data: {
      organizationId: repository.organizationId,
      repositoryId: repository.id,
      version: policy.version,
      mode: policy.mode,
      contentYaml: policy.contentYaml,
      contentHash: policy.contentHash,
      createdBy: actor
    }
  });
  await prisma.repository.update({
    where: { id: repository.id },
    data: {
      currentPolicyVersionId: row.id,
      mode: policy.mode
    }
  });

  return {
    ...policy,
    version: row.version,
    createdAt: row.createdAt.toISOString()
  };
}

async function updateRepositorySettings(
  state: AppState,
  prisma: PrismaClient | undefined,
  repositoryId: string,
  patch: z.infer<typeof repositorySettingsPatchSchema>,
  config: ReturnType<typeof loadConfig>
): Promise<{
  organizationId: string;
  repository: {
    id: string;
    enabled: boolean;
    mode: ChangeControlRecord["mode"];
    dataHandling: RepositoryDataHandlingState;
  };
  ownerMappings: OwnerMappingState[];
}> {
  const dataHandlingPatch = extractDataHandlingPatch(patch);
  if (prisma) {
    const repository = await prisma.repository.findUnique({
      where: { id: repositoryId },
      include: { currentPolicyVersion: true, settings: true }
    });
    if (!repository) {
      throw new Error("Repository must exist before updating settings.");
    }
    let policyVersionId: string | null | undefined;
    let policyMode: ChangeControlRecord["mode"] | undefined;
    if (patch.policyVersion) {
      const version = await prisma.policyVersion.findFirst({
        where: {
          repositoryId: repository.id,
          version: patch.policyVersion
        },
        select: { id: true, mode: true }
      });
      if (!version) {
        throw new Error("Requested policy version is not available for this repository.");
      }
      policyVersionId = version.id;
      policyMode = version.mode;
    }
    const updatedRepository = await prisma.repository.update({
      where: { id: repository.id },
      data: {
        enabled: patch.enabled ?? repository.enabled,
        mode: patch.mode ?? policyMode ?? repository.mode,
        ...(policyVersionId ? { currentPolicyVersionId: policyVersionId } : {})
      }
    });
    let dataHandling = repository.settings
      ? dataHandlingFromRepositorySetting(repository.settings)
      : dataHandlingDefaults(config);
    if (dataHandlingPatch) {
      const savedSetting = await prisma.repositorySetting.upsert({
        where: { repositoryId: repository.id },
        update: dataHandlingPatch,
        create: {
          repositoryId: repository.id,
          ...dataHandlingDefaults(config),
          ...dataHandlingPatch
        }
      });
      dataHandling = dataHandlingFromRepositorySetting(savedSetting);
    }
    if (patch.ownerMappings) {
      await prisma.ownerMapping.deleteMany({ where: { repositoryId: repository.id } });
      if (patch.ownerMappings.length > 0) {
        await prisma.ownerMapping.createMany({
          data: patch.ownerMappings.map((mapping) => ({
            organizationId: repository.organizationId,
            repositoryId: repository.id,
            ownerKey: mapping.ownerKey,
            reviewer: mapping.reviewer,
            reviewerType: mapping.reviewerType
          }))
        });
      }
    }
    const ownerMappings = await listConfiguredOwnerMappings(state, prisma, repository.id);
    return {
      organizationId: repository.organizationId,
      repository: {
        id: repository.id,
        enabled: updatedRepository.enabled,
        mode:
          updatedRepository.mode ??
          repository.currentPolicyVersion?.mode ??
          config.defaultPolicyMode,
        dataHandling
      },
      ownerMappings
    };
  }

  const existingRecord = state.records.find((record) => record.repositoryId === repositoryId);
  const existingPolicy = state.repositoryPolicies.get(repositoryId);
  const existingSettings = state.repositorySettings.get(repositoryId);
  if (!existingRecord && !existingPolicy && !existingSettings) {
    throw new Error("Repository must exist before updating settings.");
  }
  if (patch.policyVersion && existingPolicy?.version !== patch.policyVersion) {
    throw new Error("Requested policy version is not available for this repository.");
  }
  const dataHandling = {
    ...(existingSettings?.dataHandling ?? dataHandlingDefaults(config)),
    ...(dataHandlingPatch ?? {})
  };
  const nextSettings: RepositorySettingsState = {
    repositoryId,
    organizationId: existingRecord?.organizationId ?? existingSettings?.organizationId,
    enabled: patch.enabled ?? existingSettings?.enabled ?? true,
    mode: patch.mode ?? existingSettings?.mode ?? existingPolicy?.mode ?? existingRecord?.mode,
    dataHandling,
    updatedAt: new Date().toISOString()
  };
  state.repositorySettings.set(repositoryId, nextSettings);
  if (patch.ownerMappings) {
    state.ownerMappings = [
      ...state.ownerMappings.filter((mapping) => mapping.repositoryId !== repositoryId),
      ...patch.ownerMappings.map((mapping) => {
        const now = new Date().toISOString();
        return {
          id: `owner_mapping:${repositoryId}:${mapping.ownerKey}`,
          organizationId: existingRecord?.organizationId ?? "org_local",
          repositoryId,
          ownerKey: mapping.ownerKey,
          reviewer: mapping.reviewer,
          reviewerType: mapping.reviewerType,
          createdAt: now,
          updatedAt: now
        } satisfies OwnerMappingState;
      })
    ];
  }
  const ownerMappings = await listConfiguredOwnerMappings(state, prisma, repositoryId);
  return {
    organizationId: existingRecord?.organizationId ?? "org_local",
    repository: {
      id: repositoryId,
      enabled: nextSettings.enabled,
      mode: nextSettings.mode ?? config.defaultPolicyMode,
      dataHandling
    },
    ownerMappings
  };
}

async function listConfiguredOwnerMappings(
  state: AppState,
  prisma: PrismaClient | undefined,
  repositoryId?: string
): Promise<OwnerMappingState[]> {
  if (prisma) {
    const rows = await prisma.ownerMapping.findMany({
      ...(repositoryId ? { where: { repositoryId } } : {}),
      orderBy: [{ repositoryId: "asc" }, { ownerKey: "asc" }]
    });
    return rows.map((row: OwnerMappingRow) => {
      const output: OwnerMappingState = {
        id: row.id,
        organizationId: row.organizationId,
        ownerKey: row.ownerKey,
        reviewer: row.reviewer,
        reviewerType: row.reviewerType === "user" ? "user" : "team",
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString()
      };
      if (row.repositoryId) {
        output.repositoryId = row.repositoryId;
      }
      return output;
    });
  }
  return state.ownerMappings
    .filter((mapping) => !repositoryId || mapping.repositoryId === repositoryId)
    .sort((a, b) =>
      `${a.repositoryId ?? ""}:${a.ownerKey}`.localeCompare(`${b.repositoryId ?? ""}:${b.ownerKey}`)
    );
}

async function defaultDataHandlingSettings(
  prisma: PrismaClient | undefined,
  config: ReturnType<typeof loadConfig>
): Promise<RepositoryDataHandlingState> {
  if (prisma) {
    const retention = await prisma.retentionSetting.findFirst({
      orderBy: { createdAt: "desc" }
    });
    if (retention) {
      return {
        sourceCodeStorage: retention.sourceCodeStorage,
        fullDiffRetention: normalizeFullDiffRetention(retention.fullDiffRetention),
        redactSecrets: retention.redactSecrets,
        llmFeatures: retention.llmFeatures,
        auditRecordRetentionDays: retention.auditRecordRetentionDays
      };
    }
  }
  return dataHandlingDefaults(config);
}

function dataHandlingDefaults(config: ReturnType<typeof loadConfig>): RepositoryDataHandlingState {
  return {
    sourceCodeStorage: config.sourceCodeStorage,
    fullDiffRetention: config.fullDiffRetention,
    redactSecrets: config.redactSecrets,
    llmFeatures: config.llmFeatures,
    auditRecordRetentionDays: config.auditRecordRetentionDays
  };
}

function extractDataHandlingPatch(
  patch: z.infer<typeof repositorySettingsPatchSchema>
): Partial<RepositoryDataHandlingState> | undefined {
  const output: Partial<RepositoryDataHandlingState> = {};
  const nested = patch.dataHandling;
  if (nested?.sourceCodeStorage !== undefined) {
    output.sourceCodeStorage = nested.sourceCodeStorage;
  }
  if (nested?.fullDiffRetention !== undefined) {
    output.fullDiffRetention = nested.fullDiffRetention;
  }
  if (nested?.redactSecrets !== undefined) {
    output.redactSecrets = nested.redactSecrets;
  }
  if (nested?.llmFeatures !== undefined) {
    output.llmFeatures = nested.llmFeatures;
  }
  if (nested?.auditRecordRetentionDays !== undefined) {
    output.auditRecordRetentionDays = nested.auditRecordRetentionDays;
  }
  if (patch.sourceCodeStorage !== undefined) {
    output.sourceCodeStorage = patch.sourceCodeStorage;
  }
  if (patch.fullDiffRetention !== undefined) {
    output.fullDiffRetention = patch.fullDiffRetention;
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

function dataHandlingFromRepositorySetting(row: {
  sourceCodeStorage: boolean;
  fullDiffRetention: string;
  redactSecrets: boolean;
  llmFeatures: boolean;
  auditRecordRetentionDays: number;
}): RepositoryDataHandlingState {
  return {
    sourceCodeStorage: row.sourceCodeStorage,
    fullDiffRetention: normalizeFullDiffRetention(row.fullDiffRetention),
    redactSecrets: row.redactSecrets,
    llmFeatures: row.llmFeatures,
    auditRecordRetentionDays: row.auditRecordRetentionDays
  };
}

function normalizeFullDiffRetention(
  value: string
): RepositoryDataHandlingState["fullDiffRetention"] {
  return value === "7d" || value === "30d" || value === "custom" ? value : "disabled";
}

function ownerMappingForApi(mapping: OwnerMappingState) {
  return {
    ownerKey: mapping.ownerKey,
    reviewer: mapping.reviewer,
    reviewerType: mapping.reviewerType,
    sources: [mapping.repositoryId ?? "organization"]
  };
}

async function listChangeControlRecords(
  persistence: PersistencePort,
  filter?: { organizationId?: string }
): Promise<ChangeControlRecord[]> {
  return persistence.records.list(filter);
}

async function listChangeControlRecordPage(
  persistence: PersistencePort,
  query: RecordPageQuery
): Promise<RecordPage> {
  return persistence.records.page(query);
}

async function getChangeControlRecord(
  persistence: PersistencePort,
  id: string
): Promise<ChangeControlRecord | undefined> {
  return persistence.records.get(id);
}

async function saveChangeControlRecord(
  persistence: PersistencePort,
  record: ChangeControlRecord,
  pr?: PullRequestInput
): Promise<ChangeControlRecord> {
  return persistence.records.save(record, pr);
}

function createPrismaPersistencePort(state: AppState, prisma: PrismaClient): PersistencePort {
  return {
    records: {
      async get(id) {
        const row = await prisma.changeControlRecord.findUnique({
          where: { id },
          include: {
            pullRequest: {
              select: { repositoryId: true, repository: { select: { organizationId: true } } }
            }
          }
        });
        return row ? changeControlRecordFromRow(row) : state.records.find((item) => item.id === id);
      },
      async save(record, pr) {
        const organization = await ensureOrganization(prisma, record.organizationId);
        const repository = await ensureRepository(prisma, {
          organizationId: organization.id,
          repositoryId: record.repositoryId,
          fullName: record.repositoryFullName,
          defaultBranch: record.baseBranch
        });
        const pullRequest = await prisma.pullRequest.upsert({
          where: {
            repositoryId_number: {
              repositoryId: repository.id,
              number: record.pullRequestNumber
            }
          },
          update: {
            title: pr?.title ?? `PR #${record.pullRequestNumber}`,
            authorLogin: pr?.authorLogin ?? "unknown",
            baseBranch: record.baseBranch,
            headBranch: pr?.headBranch ?? "unknown",
            headSha: record.headSha,
            state: "open"
          },
          create: {
            id: `pr_${record.id}`,
            repositoryId: repository.id,
            githubPullRequestId: stableBigInt(
              `${record.repositoryFullName}#${record.pullRequestNumber}`
            ),
            number: record.pullRequestNumber,
            title: pr?.title ?? `PR #${record.pullRequestNumber}`,
            authorLogin: pr?.authorLogin ?? "unknown",
            baseBranch: record.baseBranch,
            headBranch: pr?.headBranch ?? "unknown",
            headSha: record.headSha,
            state: "open"
          }
        });

        const persisted = await prisma.changeControlRecord.upsert({
          where: { pullRequestId: pullRequest.id },
          update: changeControlRecordData(record),
          create: {
            id: record.id,
            pullRequestId: pullRequest.id,
            ...changeControlRecordData(record)
          }
        });
        await persistEvaluationSnapshot(prisma, {
          organizationId: organization.id,
          repositoryId: repository.id,
          pullRequestId: pullRequest.id,
          record
        });
        const savedRecord = changeControlRecordFromRow({
          ...persisted,
          pullRequest: {
            repositoryId: repository.id,
            repository: { organizationId: organization.id }
          }
        });
        rememberRecord(state, savedRecord);
        return savedRecord;
      },
      async list(filter) {
        const rows = await prisma.changeControlRecord.findMany({
          ...(filter?.organizationId
            ? {
                where: {
                  pullRequest: { repository: { organizationId: filter.organizationId } }
                }
              }
            : {}),
          include: {
            pullRequest: {
              select: { repositoryId: true, repository: { select: { organizationId: true } } }
            }
          },
          orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }]
        });
        return rows.map(changeControlRecordFromRow);
      },
      async page(query) {
        const pullRequestWhere = {
          ...(query.repositoryId ? { repositoryId: query.repositoryId } : {}),
          ...(query.organizationId ? { repository: { organizationId: query.organizationId } } : {})
        };
        if (query.queue) {
          const rows = await prisma.changeControlRecord.findMany({
            ...(Object.keys(pullRequestWhere).length > 0
              ? { where: { pullRequest: pullRequestWhere } }
              : {}),
            include: {
              pullRequest: {
                select: { repositoryId: true, repository: { select: { organizationId: true } } }
              }
            },
            orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }]
          });
          return paginateRecords(
            filterAndSortRecords(rows.map(changeControlRecordFromRow), query),
            query
          );
        }

        const where = {
          ...(query.status ? { checkStatus: query.status } : {}),
          ...(query.lifecycle ? { lifecycle: query.lifecycle } : {}),
          ...(query.mode ? { mode: query.mode } : {}),
          ...(query.policyVersion ? { policyVersion: query.policyVersion } : {}),
          ...(Object.keys(pullRequestWhere).length > 0 ? { pullRequest: pullRequestWhere } : {})
        };
        const orderBy =
          query.sort === "created_asc"
            ? [{ createdAt: "asc" as const }]
            : query.sort === "created_desc"
              ? [{ createdAt: "desc" as const }]
              : query.sort === "updated_asc"
                ? [{ updatedAt: "asc" as const }]
                : query.sort === "pr_asc"
                  ? [{ pullRequestNumber: "asc" as const }]
                  : query.sort === "pr_desc"
                    ? [{ pullRequestNumber: "desc" as const }]
                    : [{ updatedAt: "desc" as const }, { createdAt: "desc" as const }];
        const [total, rows] = await prisma.$transaction([
          prisma.changeControlRecord.count({ where }),
          prisma.changeControlRecord.findMany({
            where,
            include: {
              pullRequest: {
                select: { repositoryId: true, repository: { select: { organizationId: true } } }
              }
            },
            orderBy,
            skip: query.offset,
            take: query.limit
          })
        ]);

        return {
          records: rows.map(changeControlRecordFromRow),
          pageInfo: pageInfo(total, query)
        };
      }
    },
    auditEvents: {
      async append(event) {
        state.auditEvents.push(event);
        await ensureOrganization(prisma, event.organizationId);
        const repository = event.repositoryId
          ? await prisma.repository.findUnique({
              where: { id: event.repositoryId },
              select: { id: true }
            })
          : undefined;
        const pullRequest =
          event.pullRequestId && event.pullRequestId.startsWith("pr_")
            ? await prisma.pullRequest.findUnique({
                where: { id: event.pullRequestId },
                select: { id: true }
              })
            : event.pullRequestId
              ? await prisma.changeControlRecord.findUnique({
                  where: { id: event.pullRequestId },
                  select: { pullRequestId: true }
                })
              : undefined;

        await prisma.auditEvent.upsert({
          where: { id: event.id },
          update: {},
          create: {
            id: event.id,
            organizationId: event.organizationId,
            repositoryId: repository?.id ?? null,
            pullRequestId:
              pullRequest && "pullRequestId" in pullRequest
                ? pullRequest.pullRequestId
                : (pullRequest?.id ?? null),
            schemaVersion: event.schemaVersion,
            actor: event.actor,
            actorRole: event.actorRole,
            action: event.action,
            targetType: event.targetType,
            targetId: event.targetId,
            source: event.source,
            requestId: event.requestId ?? null,
            correlationId: event.correlationId ?? null,
            policyVersion: event.policyVersion ?? null,
            policyPackId: event.policyPackId ?? null,
            policyPackVersion: event.policyPackVersion ?? null,
            metadataJson: event.metadataJson as never,
            createdAt: new Date(event.createdAt)
          }
        });
      },
      async list(filter) {
        const rows = await prisma.auditEvent.findMany({
          ...(filter?.organizationId ? { where: { organizationId: filter.organizationId } } : {}),
          orderBy: { createdAt: "desc" },
          take: 250
        });
        return rows.map(auditEventRecordFromRow);
      },
      async listForRecordExport(records) {
        const repositoryIds = [...new Set(records.map((record) => record.repositoryId))];
        const recordIds = records.map((record) => record.id);
        const organizationId = records[0]?.organizationId;
        if ((repositoryIds.length === 0 && recordIds.length === 0) || !organizationId) {
          return [];
        }
        const rows = await prisma.auditEvent.findMany({
          where: {
            organizationId,
            OR: [
              { targetType: "change_control_record", targetId: { in: recordIds } },
              { repositoryId: { in: repositoryIds } }
            ]
          },
          orderBy: { createdAt: "asc" }
        });
        return rows.map(auditEventRecordFromRow);
      }
    },
    exportJobs: {
      async save(job, actor) {
        await prisma.exportJob.create({
          data: {
            id: job.id,
            organizationId: job.organizationId,
            actor: actor.actor,
            actorRole: actor.actorRole,
            status: job.status,
            format: job.format,
            recordCount: job.recordCount,
            totalMatchingRecords: job.totalMatchingRecords,
            truncated: job.truncated,
            content: job.content,
            createdAt: new Date(job.createdAt)
          }
        });
        state.exports = [job, ...(state.exports ?? []).filter((item) => item.id !== job.id)];
      },
      async get(id) {
        const row = await prisma.exportJob.findUnique({ where: { id } });
        return row
          ? {
              id: row.id,
              organizationId: row.organizationId ?? "org_local",
              status: "completed",
              format: row.format === "csv" ? "csv" : "json",
              recordCount: row.recordCount,
              totalMatchingRecords: row.totalMatchingRecords,
              truncated: row.truncated,
              content: row.content,
              createdAt: row.createdAt.toISOString()
            }
          : state.exports.find((item) => item.id === id);
      }
    },
    overrides: {
      async save(override) {
        const record = await prisma.changeControlRecord.findUnique({
          where: { id: override.pullRequestId },
          select: { pullRequestId: true }
        });
        if (!record) {
          return;
        }
        await prisma.overrideRecord.upsert({
          where: { id: override.id },
          update: {},
          create: {
            id: override.id,
            pullRequestId: record.pullRequestId,
            evaluationId: null,
            actor: override.actor,
            actorRole: override.actorRole,
            reason: override.reason,
            scope: override.scope,
            visibleInPr: override.visibleInPr,
            policyVersion: override.policyVersion,
            createdAt: new Date(override.createdAt)
          }
        });
        state.overrides = [override, ...state.overrides.filter((item) => item.id !== override.id)];
      }
    },
    webhookDeliveries: {
      async recordReceived(envelope) {
        state.deliveries.add(envelope.deliveryId);
        const repositoryFullName = envelope.repository?.fullName ?? null;
        const repositoryId = repositoryFullName
          ? await findRepositoryIdByFullName(state, prisma, repositoryFullName)
          : undefined;
        const organizationId = repositoryId
          ? await repositoryOrganizationId(state, prisma, repositoryId)
          : state.records.find((record) => record.repositoryFullName === repositoryFullName)
              ?.organizationId;
        const payloadJson = {
          installationId: envelope.installationId,
          repository: envelope.repository,
          pullRequest: envelope.pullRequest,
          review: envelope.review,
          checkRun: envelope.checkRun,
          installation: envelope.installation,
          receivedAt: envelope.receivedAt
        } as never;
        const existing = await prisma.webhookDelivery.findUnique({
          where: { deliveryId: envelope.deliveryId },
          select: { deliveryStatus: true, enqueued: true }
        });
        if (existing) {
          return {
            duplicate: true,
            status: webhookDeliveryStatus(existing.deliveryStatus, existing.enqueued)
          };
        }
        try {
          const created = await prisma.webhookDelivery.create({
            data: {
              deliveryId: envelope.deliveryId,
              event: envelope.event,
              action: envelope.action ?? null,
              organizationId: organizationId ?? null,
              repositoryId: repositoryId ?? null,
              repositoryFullName,
              pullRequestNumber:
                envelope.pullRequest?.number ?? envelope.checkRun?.pullRequests[0]?.number ?? null,
              headSha: envelope.pullRequest?.headSha ?? envelope.checkRun?.headSha ?? null,
              enqueued: false,
              deliveryStatus: "received",
              payloadJson
            },
            select: { deliveryStatus: true, enqueued: true }
          });
          return {
            duplicate: false,
            status: webhookDeliveryStatus(created.deliveryStatus, created.enqueued)
          };
        } catch (error) {
          const retryExisting = await prisma.webhookDelivery.findUnique({
            where: { deliveryId: envelope.deliveryId },
            select: { deliveryStatus: true, enqueued: true }
          });
          if (retryExisting) {
            return {
              duplicate: true,
              status: webhookDeliveryStatus(retryExisting.deliveryStatus, retryExisting.enqueued)
            };
          }
          throw error;
        }
      },
      async markQueued(deliveryId, queueJobId) {
        state.deliveries.add(deliveryId);
        await prisma.webhookDelivery.updateMany({
          where: { deliveryId },
          data: {
            enqueued: true,
            deliveryStatus: "queued",
            queueJobId,
            queuedAt: new Date(),
            lastEnqueueFailureClass: null,
            lastEnqueueFailureMessage: null,
            lastEnqueueFailedAt: null
          }
        });
      },
      async markCompleted(deliveryId) {
        state.deliveries.add(deliveryId);
        await prisma.webhookDelivery.updateMany({
          where: { deliveryId },
          data: {
            deliveryStatus: "completed",
            completedAt: new Date()
          }
        });
      },
      async markEnqueueFailed(deliveryId, error) {
        state.deliveries.add(deliveryId);
        const summary = safeErrorSummary(error);
        await prisma.webhookDelivery.updateMany({
          where: { deliveryId, deliveryStatus: { in: ["received", "enqueue_failed"] } },
          data: {
            enqueued: false,
            deliveryStatus: "enqueue_failed",
            lastEnqueueFailureClass: summary.errorClass,
            lastEnqueueFailureMessage: summary.message,
            lastEnqueueFailedAt: new Date()
          }
        });
      },
      async markReplayed(deliveryId, actor) {
        await prisma.webhookDelivery.updateMany({
          where: { deliveryId },
          data: {
            replayCount: { increment: 1 },
            lastReplayedAt: new Date(),
            lastReplayedBy: actor
          }
        });
      },
      async findReplayable(target, organizationId) {
        if (!hasCompleteWebhookReplayTarget(target)) {
          return undefined;
        }
        const delivery = target.deliveryId
          ? await prisma.webhookDelivery.findFirst({
              where: {
                deliveryId: target.deliveryId,
                ...(organizationId ? { organizationId } : {})
              }
            })
          : await findReplayableWebhookByPullRequest(prisma, target, organizationId);
        if (!delivery) {
          return undefined;
        }
        const envelope = envelopeFromStoredWebhookDelivery(delivery);
        return envelope ? { delivery, envelope } : undefined;
      },
      async listRecentFailures(organizationId) {
        const deliveries = (await prisma.webhookDelivery.findMany({
          where: {
            OR: [{ lastFailedAt: { not: null } }, { lastEnqueueFailedAt: { not: null } }],
            ...(organizationId ? { organizationId } : {})
          },
          orderBy: [
            { lastEnqueueFailedAt: { sort: "desc", nulls: "last" } },
            { lastFailedAt: { sort: "desc", nulls: "last" } }
          ],
          take: QUEUE_FAILED_JOB_LIMIT
        })) as WebhookFailureRow[];
        return deliveries.map(webhookFailureForApi);
      }
    }
  };
}

async function findReplayableWebhookByPullRequest(
  prisma: PrismaClient,
  target: { repositoryFullName?: string | undefined; pullRequestNumber?: number | undefined },
  organizationId?: string
): Promise<StoredWebhookDelivery | null> {
  if (!target.repositoryFullName || target.pullRequestNumber === undefined) {
    return null;
  }
  return prisma.webhookDelivery.findFirst({
    where: {
      repositoryFullName: target.repositoryFullName,
      pullRequestNumber: target.pullRequestNumber,
      deliveryStatus: {
        in: ["received", "queued", "processing", "completed", "failed", "enqueue_failed"]
      },
      ...(organizationId ? { organizationId } : {})
    },
    orderBy: { createdAt: "desc" }
  });
}

async function persistEvaluationSnapshot(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    repositoryId: string;
    pullRequestId: string;
    record: ChangeControlRecord;
  }
): Promise<void> {
  const policyVersion = await ensurePolicyVersionSnapshot(prisma, input);
  const evaluation = await prisma.evaluation.create({
    data: {
      pullRequestId: input.pullRequestId,
      policyVersionId: policyVersion.id,
      mode: input.record.mode,
      status: input.record.checkStatus,
      headSha: input.record.headSha,
      completedAt: new Date(input.record.updatedAt),
      explanationJson: explainChangeControlRecord(input.record) as never
    }
  });
  if (input.record.verifiedFindings.length > 0) {
    await prisma.verifiedFactRecord.createMany({
      data: input.record.verifiedFindings.map((fact) => ({
        evaluationId: evaluation.id,
        type: fact.type,
        source: fact.source,
        path: fact.path ?? null,
        evidence: fact.evidence,
        confidence: fact.confidence,
        severity: fact.severity ?? null,
        metadataJson: (fact.metadata ?? null) as never
      }))
    });
  }
  if (input.record.requiredEvidence.length > 0) {
    await prisma.evidenceRequirementRecord.createMany({
      data: input.record.requiredEvidence.map((evidence) => ({
        evaluationId: evaluation.id,
        kind: evidence.kind,
        status: evidence.status,
        source: evidence.source ?? null,
        requiredByFindingId: evidence.requiredByFindingId,
        providedBy: evidence.providedBy ?? null,
        providedAt: evidence.providedAt ? new Date(evidence.providedAt) : null,
        approvedBy: evidence.approvedBy ?? null,
        approvedAt: evidence.approvedAt ? new Date(evidence.approvedAt) : null,
        contentSummary: evidence.contentSummary ?? null
      }))
    });
  }
  if (input.record.requiredReviewers.length > 0) {
    await prisma.reviewerRequirementRecord.createMany({
      data: input.record.requiredReviewers.map((reviewer) => ({
        evaluationId: evaluation.id,
        reviewer: reviewer.reviewer,
        reviewerType: reviewer.reviewerType,
        tier: reviewer.tier,
        reason: reviewer.reason,
        triggeredByFindingId: reviewer.triggeredByFindingId,
        clearsWhen: reviewer.clearsWhen ?? null,
        approved: reviewer.approved,
        approvedBy: reviewer.approvedBy ?? null,
        approvedAt: reviewer.approvedAt ? new Date(reviewer.approvedAt) : null
      }))
    });
  }
  await prisma.checkRun.create({
    data: {
      evaluationId: evaluation.id,
      conclusion: checkConclusionForRecord(input.record),
      outputTitle: "AgentForge Merge Guard",
      outputSummary: explainChangeControlRecord(input.record).join(" "),
      updatedAt: new Date(input.record.updatedAt)
    }
  });
}

async function ensurePolicyVersionSnapshot(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    repositoryId: string;
    record: ChangeControlRecord;
  }
) {
  const existing = await prisma.policyVersion.findFirst({
    where: {
      organizationId: input.organizationId,
      repositoryId: input.repositoryId,
      version: input.record.policyVersion
    }
  });
  if (existing) {
    return existing;
  }
  const policyPack = input.record.policyPackId
    ? await prisma.policyPack.findUnique({ where: { id: input.record.policyPackId } })
    : null;
  return prisma.policyVersion.create({
    data: {
      organizationId: input.organizationId,
      repositoryId: input.repositoryId,
      policyPackId: policyPack?.id ?? null,
      version: input.record.policyVersion,
      mode: input.record.mode,
      contentYaml: `# Runtime policy snapshot for ${input.record.repositoryFullName}#${input.record.pullRequestNumber}\n# Full policy content was not attached to this evaluation snapshot.`,
      contentHash: createHash("sha256")
        .update(`${input.record.policyVersion}:${input.record.policyPackId ?? ""}`)
        .digest("hex"),
      createdBy: "system"
    }
  });
}

function checkConclusionForRecord(
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

async function recordWebhookDeliveryReceived(
  persistence: PersistencePort,
  envelope: GithubWebhookEnvelope
): Promise<{ duplicate: boolean; status: WebhookDeliveryStatus }> {
  return persistence.webhookDeliveries.recordReceived(envelope);
}

function webhookDeliveryStatus(value: string, enqueued: boolean): WebhookDeliveryStatus {
  if (isWebhookDeliveryStatus(value)) {
    return value;
  }
  return enqueued ? "queued" : "received";
}

function isWebhookDeliveryStatus(value: string): value is WebhookDeliveryStatus {
  return (
    value === "received" ||
    value === "queued" ||
    value === "processing" ||
    value === "completed" ||
    value === "enqueue_failed" ||
    value === "failed"
  );
}

function isRecoverableWebhookDeliveryForEnqueue(status: WebhookDeliveryStatus): boolean {
  return status === "received" || status === "enqueue_failed";
}

async function markWebhookDeliveryQueued(
  persistence: PersistencePort,
  deliveryId: string,
  queueJobId: string
): Promise<void> {
  await persistence.webhookDeliveries.markQueued(deliveryId, queueJobId);
}

async function markWebhookDeliveryCompleted(
  persistence: PersistencePort,
  deliveryId: string
): Promise<void> {
  await persistence.webhookDeliveries.markCompleted(deliveryId);
}

async function markWebhookDeliveryEnqueueFailed(
  persistence: PersistencePort,
  deliveryId: string,
  error: unknown
): Promise<void> {
  await persistence.webhookDeliveries.markEnqueueFailed(deliveryId, error);
}

async function processGithubInstallationWebhook(
  state: AppState,
  prisma: PrismaClient | undefined,
  envelope: GithubWebhookEnvelope,
  config?: ReturnType<typeof loadConfig>
): Promise<void> {
  const installation = envelope.installation;
  if (!installation || !prisma) {
    return;
  }
  const existing = await prisma.gitHubInstallation.findUnique({
    where: { githubInstallationId: BigInt(installation.id) }
  });
  const now = new Date();
  const archiveAction =
    envelope.event === "installation" &&
    (envelope.action === "deleted" || envelope.action === "suspend");
  const status = archiveAction
    ? "archived"
    : existing?.status === "approved"
      ? "approved"
      : "pending_approval";
  const approvedBy = status === "approved" ? (existing?.approvedBy ?? null) : null;
  const approvedAt = status === "approved" ? (existing?.approvedAt ?? null) : null;
  const row = await prisma.gitHubInstallation.upsert({
    where: { githubInstallationId: BigInt(installation.id) },
    update: {
      accountLogin:
        installation.accountLogin || existing?.accountLogin || `installation-${installation.id}`,
      accountType: installation.accountType || existing?.accountType || "Organization",
      status,
      approvedBy,
      approvedAt,
      rejectedBy: null,
      rejectedAt: null,
      archivedAt: archiveAction ? now : null,
      lastWebhookAt: now
    },
    create: {
      githubInstallationId: BigInt(installation.id),
      accountLogin: installation.accountLogin || `installation-${installation.id}`,
      accountType: installation.accountType || "Organization",
      status,
      approvedBy,
      approvedAt,
      rejectedBy: null,
      rejectedAt: null,
      archivedAt: archiveAction ? now : null,
      lastWebhookAt: now
    }
  });
  if (
    row.organizationId &&
    !archiveAction &&
    row.status === "approved" &&
    config &&
    (await syncRepositoriesFromCurrentGithubInstallation(state, prisma, config, {
      organizationId: row.organizationId,
      githubInstallationId: row.githubInstallationId.toString(),
      accountLogin: row.accountLogin,
      accountType: row.accountType
    }))
  ) {
    return;
  }
  if (row.organizationId && !archiveAction) {
    await syncRepositoriesFromInstallation(state, prisma, row.organizationId, installation);
  }
  if (row.organizationId && installation.repositoriesRemoved.length > 0) {
    await archiveRemovedRepositories(prisma, row.organizationId, installation.repositoriesRemoved);
  }
}

async function upsertPendingGithubInstallation(
  prisma: PrismaClient | undefined,
  input: z.infer<typeof githubInstallationVerifySchema> & { organizationId: string }
) {
  if (!prisma) {
    throw new Error("GitHub installation verification requires the Postgres runtime store.");
  }
  const id = BigInt(input.githubInstallationId);
  await ensureOrganization(prisma, input.organizationId);
  const existing = await prisma.gitHubInstallation.findUnique({
    where: { githubInstallationId: id }
  });
  if (existing?.organizationId && existing.organizationId !== input.organizationId) {
    return undefined;
  }
  if (!existing && !input.accountLogin) {
    return undefined;
  }
  const status = existing?.status === "approved" ? "approved" : "pending_approval";
  const data = {
    organizationId: input.organizationId,
    accountLogin:
      input.accountLogin ?? existing?.accountLogin ?? `installation-${input.githubInstallationId}`,
    accountType: input.accountType ?? existing?.accountType ?? "Organization",
    status,
    approvedBy: status === "approved" ? (existing?.approvedBy ?? null) : null,
    approvedAt: status === "approved" ? (existing?.approvedAt ?? null) : null,
    rejectedBy: null,
    rejectedAt: null,
    archivedAt: null,
    lastWebhookAt: new Date()
  };
  const row = existing
    ? await prisma.gitHubInstallation.update({
        where: { id: existing.id },
        data
      })
    : await prisma.gitHubInstallation.create({
        data: {
          ...data,
          organizationId: input.organizationId,
          archivedAt: null,
          githubInstallationId: id
        }
      });
  return githubInstallationForApi(row);
}

async function fetchGithubInstallationAccount(
  config: ReturnType<typeof loadConfig>,
  githubInstallationId: string
): Promise<{ accountLogin: string; accountType: "Organization" | "User" } | undefined> {
  if (!config.github.appId || !config.github.privateKey) {
    return undefined;
  }
  try {
    const token = await createGithubAppToken({
      appId: config.github.appId,
      privateKey: config.github.privateKey
    });
    const response = await fetchGithubApi(
      `https://api.github.com/app/installations/${encodeURIComponent(githubInstallationId)}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": "AgentForge"
        }
      }
    );
    if (!response.ok) {
      return undefined;
    }
    const body = objectRecord(await response.json());
    const account = objectRecord(body?.account);
    const login = stringFromUnknown(account?.login);
    const type = stringFromUnknown(account?.type);
    if (!login || (type !== "Organization" && type !== "User")) {
      return undefined;
    }
    return { accountLogin: login, accountType: type };
  } catch {
    return undefined;
  }
}

async function fetchGithubApi(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGithubInstallationRepositories(
  config: ReturnType<typeof loadConfig>,
  githubInstallationId: string
): Promise<GithubRepositoryRef[] | undefined> {
  if (!config.github.appId || !config.github.privateKey) {
    return undefined;
  }
  try {
    const token = await createGithubInstallationToken({
      appId: config.github.appId,
      privateKey: config.github.privateKey,
      installationId: githubInstallationId
    });
    const repositories: GithubRepositoryRef[] = [];
    for (let page = 1; page <= GITHUB_INSTALLATION_REPOSITORY_PAGE_LIMIT; page += 1) {
      const response = await fetchGithubApi(
        `https://api.github.com/installation/repositories?per_page=${GITHUB_INSTALLATION_REPOSITORY_PAGE_SIZE}&page=${page}`,
        {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "user-agent": "AgentForge"
          }
        }
      );
      if (!response.ok) {
        return undefined;
      }
      const body = objectRecord(await response.json());
      const pageRepositories = Array.isArray(body?.repositories)
        ? body.repositories
            .map((repo) => {
              const record = objectRecord(repo);
              const id = numberFromUnknown(record?.id);
              const fullName = stringFromUnknown(record?.full_name);
              return id && fullName ? { id, fullName } : undefined;
            })
            .filter((repo): repo is { id: number; fullName: string } => Boolean(repo))
        : [];
      repositories.push(...pageRepositories);
      const pageState = githubInstallationRepositoryPageState({
        body,
        pageRepositoryCount: pageRepositories.length,
        repositoriesSeen: repositories.length
      });
      if (pageState.exceedsSafetyLimit) {
        return undefined;
      }
      if (pageState.complete) {
        return repositories;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function githubInstallationRepositoryPageState(input: {
  body: Record<string, unknown> | undefined;
  pageRepositoryCount: number;
  repositoriesSeen: number;
}): { complete: boolean; exceedsSafetyLimit: boolean } {
  const totalCount = numberFromUnknown(input.body?.total_count);
  const safetyLimit =
    GITHUB_INSTALLATION_REPOSITORY_PAGE_SIZE * GITHUB_INSTALLATION_REPOSITORY_PAGE_LIMIT;
  if (totalCount !== undefined) {
    return {
      complete: input.repositoriesSeen >= totalCount,
      exceedsSafetyLimit: totalCount > safetyLimit
    };
  }
  return {
    complete: input.pageRepositoryCount < GITHUB_INSTALLATION_REPOSITORY_PAGE_SIZE,
    exceedsSafetyLimit: false
  };
}

async function syncRepositoriesFromCurrentGithubInstallation(
  state: AppState,
  prisma: PrismaClient | undefined,
  config: ReturnType<typeof loadConfig>,
  input: {
    organizationId?: string | undefined;
    githubInstallationId: string;
    accountLogin: string;
    accountType?: string | undefined;
  }
): Promise<boolean> {
  if (!prisma || !input.organizationId || !input.accountLogin) {
    return false;
  }
  const repositories = await fetchGithubInstallationRepositories(
    config,
    input.githubInstallationId
  );
  if (!repositories) {
    return false;
  }
  const currentRepositoryIds = new Set(
    repositories.map((repository) => githubRepositoryBigInt(repository).toString())
  );
  const currentNames = new Set(repositories.map((repository) => repository.fullName));
  const existingRepositories = (await prisma.repository.findMany({
    where: {
      organizationId: input.organizationId,
      fullName: { startsWith: `${input.accountLogin}/` }
    },
    select: { fullName: true, githubRepositoryId: true }
  })) as RepositoryInstallationRow[];
  const staleRepositories = existingRepositories
    .filter(
      (repository) =>
        !currentRepositoryIds.has(repository.githubRepositoryId.toString()) &&
        !currentNames.has(repository.fullName)
    )
    .map((repository) => ({
      id: 0,
      fullName: repository.fullName,
      githubRepositoryId: repository.githubRepositoryId
    }));

  await syncRepositoriesFromInstallation(state, prisma, input.organizationId, {
    id: Number(input.githubInstallationId),
    accountLogin: input.accountLogin,
    accountType: input.accountType === "User" ? "User" : "Organization",
    repositoriesAdded: repositories,
    repositoriesRemoved: staleRepositories
  });
  if (staleRepositories.length > 0) {
    await archiveRemovedRepositories(prisma, input.organizationId, staleRepositories);
  }
  return true;
}

async function approveGithubInstallation(
  prisma: PrismaClient | undefined,
  input: { id: string; organizationId: string; actor: string }
) {
  if (!prisma) {
    throw new Error("GitHub installation approval requires the Postgres runtime store.");
  }
  await ensureOrganization(prisma, input.organizationId);
  const existing = await prisma.gitHubInstallation.findFirst({
    where: { id: input.id, organizationId: input.organizationId }
  });
  if (!existing) {
    return undefined;
  }
  const row = await prisma.gitHubInstallation.update({
    where: { id: existing.id },
    data: {
      organizationId: input.organizationId,
      status: "approved",
      approvedBy: input.actor,
      approvedAt: new Date(),
      rejectedBy: null,
      rejectedAt: null,
      archivedAt: null
    }
  });
  return githubInstallationForApi(row);
}

async function rejectGithubInstallation(
  prisma: PrismaClient | undefined,
  input: { id: string; organizationId: string; actor: string }
) {
  if (!prisma) {
    throw new Error("GitHub installation rejection requires the Postgres runtime store.");
  }
  const existing = await prisma.gitHubInstallation.findFirst({
    where: { id: input.id, organizationId: input.organizationId }
  });
  if (!existing) {
    return undefined;
  }
  const row = await prisma.gitHubInstallation.update({
    where: { id: existing.id },
    data: {
      status: "rejected",
      approvedBy: null,
      approvedAt: null,
      rejectedBy: input.actor,
      rejectedAt: new Date(),
      archivedAt: new Date()
    }
  });
  return githubInstallationForApi(row);
}

async function syncRepositoriesFromStoredInstallationEvents(
  state: AppState,
  prisma: PrismaClient | undefined,
  installation: { organizationId?: string | undefined; githubInstallationId: string }
): Promise<void> {
  if (!prisma || !installation.organizationId) {
    return;
  }
  const pageSize = 250;
  let cursor: string | undefined;
  for (;;) {
    const deliveries = await prisma.webhookDelivery.findMany({
      where: { event: { in: ["installation", "installation_repositories"] } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: pageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });
    if (deliveries.length === 0) {
      return;
    }
    for (const delivery of deliveries) {
      const payload = delivery.payloadJson as {
        installation?: GithubWebhookEnvelope["installation"];
      } | null;
      const stored = payload?.installation;
      if (stored?.id && String(stored.id) === installation.githubInstallationId) {
        await syncRepositoriesFromInstallation(state, prisma, installation.organizationId, stored);
      }
    }
    if (deliveries.length < pageSize) {
      return;
    }
    cursor = deliveries.at(-1)?.id;
  }
}

async function syncRepositoriesFromInstallation(
  state: AppState,
  prisma: PrismaClient,
  organizationId: string,
  installation: NonNullable<GithubWebhookEnvelope["installation"]>
): Promise<void> {
  await ensureOrganization(prisma, organizationId);
  for (const repo of installation.repositoriesAdded) {
    if (!repo.fullName) {
      continue;
    }
    const repository = await ensureRepository(
      prisma,
      {
        organizationId,
        repositoryId: repositoryIdFromFullName(repo.fullName),
        fullName: repo.fullName,
        defaultBranch: "main",
        githubRepositoryId: githubRepositoryBigInt(repo)
      },
      { forceUnarchive: true }
    );
    state.repositorySettings.set(repository.id, {
      repositoryId: repository.id,
      organizationId,
      enabled: repository.enabled,
      mode: repository.mode ?? undefined,
      updatedAt: new Date().toISOString()
    });
  }
  await archiveRemovedRepositories(prisma, organizationId, installation.repositoriesRemoved);
}

async function archiveRemovedRepositories(
  prisma: PrismaClient,
  organizationId: string,
  repositoriesRemoved: GithubRepositoryRef[]
): Promise<void> {
  for (const repo of repositoriesRemoved) {
    await prisma.repository.updateMany({
      where: {
        organizationId,
        OR: [
          { githubRepositoryId: repo.githubRepositoryId ?? githubRepositoryBigInt(repo) },
          ...(repo.fullName ? [{ fullName: repo.fullName }] : [])
        ]
      },
      data: {
        enabled: false,
        archivedAt: new Date(),
        archiveReason: "github_installation_removed"
      }
    });
  }
}

function githubRepositoryBigInt(repo: GithubRepositoryRef): bigint {
  return repo.id > 0 ? BigInt(repo.id) : stableBigInt(repo.fullName);
}

async function enqueueMergeGuardEvaluation(input: {
  state: AppState;
  evaluationQueue: Queue<MergeGuardEvaluationJobPayload> | undefined;
  deliveryId: string;
  envelope: GithubWebhookEnvelope;
  jobId?: string | undefined;
}): Promise<QueueEnqueueResult> {
  const jobId = input.jobId ?? input.deliveryId;
  if (input.evaluationQueue) {
    await input.evaluationQueue.add(
      MERGE_GUARD_EVALUATION_JOB_NAME,
      { deliveryId: input.deliveryId, envelope: input.envelope },
      mergeGuardEvaluationJobOptions(jobId)
    );
    return { jobId, deliveryId: input.deliveryId, backend: "redis" };
  }

  const existing = input.state.queuedEvaluations.find((item) => item.id === jobId);
  if (existing) {
    return { jobId, deliveryId: input.deliveryId, backend: "in_memory" };
  }
  input.state.queuedEvaluations.push({
    id: jobId,
    deliveryId: input.deliveryId,
    envelope: input.envelope,
    queuedAt: new Date().toISOString()
  });
  return { jobId, deliveryId: input.deliveryId, backend: "in_memory" };
}

async function queueOperationalStatus(input: {
  state: AppState;
  evaluationQueue: Queue<MergeGuardEvaluationJobPayload> | undefined;
}): Promise<{
  status: "ready" | "not_ready";
  backend: QueueBackend;
  retryPolicy: {
    attempts: number;
    backoff: { type: "exponentialWithJitter"; delayMs: number };
    removeOnComplete: number;
    removeOnFail: number;
  };
  counts: Record<string, number>;
  failedJobs: Array<Record<string, unknown>>;
  error?: { errorClass: string; message: string } | undefined;
}> {
  const retryPolicy = {
    attempts: MERGE_GUARD_EVALUATION_ATTEMPTS,
    backoff: {
      type: "exponentialWithJitter" as const,
      delayMs: MERGE_GUARD_EVALUATION_BACKOFF_MS
    },
    removeOnComplete: 100,
    removeOnFail: 500
  };

  if (!input.evaluationQueue) {
    return {
      status: "ready",
      backend: "in_memory",
      retryPolicy,
      counts: {
        waiting: input.state.queuedEvaluations.length,
        active: 0,
        delayed: 0,
        failed: 0,
        completed: 0,
        paused: 0
      },
      failedJobs: []
    };
  }

  try {
    const [counts, failedJobs] = await withTimeout(
      Promise.all([
        input.evaluationQueue.getJobCounts(
          "waiting",
          "active",
          "delayed",
          "failed",
          "completed",
          "paused"
        ),
        input.evaluationQueue.getJobs(["failed"], 0, QUEUE_FAILED_JOB_LIMIT - 1, false)
      ]),
      QUEUE_STATUS_TIMEOUT_MS
    );
    return {
      status: "ready",
      backend: "redis",
      retryPolicy,
      counts,
      failedJobs: failedJobs.map((job) => ({
        id: job.id,
        name: job.name,
        deliveryId: job.data.deliveryId,
        attemptsMade: job.attemptsMade,
        failedReason: safeErrorText(job.failedReason),
        timestamp: job.timestamp,
        processedOn: job.processedOn,
        finishedOn: job.finishedOn
      }))
    };
  } catch (error) {
    return {
      status: "not_ready",
      backend: "redis",
      retryPolicy,
      counts: {},
      failedJobs: [],
      error: safeErrorSummary(error)
    };
  }
}

async function collectPrometheusMetrics(input: {
  state: AppState;
  prisma: PrismaClient | undefined;
  evaluationQueue: Queue<MergeGuardEvaluationJobPayload> | undefined;
  config: ReturnType<typeof loadConfig>;
}): Promise<string> {
  const queue = await queueOperationalStatus({
    state: input.state,
    evaluationQueue: input.evaluationQueue
  });
  const lines: string[] = [
    "# HELP agentforge_runtime_store Runtime persistence backend. 1 means active.",
    "# TYPE agentforge_runtime_store gauge",
    metricLine("agentforge_runtime_store", { backend: input.prisma ? "postgres" : "in_memory" }, 1),
    "# HELP agentforge_github_app_configured GitHub App credentials configured. 1 means configured.",
    "# TYPE agentforge_github_app_configured gauge",
    metricLine(
      "agentforge_github_app_configured",
      {},
      input.config.github.appId && input.config.github.privateKey ? 1 : 0
    ),
    "# HELP agentforge_queue_ready Merge Guard evaluation queue readiness. 1 means ready.",
    "# TYPE agentforge_queue_ready gauge",
    metricLine(
      "agentforge_queue_ready",
      { backend: queue.backend },
      queue.status === "ready" ? 1 : 0
    ),
    "# HELP agentforge_queue_jobs Merge Guard evaluation queue jobs by state.",
    "# TYPE agentforge_queue_jobs gauge"
  ];
  for (const [stateName, count] of Object.entries(queue.counts)) {
    lines.push(metricLine("agentforge_queue_jobs", { state: stateName }, count));
  }

  const domainCounts = await domainMetricCounts(input.state, input.prisma);
  lines.push(
    "# HELP agentforge_webhook_deliveries_total GitHub webhook deliveries recorded by status.",
    "# TYPE agentforge_webhook_deliveries_total gauge"
  );
  for (const [status, count] of Object.entries(domainCounts.webhookDeliveriesByStatus)) {
    lines.push(metricLine("agentforge_webhook_deliveries_total", { status }, count));
  }
  lines.push(
    "# HELP agentforge_change_control_records_total Change Control Records by check status.",
    "# TYPE agentforge_change_control_records_total gauge"
  );
  for (const [status, count] of Object.entries(domainCounts.recordsByStatus)) {
    lines.push(metricLine("agentforge_change_control_records_total", { status }, count));
  }
  lines.push(
    "# HELP agentforge_check_runs_total Persisted Merge Guard check-run publications.",
    "# TYPE agentforge_check_runs_total gauge",
    metricLine("agentforge_check_runs_total", {}, domainCounts.checkRuns),
    "# HELP agentforge_exports_total Audit export jobs created.",
    "# TYPE agentforge_exports_total gauge",
    metricLine("agentforge_exports_total", {}, domainCounts.exports)
  );
  lines.push(
    "# HELP agentforge_audit_events_total Audit events by security-relevant action.",
    "# TYPE agentforge_audit_events_total gauge"
  );
  for (const [action, count] of Object.entries(domainCounts.auditEventsByAction).sort(
    ([left], [right]) => left.localeCompare(right)
  )) {
    lines.push(metricLine("agentforge_audit_events_total", { action }, count));
  }
  return `${lines.join("\n")}\n`;
}

async function domainMetricCounts(
  state: AppState,
  prisma: PrismaClient | undefined
): Promise<{
  webhookDeliveriesByStatus: Record<string, number>;
  recordsByStatus: Record<string, number>;
  checkRuns: number;
  exports: number;
  auditEventsByAction: Record<string, number>;
}> {
  if (!prisma) {
    return {
      webhookDeliveriesByStatus: {
        recorded: state.deliveries.size
      },
      recordsByStatus: countBy(state.records, (record) => record.checkStatus),
      checkRuns: 0,
      exports: state.exports.length,
      auditEventsByAction: countBy(state.auditEvents, (event) => event.action)
    };
  }

  const [webhookGroups, recordGroups, checkRuns, exports, auditEventGroups] = (await Promise.all([
    prisma.webhookDelivery.groupBy({ by: ["deliveryStatus"], _count: { _all: true } }),
    prisma.changeControlRecord.groupBy({ by: ["checkStatus"], _count: { _all: true } }),
    prisma.checkRun.count(),
    prisma.exportJob.count(),
    prisma.auditEvent.groupBy({ by: ["action"], _count: { _all: true } })
  ])) as [
    Array<CountGroup<"deliveryStatus">>,
    Array<CountGroup<"checkStatus">>,
    number,
    number,
    Array<CountGroup<"action">>
  ];
  return {
    webhookDeliveriesByStatus: Object.fromEntries(
      webhookGroups.map((group) => [group.deliveryStatus, group._count._all])
    ),
    recordsByStatus: Object.fromEntries(
      recordGroups.map((group) => [String(group.checkStatus), group._count._all])
    ),
    checkRuns,
    exports,
    auditEventsByAction: Object.fromEntries(
      auditEventGroups.map((group) => [group.action, group._count._all])
    )
  };
}

function runtimeCapabilities(input: { postgres: boolean; redisQueue: boolean }): {
  durableRecords: boolean;
  durableWebhookReplay: boolean;
  manualGitHubInstallationApproval: boolean;
  queueBackedEvaluations: boolean;
  productionReady: boolean;
} {
  return {
    durableRecords: input.postgres,
    durableWebhookReplay: input.postgres,
    manualGitHubInstallationApproval: input.postgres,
    queueBackedEvaluations: input.redisQueue,
    productionReady: input.postgres && input.redisQueue
  };
}

async function findReplayableDelivery(
  persistence: PersistencePort,
  target: z.infer<typeof queueReplaySchema>,
  organizationId?: string
): Promise<ReplayableDelivery | undefined> {
  return persistence.webhookDeliveries.findReplayable(target, organizationId);
}

function envelopeFromStoredWebhookDelivery(
  delivery: StoredWebhookDelivery
): GithubWebhookEnvelope | undefined {
  const payload = objectRecord(delivery.payloadJson);
  if (!payload) {
    return undefined;
  }
  return {
    deliveryId: delivery.deliveryId,
    event: delivery.event,
    action: delivery.action ?? undefined,
    installationId: numberFromUnknown(payload.installationId),
    repository: objectRecord(payload.repository) as GithubWebhookEnvelope["repository"],
    pullRequest: objectRecord(payload.pullRequest) as GithubWebhookEnvelope["pullRequest"],
    review: objectRecord(payload.review) as GithubWebhookEnvelope["review"],
    checkRun: objectRecord(payload.checkRun) as GithubWebhookEnvelope["checkRun"],
    installation: objectRecord(payload.installation) as GithubWebhookEnvelope["installation"],
    receivedAt:
      stringFromUnknown(payload.receivedAt) ??
      dateString(delivery.createdAt) ??
      new Date().toISOString()
  };
}

async function markWebhookDeliveryReplayed(
  persistence: PersistencePort,
  deliveryId: string,
  actor: string
): Promise<void> {
  await persistence.webhookDeliveries.markReplayed(deliveryId, actor);
}

async function listRecentWebhookDeliveryFailures(
  persistence: PersistencePort,
  organizationId?: string
): Promise<Array<Record<string, unknown>>> {
  return persistence.webhookDeliveries.listRecentFailures(organizationId);
}

function webhookFailureForApi(delivery: WebhookFailureRow): Record<string, unknown> {
  return {
    deliveryId: delivery.deliveryId,
    deliveryStatus: delivery.deliveryStatus,
    queueJobId: delivery.queueJobId,
    repositoryFullName: delivery.repositoryFullName,
    pullRequestNumber: delivery.pullRequestNumber,
    headSha: delivery.headSha,
    attemptsMade: delivery.evaluationAttemptsMade,
    terminalFailure: delivery.evaluationTerminalFailure,
    enqueueErrorClass: delivery.lastEnqueueFailureClass,
    enqueueMessage: safeErrorText(delivery.lastEnqueueFailureMessage),
    enqueueFailedAt: dateString(delivery.lastEnqueueFailedAt),
    errorClass: delivery.lastFailureClass,
    message: safeErrorText(delivery.lastFailureMessage),
    correlationId: delivery.lastFailureCorrelationId,
    failedAt: dateString(delivery.lastFailedAt),
    replayCount: delivery.replayCount,
    lastReplayedAt: dateString(delivery.lastReplayedAt),
    lastReplayedBy: delivery.lastReplayedBy
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Queue status check timed out.")), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function safeErrorSummary(error: unknown): { errorClass: string; message: string } {
  if (error instanceof Error) {
    return {
      errorClass: safeErrorClass(error.name),
      message: safeErrorText(error.message)
    };
  }
  return {
    errorClass: "UnknownError",
    message: safeErrorText(String(error))
  };
}

function safeErrorClass(value: string): string {
  const trimmed = value.trim();
  return /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(trimmed) ? trimmed : "Error";
}

function safeErrorText(value: unknown): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return summarizeSafeSnippet(text, 500);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberFromUnknown(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function dateString(value: Date | string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value instanceof Date ? value.toISOString() : value;
}

async function saveExportJob(
  persistence: PersistencePort,
  job: ExportJob,
  actor: string,
  actorRole: string
): Promise<void> {
  await persistence.exportJobs.save(job, { actor, actorRole });
}

async function getExportJob(
  persistence: PersistencePort,
  id: string
): Promise<ExportJob | undefined> {
  return persistence.exportJobs.get(id);
}

async function listAuditEvents(
  persistence: PersistencePort,
  organizationId?: string
): Promise<AuditEventRecord[]> {
  return persistence.auditEvents.list(organizationId ? { organizationId } : undefined);
}

async function listAuditEventsForRecordExport(
  persistence: PersistencePort,
  records: ChangeControlRecord[]
): Promise<AuditEventRecord[]> {
  return persistence.auditEvents.listForRecordExport(records);
}

function auditEventRecordFromRow(row: AuditEventRow): AuditEventRecord {
  const metadataJson = normalizeAuditEventMetadata(row);
  return {
    id: row.id,
    schemaVersion: row.schemaVersion,
    organizationId: row.organizationId,
    repositoryId: row.repositoryId ?? undefined,
    pullRequestId: row.pullRequestId ?? undefined,
    actor: row.actor,
    actorRole: row.actorRole,
    action: row.action as AuditEventRecord["action"],
    targetType: row.targetType,
    targetId: row.targetId,
    source: auditEventSource(row.source),
    requestId: row.requestId ?? undefined,
    correlationId: row.correlationId ?? undefined,
    policyVersion: row.policyVersion ?? undefined,
    policyPackId: row.policyPackId ?? undefined,
    policyPackVersion: row.policyPackVersion ?? undefined,
    metadataJson,
    createdAt: row.createdAt.toISOString()
  };
}

function normalizeAuditEventMetadata(row: AuditEventRow): Record<string, unknown> {
  const metadata =
    row.metadataJson && typeof row.metadataJson === "object" && !Array.isArray(row.metadataJson)
      ? (row.metadataJson as Record<string, unknown>)
      : {};
  return {
    ...metadata,
    schemaVersion: row.schemaVersion,
    actorRole: row.actorRole,
    source: auditEventSource(row.source),
    ...(row.requestId ? { requestId: row.requestId } : {}),
    ...(row.correlationId ? { correlationId: row.correlationId } : {}),
    ...(row.policyVersion ? { policyVersion: row.policyVersion } : {}),
    ...(row.policyPackId ? { policyPackId: row.policyPackId } : {}),
    ...(row.policyPackVersion ? { policyPackVersion: row.policyPackVersion } : {})
  };
}

async function recordAuditEvent(
  persistence: PersistencePort,
  input: Parameters<typeof createAuditEvent>[0]
): Promise<AuditEventRecord> {
  const event = createAuditEvent(input);
  await saveAuditEvent(persistence, event);
  return event;
}

async function saveAuditEvent(
  persistence: PersistencePort,
  event: AuditEventRecord
): Promise<void> {
  await persistence.auditEvents.append(event);
}

function auditEventSource(value: string): AuditEventRecord["source"] {
  return value === "api" || value === "worker" || value === "webhook" || value === "system"
    ? value
    : "api";
}

export const testInternals = {
  approveGithubInstallation,
  ensureRepository,
  fetchGithubInstallationAccount,
  fetchGithubInstallationRepositories,
  githubInstallationRepositoryPageState,
  listGithubInstallations,
  processGithubInstallationWebhook,
  rejectGithubInstallation,
  syncRepositoriesFromStoredInstallationEvents,
  upsertPendingGithubInstallation
};

async function saveOverrideRecord(
  persistence: PersistencePort,
  override: OverrideRecord
): Promise<void> {
  await persistence.overrides.save(override);
}

async function ensureOrganization(prisma: PrismaClient, id: string) {
  return prisma.organization.upsert({
    where: { id },
    update: {},
    create: {
      id,
      name: humanizeIdentifier(id),
      slug: id
    }
  });
}

async function ensureRepository(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    repositoryId: string;
    fullName: string;
    defaultBranch: string;
    githubRepositoryId?: bigint | undefined;
  },
  options: { forceUnarchive?: boolean } = {}
) {
  const [owner = "unknown", name = input.fullName] = input.fullName.split("/");
  const githubRepositoryId = input.githubRepositoryId ?? stableBigInt(input.fullName);
  const existing = await prisma.repository.findUnique({
    where: { githubRepositoryId },
    select: { archivedAt: true }
  });
  const shouldReactivate = options.forceUnarchive && Boolean(existing?.archivedAt);
  return prisma.repository.upsert({
    where: { githubRepositoryId },
    update: {
      organizationId: input.organizationId,
      fullName: input.fullName,
      owner,
      name,
      defaultBranch: input.defaultBranch,
      ...(options.forceUnarchive
        ? {
            ...(shouldReactivate ? { enabled: true } : {}),
            archivedAt: null,
            archiveReason: null
          }
        : {})
    },
    create: {
      id: input.repositoryId,
      organizationId: input.organizationId,
      githubRepositoryId,
      fullName: input.fullName,
      owner,
      name,
      defaultBranch: input.defaultBranch,
      protected: false,
      enabled: true
    }
  });
}

function changeControlRecordData(record: ChangeControlRecord) {
  return {
    repositoryFullName: record.repositoryFullName,
    pullRequestNumber: record.pullRequestNumber,
    headSha: record.headSha,
    baseBranch: record.baseBranch,
    mode: record.mode,
    policyVersion: record.policyVersion,
    policyPackId: record.policyPackId ?? null,
    policyPackVersion: record.policyPackVersion ?? null,
    checkStatus: record.checkStatus,
    lifecycle: record.lifecycle,
    verifiedFindingsJson: record.verifiedFindings as never,
    requiredEvidenceJson: record.requiredEvidence as never,
    requiredReviewersJson: record.requiredReviewers as never,
    decisionJson: (record.decision ?? null) as never,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt)
  };
}

function changeControlRecordFromRow(row: {
  id: string;
  pullRequestId: string;
  repositoryFullName: string;
  pullRequestNumber: number;
  headSha: string;
  baseBranch: string;
  mode: ChangeControlRecord["mode"];
  policyVersion: string;
  policyPackId: string | null;
  policyPackVersion: string | null;
  checkStatus: ChangeControlRecord["checkStatus"];
  lifecycle: ChangeControlRecord["lifecycle"];
  verifiedFindingsJson: unknown;
  requiredEvidenceJson: unknown;
  requiredReviewersJson: unknown;
  decisionJson: unknown;
  createdAt: Date;
  updatedAt: Date;
  pullRequest?: { repositoryId: string; repository?: { organizationId: string } | null } | null;
}): ChangeControlRecord {
  const output = {
    id: row.id,
    organizationId: row.pullRequest?.repository?.organizationId ?? "org_local",
    repositoryId: row.pullRequest?.repositoryId ?? repositoryIdFromFullName(row.repositoryFullName),
    repositoryFullName: row.repositoryFullName,
    pullRequestNumber: row.pullRequestNumber,
    headSha: row.headSha,
    baseBranch: row.baseBranch,
    mode: row.mode,
    policyVersion: row.policyVersion,
    policyPackId: row.policyPackId ?? undefined,
    policyPackVersion: row.policyPackVersion ?? undefined,
    verifiedFindings: row.verifiedFindingsJson as ChangeControlRecord["verifiedFindings"],
    requiredEvidence: row.requiredEvidenceJson as ChangeControlRecord["requiredEvidence"],
    requiredReviewers: row.requiredReviewersJson as ChangeControlRecord["requiredReviewers"],
    checkStatus: row.checkStatus,
    lifecycle: row.lifecycle,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
  const decision = row.decisionJson as ChangeControlRecord["decision"] | null;
  return decision ? { ...output, decision } : output;
}

function rememberRecord(state: AppState, record: ChangeControlRecord): void {
  state.records = [record, ...state.records.filter((item) => item.id !== record.id)];
}

function stableBigInt(value: string): bigint {
  return BigInt(`0x${createHash("sha256").update(value).digest("hex").slice(0, 15)}`);
}

async function findRepositoryIdByFullName(
  state: AppState,
  prisma: PrismaClient | undefined,
  fullName: string
): Promise<string | undefined> {
  const inMemory = state.records.find((record) => record.repositoryFullName === fullName);
  if (inMemory) {
    return inMemory.repositoryId;
  }
  if (!prisma) {
    return undefined;
  }
  const repository = await prisma.repository.findFirst({
    where: { fullName },
    select: { id: true }
  });
  return repository?.id;
}

async function getRepositoryModeOverride(
  state: AppState,
  prisma: PrismaClient | undefined,
  repositoryId: string
): Promise<ChangeControlRecord["mode"] | undefined> {
  const inMemory = state.repositorySettings.get(repositoryId)?.mode;
  if (inMemory) {
    return inMemory;
  }
  if (!prisma) {
    return undefined;
  }
  const repository = await prisma.repository.findUnique({
    where: { id: repositoryId },
    select: { mode: true }
  });
  return repository?.mode ?? undefined;
}

function repositoryIdFromFullName(fullName: string): string {
  return `repo_${createHash("sha256").update(fullName).digest("hex").slice(0, 12)}`;
}

function effectiveRepositoryMode(
  repositoryMode: ChangeControlRecord["mode"] | null | undefined,
  policyMode: ChangeControlRecord["mode"] | null | undefined,
  defaultMode: ChangeControlRecord["mode"]
): ChangeControlRecord["mode"] {
  return repositoryMode ?? policyMode ?? defaultMode;
}

function humanizeIdentifier(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

async function githubInstallationSummary(
  prisma: PrismaClient | undefined,
  config: ReturnType<typeof loadConfig>,
  organizationId: string
) {
  const credentialsConfigured = githubCredentialsConfigured(config);
  const appCredentialsConfigured = Boolean(config.github.appId && config.github.privateKey);
  const webhookSecretConfigured = Boolean(config.github.webhookSecret);
  const installUrl = githubInstallUrl(config);
  if (prisma) {
    const installation = await prisma.gitHubInstallation.findFirst({
      where: {
        status: "approved",
        archivedAt: null,
        organizationId
      },
      orderBy: { approvedAt: "desc" }
    });
    const pendingApprovalCount = await prisma.gitHubInstallation.count({
      where: {
        status: "pending_approval",
        archivedAt: null,
        organizationId
      }
    });
    if (installation) {
      return {
        connected: true,
        credentialsConfigured,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        githubInstallationId: installation.githubInstallationId.toString(),
        status: installation.status,
        pendingApprovalCount,
        installUrl,
        appCredentialsConfigured,
        webhookSecretConfigured
      };
    }
    return {
      connected: false,
      credentialsConfigured,
      accountLogin: undefined,
      accountType: undefined,
      githubInstallationId: undefined,
      status: pendingApprovalCount > 0 ? "pending_approval" : "not_connected",
      pendingApprovalCount,
      installUrl,
      appCredentialsConfigured,
      webhookSecretConfigured
    };
  }
  return {
    connected: false,
    credentialsConfigured,
    accountLogin: undefined,
    accountType: undefined,
    githubInstallationId: undefined,
    status: "not_connected",
    pendingApprovalCount: 0,
    installUrl,
    appCredentialsConfigured,
    webhookSecretConfigured
  };
}

function githubCredentialsConfigured(config: ReturnType<typeof loadConfig>): boolean {
  return Boolean(config.github.appId && config.github.privateKey && config.github.webhookSecret);
}

function githubInstallUrl(config: ReturnType<typeof loadConfig>): string | undefined {
  if (!config.github.appSlug) {
    return undefined;
  }
  const state = createHash("sha256")
    .update(`${config.appBaseUrl}:${config.github.appSlug}`)
    .digest("hex")
    .slice(0, 24);
  const url = new URL(`https://github.com/apps/${config.github.appSlug}/installations/new`);
  url.searchParams.set("state", state);
  return url.toString();
}

async function listGithubInstallations(
  prisma: PrismaClient | undefined,
  organizationId: string
): Promise<
  Array<{
    id: string;
    organizationId?: string | undefined;
    githubInstallationId: string;
    accountLogin: string;
    accountType: string;
    status: string;
    approvedBy?: string | undefined;
    approvedAt?: string | undefined;
    rejectedBy?: string | undefined;
    rejectedAt?: string | undefined;
    archivedAt?: string | undefined;
    lastWebhookAt: string;
    createdAt: string;
    updatedAt: string;
  }>
> {
  if (!prisma) {
    return [];
  }
  const rows = await prisma.gitHubInstallation.findMany({
    where: {
      organizationId
    },
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }]
  });
  return rows.map(githubInstallationForApi);
}

function githubInstallationForApi(row: GitHubInstallationRow) {
  return {
    id: row.id,
    ...(row.organizationId ? { organizationId: row.organizationId } : {}),
    githubInstallationId: row.githubInstallationId.toString(),
    accountLogin: row.accountLogin,
    accountType: row.accountType,
    status: row.status,
    ...(row.approvedBy ? { approvedBy: row.approvedBy } : {}),
    ...(row.approvedAt ? { approvedAt: row.approvedAt.toISOString() } : {}),
    ...(row.rejectedBy ? { rejectedBy: row.rejectedBy } : {}),
    ...(row.rejectedAt ? { rejectedAt: row.rejectedAt.toISOString() } : {}),
    ...(row.archivedAt ? { archivedAt: row.archivedAt.toISOString() } : {}),
    lastWebhookAt: row.lastWebhookAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function ownerMappingsFromRecords(records: ChangeControlRecord[]) {
  const reviewers = new Map<
    string,
    { reviewer: string; reviewerType: string; sources: string[] }
  >();
  for (const record of records) {
    for (const reviewer of record.requiredReviewers) {
      const existing = reviewers.get(reviewer.reviewer) ?? {
        reviewer: reviewer.reviewer,
        reviewerType: reviewer.reviewerType,
        sources: []
      };
      if (!existing.sources.includes(record.repositoryFullName)) {
        existing.sources.push(record.repositoryFullName);
      }
      reviewers.set(reviewer.reviewer, existing);
    }
  }
  return [...reviewers.values()].sort((a, b) => a.reviewer.localeCompare(b.reviewer));
}

function routingDiagnosticsFromOwnerMappings(
  ownerMappings: OwnerMappingState[],
  githubConnected: boolean
) {
  const teamMappings = ownerMappings.filter((mapping) => mapping.reviewerType === "team");
  const userMappings = ownerMappings.filter((mapping) => mapping.reviewerType === "user");
  return {
    codeownersPreviewSupported: true,
    ownerMappingsConfigured: ownerMappings.length,
    teamMappings: teamMappings.length,
    userMappings: userMappings.length,
    membersReadPermission: {
      status: githubConnected && teamMappings.length > 0 ? "required" : "not_required",
      detail:
        githubConnected && teamMappings.length > 0
          ? "GitHub App Members: read permission is required to verify team approvals. Missing access fails closed."
          : "Team approval verification becomes active after a GitHub installation and team mappings are configured."
    }
  };
}

function validReviewerForType(reviewer: string, reviewerType: "user" | "team"): boolean {
  const normalized = reviewer.trim().replace(/^@/u, "");
  if (reviewerType === "user") {
    return githubUserLogin(normalized);
  }
  if (normalized.includes("/")) {
    const [org, team, ...rest] = normalized.split("/");
    return rest.length === 0 && githubTeamSegment(org) && githubTeamSegment(team);
  }
  return githubTeamSegment(normalized);
}

function normalizeReviewerForStorage(reviewer: string, reviewerType: "user" | "team"): string {
  const normalized = reviewer.trim().replace(/^@/u, "");
  return reviewerType === "team" ? normalized.toLowerCase() : normalized;
}

function githubUserLogin(value: string | undefined): value is string {
  return Boolean(
    value && !value.includes("/") && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/u.test(value)
  );
}

function githubTeamSegment(value: string | undefined): value is string {
  return Boolean(value && /^[A-Za-z0-9][A-Za-z0-9-]*$/u.test(value));
}

function onboardingStepsFromRuntime(input: {
  repositories: Array<{ currentPolicyPack?: string | undefined }>;
  records: ChangeControlRecord[];
  githubConnected: boolean;
  ownerMappingsConfigured: boolean;
}) {
  const hasRepositories = input.repositories.length > 0;
  const hasPolicyPack = input.repositories.some((repository) => repository.currentPolicyPack);
  const hasPreviewRecords = input.records.length > 0;
  const retentionConfigured = true;
  const completed = (condition: boolean) => (condition ? "complete" : "pending");
  const active = (condition: boolean, previous: boolean) =>
    condition ? "complete" : previous ? "active" : "pending";

  return [
    {
      id: "connect_github_app",
      title: "Connect GitHub App",
      detail: "Install the GitHub App and verify webhook delivery.",
      status: active(input.githubConnected, true)
    },
    {
      id: "select_organization",
      title: "Select organization",
      detail: "Choose the GitHub organization to govern.",
      status: active(hasRepositories, input.githubConnected)
    },
    {
      id: "select_repositories",
      title: "Select repositories",
      detail: "Enable repositories that should publish Merge Guard checks.",
      status: active(hasRepositories, input.githubConnected)
    },
    {
      id: "choose_policy_pack",
      title: "Choose policy pack",
      detail: "Start from a policy pack, then fork it when repository-specific rules are needed.",
      status: active(hasPolicyPack, hasRepositories)
    },
    {
      id: "choose_mode",
      title: "Choose mode",
      detail: "Start in observe, move to warn, enforce mature rules, then optimize governance.",
      status: active(hasPolicyPack, hasRepositories)
    },
    {
      id: "map_owners",
      title: "Map owners",
      detail: "Assign security team, platform team, billing owner, and database owner.",
      status: active(input.ownerMappingsConfigured, hasPolicyPack)
    },
    {
      id: "configure_retention",
      title: "Configure retention",
      detail: "Keep metadata by default and leave full diff retention disabled unless required.",
      status: completed(retentionConfigured)
    },
    {
      id: "preview_policy",
      title: "Preview policy",
      detail: "Run recent PRs through the policy pack before changing required checks.",
      status: active(hasPreviewRecords, hasPolicyPack)
    },
    {
      id: "finish_setup",
      title: "Finish setup",
      detail: "Publish checks and start recording Change Control Records.",
      status: active(input.githubConnected && hasRepositories && hasPolicyPack, hasPreviewRecords)
    }
  ];
}

function repositoryReadinessScore(input: {
  repositories: Array<{ currentPolicyPack?: string | undefined; mode?: string | undefined }>;
  records: ChangeControlRecord[];
  githubConnected: boolean;
  ownerMappingsConfigured: boolean;
  branchProtectionConfirmed?: boolean | undefined;
}): {
  score: number;
  recommendation:
    | "stay_observe"
    | "move_to_warn"
    | "validate_reviewers"
    | "require_branch_check"
    | "move_to_enforce";
  checks: Array<{
    id: string;
    label: string;
    status: "passed" | "needs_action" | "unknown";
    weight: number;
    detail: string;
  }>;
} {
  const hasRepositories = input.repositories.length > 0;
  const hasPolicyPack = input.repositories.some((repository) => repository.currentPolicyPack);
  const hasSuccessfulRecord = input.records.some(
    (record) => record.checkStatus === "pass" || record.checkStatus === "warn"
  );
  const hasApprovedEvidence = input.records.some((record) =>
    record.requiredEvidence.some((item) => item.status === "approved")
  );
  const overrideRate = percent(
    input.records.filter((record) => record.lifecycle === "overridden").length,
    input.records.length
  );
  const lowOverrideRate = input.records.length >= 3 && overrideRate <= 20;
  const checks = [
    readinessCheck(
      "webhook_active",
      "GitHub App and webhook are connected",
      input.githubConnected,
      15,
      "Approve/link the GitHub installation and verify a signed webhook delivery."
    ),
    readinessCheck(
      "repository_selected",
      "At least one governed repository is selected",
      hasRepositories,
      15,
      "Enable a repository before evaluating mode escalation."
    ),
    readinessCheck(
      "policy_selected",
      "A policy pack is selected",
      hasPolicyPack,
      15,
      "Select a policy pack and keep mode changes as explicit admin actions."
    ),
    readinessCheck(
      "reviewer_routing",
      "Reviewer routing is configured",
      input.ownerMappingsConfigured,
      10,
      "Add owner mappings and verify team membership permissions when team reviewers are required."
    ),
    readinessCheck(
      "evidence_path",
      "Evidence approval path has been exercised",
      hasApprovedEvidence,
      10,
      "Approve at least one required evidence item before enforcing evidence gates."
    ),
    readinessCheck(
      "test_pr_evaluated",
      "A test pull request has produced a non-blocking result",
      hasSuccessfulRecord,
      15,
      "Run a representative pull request through observe or warn mode."
    ),
    readinessCheck(
      "low_override_rate",
      "Recent override rate is low",
      lowOverrideRate,
      10,
      "Review false positives until fewer than 20% of recent records need overrides."
    ),
    {
      id: "branch_protection",
      label: "Branch protection requires the Merge Guard check",
      status: input.branchProtectionConfirmed ? ("passed" as const) : ("unknown" as const),
      weight: 10,
      detail: input.branchProtectionConfirmed
        ? "Verified from a trusted branch protection source."
        : "Confirm branch protection in GitHub after smoke checks pass; AgentForge keeps this as an explicit admin action."
    }
  ];
  const passedWeight = checks
    .filter((check) => check.status === "passed")
    .reduce((sum, check) => sum + check.weight, 0);
  const totalWeight = checks.reduce((sum, check) => sum + check.weight, 0);
  const score = totalWeight === 0 ? 0 : Math.round((passedWeight / totalWeight) * 100);
  return {
    score,
    recommendation: readinessRecommendation(score, checks),
    checks
  };
}

function readinessCheck(
  id: string,
  label: string,
  passed: boolean,
  weight: number,
  actionDetail: string
): {
  id: string;
  label: string;
  status: "passed" | "needs_action";
  weight: number;
  detail: string;
} {
  return {
    id,
    label,
    status: passed ? "passed" : "needs_action",
    weight,
    detail: passed ? "Verified from current AgentForge records." : actionDetail
  };
}

function readinessRecommendation(
  score: number,
  checks: Array<{ id: string; status: "passed" | "needs_action" | "unknown" }>
):
  | "stay_observe"
  | "move_to_warn"
  | "validate_reviewers"
  | "require_branch_check"
  | "move_to_enforce" {
  if (score < 55) {
    return "stay_observe";
  }
  if (checks.some((check) => check.id === "reviewer_routing" && check.status !== "passed")) {
    return "validate_reviewers";
  }
  if (checks.some((check) => check.id === "branch_protection" && check.status !== "passed")) {
    return score >= 70 ? "require_branch_check" : "move_to_warn";
  }
  if (score >= 85) {
    return "move_to_enforce";
  }
  if (score >= 55) {
    return "move_to_warn";
  }
  return "stay_observe";
}

function dashboardSummary(records: ChangeControlRecord[]) {
  const evidence = records.flatMap((record) => record.requiredEvidence);
  const complete = evidence.filter((item) => item.status === "approved").length;
  const agentAssisted = records.filter((record) =>
    record.verifiedFindings.some((finding) => finding.type === "agent_signal_detected")
  ).length;
  return {
    blockedPrCount: records.filter((record) => record.checkStatus === "block").length,
    warningCount: records.filter((record) => record.checkStatus === "warn").length,
    overrideRate:
      records.length === 0
        ? 0
        : records.filter((record) => record.lifecycle === "overridden").length / records.length,
    evidenceCompletionRate: evidence.length === 0 ? 1 : complete / evidence.length,
    topPolicyViolations: Object.entries(
      groupBy(
        records.flatMap((record) => record.verifiedFindings),
        (finding) => finding.type
      )
    )
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
    agentAssistedChangeVolume: agentAssisted
  };
}

function recomputeRequirementStatus(
  record: ChangeControlRecord,
  now = new Date().toISOString()
): ChangeControlRecord {
  if (record.lifecycle === "overridden") {
    return { ...record, updatedAt: now };
  }

  const hasIncompleteEvidence = record.requiredEvidence.some((item) => item.status !== "approved");
  const hasPendingRequiredReview = record.requiredReviewers.some(
    (item) => item.tier === "required" && !item.approved
  );
  const wouldBlock = hasIncompleteEvidence || hasPendingRequiredReview;
  const checkStatus =
    record.mode === "observe"
      ? "pass"
      : record.mode === "warn" && wouldBlock
        ? "warn"
        : wouldBlock
          ? "block"
          : "pass";
  const lifecycle =
    checkStatus === "block" ? "blocked" : checkStatus === "warn" ? "warned" : "passed";

  return {
    ...record,
    checkStatus,
    lifecycle,
    decision: {
      ...record.decision,
      status: checkStatus === "block" ? "blocked" : "passed",
      decidedAt: now
    },
    updatedAt: now
  };
}
