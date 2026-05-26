import { createHash } from "node:crypto";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { loadConfig } from "@agentforge/config";
import {
  MERGE_GUARD_EVALUATION_ATTEMPTS,
  MERGE_GUARD_EVALUATION_BACKOFF_MS,
  MERGE_GUARD_EVALUATION_QUEUE,
  RedisCacheManager,
  type ChangeControlRecord,
  type PolicyResult,
  type PullRequestInput,
  type VerifiedFact
} from "@agentforge/core";
import { PrismaClient } from "@agentforge/db";
import { detectorConfigFromPolicy, extractVerifiedFacts } from "@agentforge/detectors";
import {
  buildCheckRunPayload,
  createGithubClient,
  createGithubInstallationToken,
  enrichPullRequestReviewsWithTeamMemberships,
  fetchPullRequestInputFromGithub,
  publishMergeGuardCheckWithClient,
  type CheckRunPayload,
  type GithubAdapterClient,
  type GithubCheckPublisherClient,
  type GithubWebhookEnvelope
} from "@agentforge/github";
import {
  evaluateMergeGuard,
  getPolicyPack,
  parsePolicyYaml,
  type PolicyConfig
} from "@agentforge/policy";
import {
  createAuditEvent,
  createChangeControlRecord,
  explainChangeControlRecord
} from "@agentforge/records";
import {
  sanitizeForMetadataStorage,
  summarizeSafeSnippet,
  type MetadataStoragePolicy,
  generateAiDraftForEvidence
} from "@agentforge/security";

type CheckPublisher = (input: {
  owner: string;
  repo: string;
  pr: Pick<PullRequestInput, "headSha">;
  result: ReturnType<typeof evaluateMergeGuard>;
  detailsUrl?: string | undefined;
}) => Promise<{ id?: number | undefined; conclusion: CheckRunPayload["conclusion"] }>;

type PersistedWorkerRecordRefs = {
  organizationId: string;
  repositoryId: string;
  pullRequestId: string;
  recordId: string;
};

type CheckPublicationResult = {
  published: boolean;
  id?: number | undefined;
  conclusion?: CheckRunPayload["conclusion"] | undefined;
  reused?: boolean | undefined;
};

let workerPrisma: PrismaClient | undefined;

const WORKER_FAILURE_MESSAGE_LIMIT = 500;
const CHECK_PUBLICATION_CLAIM_TTL_MS = 5 * 60 * 1000;

export class RepositoryNotConfiguredError extends Error {
  constructor(repositoryFullName: string) {
    super(
      `Repository ${repositoryFullName} is not configured for Merge Guard evaluation. Configure a repository policy or provide an explicit policy for this job.`
    );
    this.name = "RepositoryNotConfiguredError";
  }
}

export class StaleCheckRunError extends Error {
  constructor(
    readonly repositoryFullName: string,
    readonly pullRequestNumber: number,
    readonly checkRunHeadSha: string,
    readonly currentHeadSha: string
  ) {
    super(
      `Ignoring stale check_run webhook for ${repositoryFullName}#${pullRequestNumber}: check_run head_sha ${checkRunHeadSha} does not match current pull request head_sha ${currentHeadSha}.`
    );
    this.name = "StaleCheckRunError";
  }
}

export type MergeGuardEvaluationJobData = {
  deliveryId: string;
  envelope?: GithubWebhookEnvelope | undefined;
  pr?: PullRequestInput | undefined;
  policyYaml?: string | undefined;
  githubClient?: GithubAdapterClient | undefined;
  githubCheckPublisher?: CheckPublisher | undefined;
};

export type MergeGuardEvaluationJobResult = {
  processedAt: string;
  recordId: string;
  repositoryFullName: string;
  pullRequestNumber: number;
  status: ChangeControlRecord["checkStatus"];
  lifecycle: ChangeControlRecord["lifecycle"];
  checkConclusion: ReturnType<typeof buildCheckRunPayload>["conclusion"];
  checkPublished: boolean;
  publishedCheckRunId?: number | undefined;
};

export type MergeGuardEvaluationFailureSummary = {
  errorClass: string;
  message: string;
  retryable: boolean;
  terminalFailure: boolean;
  attemptsMade: number;
  maxAttempts: number;
  failedAt: string;
  correlationId: string;
};

export async function processMergeGuardEvaluationJob(
  data: MergeGuardEvaluationJobData
): Promise<MergeGuardEvaluationJobResult> {
  const config = loadConfig();
  const prisma = getWorkerPrisma(config);

  let githubContext: Awaited<ReturnType<typeof resolvePullRequestForJob>>;
  try {
    githubContext = await resolvePullRequestForJob(data, config);
  } catch (error) {
    if (error instanceof StaleCheckRunError) {
      return staleCheckRunResult(data, error);
    }
    throw error;
  }
  let pr = githubContext.pr;
  let runtime: Awaited<ReturnType<typeof resolveRuntimeEvaluationContext>>;
  try {
    runtime = await resolveRuntimeEvaluationContext({
      prisma,
      pr,
      config,
      policyYaml: data.policyYaml
    });
  } catch (error) {
    if (error instanceof RepositoryNotConfiguredError) {
      return publishNotConfiguredEvaluation({
        prisma,
        data,
        githubContext,
        pr,
        reason: error.message
      });
    }
    throw error;
  }

  const parsed = parsePolicyYaml(runtime.policyYaml);
  if (parsed.errors.length > 0) {
    throw new Error(`Policy validation failed: ${parsed.errors.join("; ")}`);
  }

  const policy = applyRuntimePolicyAdjustments(parsed.config, {
    modeOverride: runtime.modeOverride,
    ownerMappings: runtime.ownerMappings
  });
  pr = await enrichReviewTeamMemberships({
    pr,
    owner: githubContext.owner,
    client: githubContext.githubClient,
    policy
  });
  const facts = extractVerifiedFacts(pr, detectorConfigFromPolicy(policy));
  const result = evaluateMergeGuard(pr, facts, policy);
  const record = applyEnvelopeLifecycle(
    sanitizeForMetadataStorage(
      createChangeControlRecord({
        organizationId: runtime.organizationId,
        repositoryId: runtime.repositoryId,
        pr,
        policyResult: result,
        storagePolicy: runtime.storagePolicy
      }),
      runtime.storagePolicy
    ),
    data.envelope
  );

  if (runtime.llmFeatures && record.requiredEvidence) {
    for (const requirement of record.requiredEvidence) {
      if (requirement.status === "missing") {
        const finding = (record.verifiedFindings.find(
          (f) => f.id === requirement.requiredByFindingId
        ) ||
          facts.find((f) => f.id === requirement.requiredByFindingId) || {
            id: requirement.requiredByFindingId,
            type: "sensitive_path_changed",
            source: "github_metadata",
            evidence: "unknown",
            confidence: "verified"
          }) as VerifiedFact;
        requirement.aiDraft = generateAiDraftForEvidence({
          kind: requirement.kind,
          finding,
          pr
        });
      }
    }
  }

  const persistedRecord = prisma
    ? await ensureWorkerRecord({
        prisma,
        record,
        pr,
        envelope: data.envelope
      })
    : undefined;
  const checkRun = buildCheckRunPayload(pr, result);
  const published = await publishCheckOnce({
    prisma,
    deliveryId: data.deliveryId,
    checkConclusion: checkRun.conclusion,
    publish: () =>
      publishCheckIfConfigured({
        data,
        githubContext,
        result,
        pr,
        detailsUrl: persistedRecord
          ? recordDetailsUrl(config.appBaseUrl, persistedRecord.recordId)
          : undefined
      })
  });

  if (prisma) {
    await persistWorkerRecord({
      prisma,
      record,
      pr,
      checkConclusion: checkRun.conclusion,
      publishedCheckRunId: published.id,
      envelope: data.envelope,
      persistedRecord
    });
  }

  return {
    processedAt: new Date().toISOString(),
    recordId: persistedRecord?.recordId ?? record.id,
    repositoryFullName: record.repositoryFullName,
    pullRequestNumber: record.pullRequestNumber,
    status: record.checkStatus,
    lifecycle: record.lifecycle,
    checkConclusion: checkRun.conclusion,
    checkPublished: published.published,
    publishedCheckRunId: published.id
  };
}

async function publishNotConfiguredEvaluation(input: {
  prisma: PrismaClient | undefined;
  data: MergeGuardEvaluationJobData;
  githubContext: {
    owner: string;
    repo: string;
    checkPublisherClient?: GithubCheckPublisherClient | undefined;
  };
  pr: PullRequestInput;
  reason: string;
}): Promise<MergeGuardEvaluationJobResult> {
  const result = notConfiguredPolicyResult(input.reason);
  const checkRun = buildCheckRunPayload(input.pr, result);
  const published = await publishCheckOnce({
    prisma: input.prisma,
    deliveryId: input.data.deliveryId,
    checkConclusion: checkRun.conclusion,
    publish: () =>
      publishCheckIfConfigured({
        data: input.data,
        githubContext: input.githubContext,
        pr: input.pr,
        result
      })
  });

  return {
    processedAt: new Date().toISOString(),
    recordId: `not_configured:${input.data.deliveryId}`,
    repositoryFullName: input.pr.repositoryFullName,
    pullRequestNumber: input.pr.pullRequestNumber,
    status: result.status,
    lifecycle: "blocked",
    checkConclusion: checkRun.conclusion,
    checkPublished: published.published,
    publishedCheckRunId: published.id
  };
}

function notConfiguredPolicyResult(reason: string): PolicyResult {
  return {
    mode: "enforce",
    status: "block",
    policyVersion: "not_configured",
    policyPackId: "not_configured",
    policyPackVersion: "not_configured",
    findings: [],
    requiredEvidence: [],
    requiredReviewers: [],
    explanation: [reason, "Merge Guard failed closed because no repository policy was selected."],
    evaluatedAt: new Date().toISOString()
  };
}

function staleCheckRunResult(
  data: MergeGuardEvaluationJobData,
  error: StaleCheckRunError
): MergeGuardEvaluationJobResult {
  return {
    processedAt: new Date().toISOString(),
    recordId: `stale_check_run:${data.deliveryId}`,
    repositoryFullName: error.repositoryFullName,
    pullRequestNumber: error.pullRequestNumber,
    status: "pass",
    lifecycle: "closed",
    checkConclusion: "neutral",
    checkPublished: false
  };
}

function getWorkerPrisma(config: ReturnType<typeof loadConfig>): PrismaClient | undefined {
  if (!config.databaseUrl || config.nodeEnv === "test") {
    return undefined;
  }
  workerPrisma ??= new PrismaClient({ datasourceUrl: config.databaseUrl });
  return workerPrisma;
}

let workerCache: RedisCacheManager | undefined;

function startWorker(): void {
  const config = loadConfig();

  if (!config.redisUrl) {
    console.log("AgentForge worker started without REDIS_URL; queue processing is disabled.");
    return;
  }

  workerCache = new RedisCacheManager(config.redisUrl);

  const connection = new Redis(config.redisUrl, {
    maxRetriesPerRequest: null
  });

  const worker = new Worker<MergeGuardEvaluationJobData>(
    MERGE_GUARD_EVALUATION_QUEUE,
    async (job) => {
      console.log("Processing Merge Guard evaluation job", {
        jobId: job.id,
        name: job.name,
        deliveryId: job.data.deliveryId
      });
      return processMergeGuardEvaluationJob(job.data);
    },
    {
      connection,
      settings: {
        backoffStrategy: (attemptsMade: number, type: string | undefined, err: any, job: any) => {
          if (type === "exponentialWithJitter") {
            const baseDelay = job.opts.backoff?.delay ?? MERGE_GUARD_EVALUATION_BACKOFF_MS;
            const delay = baseDelay * Math.pow(2, attemptsMade - 1);
            const min = delay * 0.5;
            const max = delay * 1.5;
            const jittered = Math.floor(min + Math.random() * (max - min));
            return Math.max(1000, jittered);
          }
          // Fallback delay calculation
          const baseDelay = job.opts.backoff?.delay ?? 30000;
          return baseDelay * Math.pow(2, attemptsMade - 1);
        }
      }
    }
  );

  worker.on("active", (job) => {
    if (workerPrisma && job.data.deliveryId) {
      void markWebhookDeliveryProcessing(workerPrisma, job.data.deliveryId).catch((error) => {
        const summary = classifyMergeGuardEvaluationFailure({
          error,
          deliveryId: job.data.deliveryId
        });
        console.error("Failed to persist Merge Guard evaluation processing state", {
          deliveryId: job.data.deliveryId,
          errorClass: summary.errorClass,
          message: summary.message
        });
      });
    }
  });
  worker.on("completed", (job, result) => {
    console.log("Merge Guard evaluation job completed", {
      jobId: job.id,
      recordId: result.recordId,
      status: result.status,
      checkConclusion: result.checkConclusion
    });
    if (workerPrisma && job.data.deliveryId) {
      void markWebhookDeliveryCompleted(workerPrisma, job.data.deliveryId).catch((error) => {
        const summary = classifyMergeGuardEvaluationFailure({
          error,
          deliveryId: job.data.deliveryId
        });
        console.error("Failed to persist Merge Guard evaluation completion state", {
          deliveryId: job.data.deliveryId,
          errorClass: summary.errorClass,
          message: summary.message
        });
      });
    }
  });
  worker.on("failed", (job, error) => {
    const summary = classifyMergeGuardEvaluationFailure({
      error,
      deliveryId: job?.data.deliveryId,
      attemptsMade: job?.attemptsMade ?? 0,
      maxAttempts: job?.opts.attempts ?? MERGE_GUARD_EVALUATION_ATTEMPTS
    });
    console.error("Merge Guard evaluation job failed", {
      jobId: job?.id,
      deliveryId: job?.data.deliveryId,
      errorClass: summary.errorClass,
      message: summary.message,
      retryable: summary.retryable,
      terminalFailure: summary.terminalFailure,
      attemptsMade: summary.attemptsMade,
      maxAttempts: summary.maxAttempts
    });
    if (workerPrisma && job?.data.deliveryId) {
      void recordMergeGuardEvaluationFailure({
        prisma: workerPrisma,
        deliveryId: job.data.deliveryId,
        summary
      }).catch((failureError) => {
        const failureSummary = classifyMergeGuardEvaluationFailure({
          error: failureError,
          deliveryId: job.data.deliveryId
        });
        console.error("Failed to persist Merge Guard evaluation failure summary", {
          deliveryId: job.data.deliveryId,
          errorClass: failureSummary.errorClass,
          message: failureSummary.message
        });
      });
    }
  });
}

export function classifyMergeGuardEvaluationFailure(input: {
  error: unknown;
  deliveryId?: string | undefined;
  attemptsMade?: number | undefined;
  maxAttempts?: number | undefined;
  failedAt?: string | undefined;
}): MergeGuardEvaluationFailureSummary {
  const errorClass = input.error instanceof Error ? input.error.name : "UnknownError";
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const attemptsMade = Math.max(0, input.attemptsMade ?? 0);
  const maxAttempts = Math.max(1, input.maxAttempts ?? MERGE_GUARD_EVALUATION_ATTEMPTS);
  const retryable = isRetryableEvaluationFailure(errorClass, message);
  return {
    errorClass: safeErrorClass(errorClass),
    message: safeErrorMessage(message),
    retryable,
    terminalFailure: !retryable || attemptsMade >= maxAttempts,
    attemptsMade,
    maxAttempts,
    failedAt: input.failedAt ?? new Date().toISOString(),
    correlationId: input.deliveryId ?? "unknown_delivery"
  };
}

export async function recordMergeGuardEvaluationFailure(input: {
  prisma: PrismaClient;
  deliveryId: string;
  summary: MergeGuardEvaluationFailureSummary;
}): Promise<void> {
  await input.prisma.webhookDelivery.updateMany({
    where: { deliveryId: input.deliveryId },
    data: {
      deliveryStatus: input.summary.terminalFailure ? "failed" : "processing",
      evaluationAttemptsMade: input.summary.attemptsMade,
      evaluationTerminalFailure: input.summary.terminalFailure,
      lastFailureClass: input.summary.errorClass,
      lastFailureMessage: input.summary.message,
      lastFailureCorrelationId: input.summary.correlationId,
      lastFailedAt: new Date(input.summary.failedAt)
    }
  });
}

async function markWebhookDeliveryProcessing(
  prisma: PrismaClient,
  deliveryId: string
): Promise<void> {
  await prisma.webhookDelivery.updateMany({
    where: { deliveryId },
    data: {
      deliveryStatus: "processing",
      processingStartedAt: new Date()
    }
  });
}

async function markWebhookDeliveryCompleted(
  prisma: PrismaClient,
  deliveryId: string
): Promise<void> {
  await prisma.webhookDelivery.updateMany({
    where: { deliveryId },
    data: {
      deliveryStatus: "completed",
      completedAt: new Date()
    }
  });
}

function isRetryableEvaluationFailure(errorClass: string, message: string): boolean {
  const combined = `${errorClass} ${message}`.toLowerCase();
  if (
    combined.includes("policy validation failed") ||
    combined.includes("requires a pull request payload") ||
    combined.includes("requires a pull request number") ||
    combined.includes("repositorynotconfigurederror") ||
    combined.includes("not configured for merge guard") ||
    combined.includes("credentials") ||
    combined.includes("installation credentials") ||
    combined.includes("authorization")
  ) {
    return false;
  }
  return true;
}

function safeErrorClass(value: string): string {
  const trimmed = value.trim();
  return /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(trimmed) ? trimmed : "Error";
}

function safeErrorMessage(value: string): string {
  return summarizeSafeSnippet(value, WORKER_FAILURE_MESSAGE_LIMIT);
}

async function resolvePullRequestForJob(
  data: MergeGuardEvaluationJobData,
  config: ReturnType<typeof loadConfig>
): Promise<{
  pr: PullRequestInput;
  owner: string;
  repo: string;
  githubClient?: GithubAdapterClient | undefined;
  checkPublisherClient?: GithubCheckPublisherClient | undefined;
}> {
  if (data.pr) {
    const [owner = "unknown", repo = data.pr.repositoryFullName] =
      data.pr.repositoryFullName.split("/");
    rejectStaleCheckRun(data.envelope, data.pr);
    return { pr: data.pr, owner, repo, githubClient: data.githubClient };
  }

  const envelope = data.envelope;
  if (!envelope?.repository) {
    throw new Error("Merge Guard evaluation job requires a pull request payload.");
  }
  const pullNumber = envelope.pullRequest?.number ?? envelope.checkRun?.pullRequests[0]?.number;
  if (!pullNumber) {
    throw new Error("Merge Guard evaluation job requires a pull request number.");
  }

  const configuredClient = await githubClientForEnvelope(data, config, envelope);
  if (!configuredClient) {
    throw new Error(
      "GitHub App credentials or an injected GitHub client are required to inspect pull request files."
    );
  }

  const pr = await fetchPullRequestInputFromGithub({
    client: configuredClient.client,
    owner: envelope.repository.owner,
    repo: envelope.repository.name,
    pullNumber,
    cache: workerCache
  });
  rejectStaleCheckRun(envelope, pr);

  return {
    pr,
    owner: envelope.repository.owner,
    repo: envelope.repository.name,
    githubClient: configuredClient.client,
    checkPublisherClient: configuredClient.checkPublisherClient
  };
}

function rejectStaleCheckRun(
  envelope: GithubWebhookEnvelope | undefined,
  pr: PullRequestInput
): void {
  if (envelope?.event !== "check_run" || !envelope.checkRun?.headSha) {
    return;
  }
  if (envelope.checkRun.headSha === pr.headSha) {
    return;
  }
  throw new StaleCheckRunError(
    pr.repositoryFullName,
    pr.pullRequestNumber,
    envelope.checkRun.headSha,
    pr.headSha
  );
}

async function githubClientForEnvelope(
  data: MergeGuardEvaluationJobData,
  config: ReturnType<typeof loadConfig>,
  envelope: GithubWebhookEnvelope
): Promise<
  | {
      client: GithubAdapterClient;
      checkPublisherClient?: GithubCheckPublisherClient | undefined;
    }
  | undefined
> {
  if (data.githubClient) {
    return { client: data.githubClient };
  }
  if (!config.github.appId || !config.github.privateKey || !envelope.installationId) {
    return undefined;
  }
  const token = await createGithubInstallationToken({
    appId: config.github.appId,
    privateKey: config.github.privateKey,
    installationId: envelope.installationId
  });
  const client = createGithubClient(token);
  return {
    client,
    checkPublisherClient: client
  };
}

export async function resolveRuntimeEvaluationContext(input: {
  prisma: PrismaClient | undefined;
  pr: PullRequestInput;
  config: ReturnType<typeof loadConfig>;
  policyYaml?: string | undefined;
}): Promise<{
  organizationId: string;
  repositoryId: string;
  policyYaml: string;
  modeOverride?: ChangeControlRecord["mode"] | undefined;
  storagePolicy: MetadataStoragePolicy;
  llmFeatures: boolean;
  ownerMappings: OwnerMappingRuntime[];
}> {
  if (!input.prisma) {
    const defaultPolicyYaml = getPolicyPack("fintech")?.contentYaml;
    if (!defaultPolicyYaml) {
      throw new Error("Merge Guard evaluation job could not resolve a policy.");
    }

    return {
      organizationId: "org_local",
      repositoryId: repositoryIdFromFullName(input.pr.repositoryFullName),
      policyYaml: input.policyYaml ?? defaultPolicyYaml,
      modeOverride: input.policyYaml ? undefined : input.config.defaultPolicyMode,
      storagePolicy: storagePolicyFromConfig(input.config),
      llmFeatures: input.config.llmFeatures,
      ownerMappings: []
    };
  }

  const repository = await input.prisma.repository.findFirst({
    where: { fullName: input.pr.repositoryFullName },
    include: {
      currentPolicyVersion: true,
      settings: true,
      ownerMappings: true
    }
  });
  if (repository && !repository.enabled) {
    throw new Error(`Repository ${repository.fullName} is disabled for Merge Guard evaluation.`);
  }
  if (!input.policyYaml && (!repository || !repository.currentPolicyVersion)) {
    throw new RepositoryNotConfiguredError(input.pr.repositoryFullName);
  }
  const resolvedPolicyYaml = input.policyYaml ?? repository?.currentPolicyVersion?.contentYaml;
  if (!resolvedPolicyYaml) {
    throw new RepositoryNotConfiguredError(input.pr.repositoryFullName);
  }

  return {
    organizationId: repository?.organizationId ?? "org_explicit_policy",
    repositoryId: repository?.id ?? repositoryIdFromFullName(input.pr.repositoryFullName),
    policyYaml: resolvedPolicyYaml,
    modeOverride: repository?.mode ?? undefined,
    storagePolicy: repository?.settings
      ? storagePolicyFromRepositorySetting(repository.settings)
      : storagePolicyFromConfig(input.config),
    llmFeatures: repository?.settings?.llmFeatures ?? input.config.llmFeatures,
    ownerMappings:
      repository?.ownerMappings.map((mapping: { ownerKey: string; reviewer: string }) => ({
        ownerKey: mapping.ownerKey,
        reviewer: mapping.reviewer
      })) ?? []
  };
}

type OwnerMappingRuntime = {
  ownerKey: string;
  reviewer: string;
};

function applyRuntimePolicyAdjustments(
  policy: PolicyConfig,
  input: {
    modeOverride?: ChangeControlRecord["mode"] | undefined;
    ownerMappings: OwnerMappingRuntime[];
  }
): PolicyConfig {
  const mapReviewers = reviewerMapper(input.ownerMappings);
  return {
    ...policy,
    agentforge: {
      ...policy.agentforge,
      mode: input.modeOverride ?? policy.agentforge.mode
    },
    sensitive_paths: Object.fromEntries(
      Object.entries(policy.sensitive_paths).map(([key, rule]) => [
        key,
        {
          ...rule,
          required_reviewers: mapReviewers(rule.required_reviewers)
        }
      ])
    ),
    tests: {
      deleted_tests: {
        ...policy.tests.deleted_tests,
        required_reviewers: mapReviewers(policy.tests.deleted_tests.required_reviewers)
      },
      skipped_tests: {
        ...policy.tests.skipped_tests,
        required_reviewers: mapReviewers(policy.tests.skipped_tests.required_reviewers)
      },
      coverage_threshold_reduced: {
        ...policy.tests.coverage_threshold_reduced,
        required_reviewers: mapReviewers(policy.tests.coverage_threshold_reduced.required_reviewers)
      },
      suspicious_test_change: {
        ...policy.tests.suspicious_test_change,
        required_reviewers: mapReviewers(policy.tests.suspicious_test_change.required_reviewers)
      }
    },
    dependencies: {
      new_package: {
        ...policy.dependencies.new_package,
        required_reviewers: mapReviewers(policy.dependencies.new_package.required_reviewers)
      },
      major_version_bump: {
        ...policy.dependencies.major_version_bump,
        required_reviewers: mapReviewers(policy.dependencies.major_version_bump.required_reviewers)
      }
    },
    database: {
      migrations: {
        ...policy.database.migrations,
        required_reviewers: mapReviewers(policy.database.migrations.required_reviewers)
      }
    }
  };
}

function reviewerMapper(ownerMappings: OwnerMappingRuntime[]): (reviewers: string[]) => string[] {
  const byOwnerKey = new Map(
    ownerMappings.map((mapping) => [normalizeOwnerKey(mapping.ownerKey), mapping.reviewer])
  );
  return (reviewers) => [
    ...new Set(reviewers.map((reviewer) => byOwnerKey.get(normalizeOwnerKey(reviewer)) ?? reviewer))
  ];
}

async function enrichReviewTeamMemberships(input: {
  pr: PullRequestInput;
  owner: string;
  client?: GithubAdapterClient | undefined;
  policy: PolicyConfig;
}): Promise<PullRequestInput> {
  const teamSlugs = requiredTeamReviewersFromPolicy(input.policy);
  if (!input.client || !input.pr.reviews?.length || teamSlugs.length === 0) {
    return input.pr;
  }
  return {
    ...input.pr,
    reviews: await enrichPullRequestReviewsWithTeamMemberships({
      client: input.client,
      org: input.owner,
      reviews: input.pr.reviews,
      teamSlugs,
      cache: workerCache
    })
  };
}

function requiredTeamReviewersFromPolicy(policy: PolicyConfig): string[] {
  const reviewers = [
    ...Object.values(policy.sensitive_paths).flatMap((rule) => rule.required_reviewers),
    ...policy.tests.deleted_tests.required_reviewers,
    ...policy.tests.skipped_tests.required_reviewers,
    ...policy.tests.coverage_threshold_reduced.required_reviewers,
    ...policy.tests.suspicious_test_change.required_reviewers,
    ...policy.dependencies.new_package.required_reviewers,
    ...policy.dependencies.major_version_bump.required_reviewers,
    ...policy.database.migrations.required_reviewers
  ];
  return [...new Set(reviewers.filter(isTeamReviewer))];
}

function isTeamReviewer(reviewer: string): boolean {
  const normalized = reviewer.trim().replace(/^@/u, "");
  return normalized.includes("/") || normalized.includes("-team") || normalized.includes("-owner");
}

function normalizeOwnerKey(value: string): string {
  return value
    .trim()
    .replace(/^@/u, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

function storagePolicyFromConfig(config: ReturnType<typeof loadConfig>): MetadataStoragePolicy {
  return {
    sourceCodeStorage: config.sourceCodeStorage,
    fullDiffRetention: config.fullDiffRetention,
    redactSecrets: config.redactSecrets
  };
}

function storagePolicyFromRepositorySetting(row: {
  sourceCodeStorage: boolean;
  fullDiffRetention: string;
  redactSecrets: boolean;
}): MetadataStoragePolicy {
  return {
    sourceCodeStorage: row.sourceCodeStorage,
    fullDiffRetention:
      row.fullDiffRetention === "7d" ||
      row.fullDiffRetention === "30d" ||
      row.fullDiffRetention === "custom"
        ? row.fullDiffRetention
        : "disabled",
    redactSecrets: row.redactSecrets
  };
}

async function publishCheckIfConfigured(input: {
  data: MergeGuardEvaluationJobData;
  githubContext: {
    owner: string;
    repo: string;
    checkPublisherClient?: GithubCheckPublisherClient | undefined;
  };
  pr: PullRequestInput;
  result: PolicyResult;
  detailsUrl?: string | undefined;
}): Promise<CheckPublicationResult> {
  if (input.data.githubCheckPublisher) {
    const published = await input.data.githubCheckPublisher({
      owner: input.githubContext.owner,
      repo: input.githubContext.repo,
      pr: input.pr,
      result: input.result,
      detailsUrl: input.detailsUrl
    });
    return { published: true, id: published.id, conclusion: published.conclusion };
  }
  if (input.githubContext.checkPublisherClient) {
    const published = await publishMergeGuardCheckWithClient({
      client: input.githubContext.checkPublisherClient,
      owner: input.githubContext.owner,
      repo: input.githubContext.repo,
      pr: input.pr,
      result: input.result,
      detailsUrl: input.detailsUrl
    });
    return { published: true, id: published.id, conclusion: published.conclusion };
  }
  return { published: false };
}

async function publishCheckOnce(input: {
  prisma: PrismaClient | undefined;
  deliveryId: string;
  checkConclusion: CheckRunPayload["conclusion"];
  publish: () => Promise<CheckPublicationResult>;
}): Promise<CheckPublicationResult> {
  const previous = input.prisma
    ? await input.prisma.webhookDelivery.findUnique({
        where: { deliveryId: input.deliveryId },
        select: {
          publishedCheckRunId: true,
          checkConclusion: true,
          checkPublishedAt: true
        }
      })
    : undefined;
  if (previous?.checkPublishedAt && previous.publishedCheckRunId) {
    return {
      published: true,
      id: Number(previous.publishedCheckRunId),
      conclusion: checkConclusionFromStoredValue(previous.checkConclusion) ?? input.checkConclusion,
      reused: true
    };
  }
  if (
    previous?.checkPublishedAt &&
    Date.now() - previous.checkPublishedAt.getTime() < CHECK_PUBLICATION_CLAIM_TTL_MS
  ) {
    return {
      published: false,
      conclusion: checkConclusionFromStoredValue(previous.checkConclusion) ?? input.checkConclusion,
      reused: true
    };
  }

  if (!input.prisma) {
    const published = await input.publish();
    return {
      ...published,
      conclusion: published.conclusion ?? input.checkConclusion,
      reused: false
    };
  }

  const claimTime = new Date();
  const claimWhere = previous?.checkPublishedAt
    ? {
        deliveryId: input.deliveryId,
        checkPublishedAt: previous.checkPublishedAt,
        publishedCheckRunId: null
      }
    : { deliveryId: input.deliveryId, checkPublishedAt: null };
  const claim = await input.prisma.webhookDelivery.updateMany({
    where: claimWhere,
    data: {
      checkConclusion: input.checkConclusion,
      checkPublishedAt: claimTime
    }
  });
  if (claim.count === 0) {
    const stored = await input.prisma.webhookDelivery.findUnique({
      where: { deliveryId: input.deliveryId },
      select: {
        publishedCheckRunId: true,
        checkConclusion: true,
        checkPublishedAt: true
      }
    });
    if (!stored) {
      const published = await input.publish();
      return {
        ...published,
        conclusion: published.conclusion ?? input.checkConclusion,
        reused: false
      };
    }
    return {
      published: Boolean(stored?.publishedCheckRunId),
      id: stored?.publishedCheckRunId ? Number(stored.publishedCheckRunId) : undefined,
      conclusion: checkConclusionFromStoredValue(stored?.checkConclusion) ?? input.checkConclusion,
      reused: true
    };
  }

  try {
    const published = await input.publish();
    if (!published.published) {
      await input.prisma.webhookDelivery.updateMany({
        where: { deliveryId: input.deliveryId, checkPublishedAt: claimTime },
        data: {
          checkPublishedAt: null,
          checkConclusion: published.conclusion ?? input.checkConclusion
        }
      });
      return {
        ...published,
        conclusion: published.conclusion ?? input.checkConclusion,
        reused: false
      };
    }
    await input.prisma.webhookDelivery.updateMany({
      where: { deliveryId: input.deliveryId, checkPublishedAt: claimTime },
      data: {
        publishedCheckRunId: published.id ? BigInt(published.id) : null,
        checkConclusion: published.conclusion ?? input.checkConclusion,
        checkPublishedAt: new Date()
      }
    });
    return {
      ...published,
      conclusion: published.conclusion ?? input.checkConclusion,
      reused: false
    };
  } catch (error) {
    await input.prisma.webhookDelivery.updateMany({
      where: { deliveryId: input.deliveryId, checkPublishedAt: claimTime },
      data: {
        checkPublishedAt: null,
        checkConclusion: input.checkConclusion
      }
    });
    throw error;
  }
}

function checkConclusionFromStoredValue(
  value: string | null | undefined
): CheckRunPayload["conclusion"] | undefined {
  return value === "success" || value === "failure" || value === "neutral" ? value : undefined;
}

function recordDetailsUrl(appBaseUrl: string, recordId: string): string {
  return new URL(`/records/${encodeURIComponent(recordId)}`, appBaseUrl).toString();
}

function applyEnvelopeLifecycle(
  record: ChangeControlRecord,
  envelope: GithubWebhookEnvelope | undefined
): ChangeControlRecord {
  if (envelope?.event !== "pull_request" || envelope.action !== "closed" || !envelope.pullRequest) {
    return record;
  }
  const now = envelope.receivedAt;
  if (envelope.pullRequest.merged) {
    return {
      ...record,
      lifecycle: "merged",
      decision: {
        ...record.decision,
        status: "merged",
        decidedAt: now,
        decidedBy: "github"
      },
      updatedAt: now
    };
  }
  return {
    ...record,
    lifecycle: "closed",
    decision: {
      ...record.decision,
      status: "closed_without_merge",
      decidedAt: now,
      decidedBy: "github"
    },
    updatedAt: now
  };
}

async function persistWorkerRecord(input: {
  prisma: PrismaClient;
  record: ChangeControlRecord;
  pr: PullRequestInput;
  checkConclusion: string;
  publishedCheckRunId?: number | undefined;
  envelope?: GithubWebhookEnvelope | undefined;
  persistedRecord?: PersistedWorkerRecordRefs | undefined;
}): Promise<void> {
  const { prisma, record, pr, checkConclusion, publishedCheckRunId, envelope } = input;
  const persistedRecord =
    input.persistedRecord ??
    (await ensureWorkerRecord({
      prisma,
      record,
      pr,
      envelope
    }));
  await persistWorkerEvaluationSnapshot({
    prisma,
    organizationId: persistedRecord.organizationId,
    repositoryId: persistedRecord.repositoryId,
    pullRequestId: persistedRecord.pullRequestId,
    record,
    checkConclusion,
    publishedCheckRunId
  });

  const audit = createAuditEvent({
    organizationId: persistedRecord.organizationId,
    repositoryId: persistedRecord.repositoryId,
    pullRequestId: persistedRecord.pullRequestId,
    actor: "system",
    actorRole: "system",
    action: "check_published",
    targetType: "change_control_record",
    targetId: persistedRecord.recordId,
    source: "worker",
    correlationId: envelope?.deliveryId,
    policyVersion: record.policyVersion,
    policyPackId: record.policyPackId,
    policyPackVersion: record.policyPackVersion,
    metadataJson: {
      conclusion: checkConclusion,
      githubCheckRunId: publishedCheckRunId,
      status: record.checkStatus,
      mode: record.mode,
      policyVersion: record.policyVersion,
      policyPackId: record.policyPackId,
      policyPackVersion: record.policyPackVersion,
      headSha: record.headSha,
      deliveryId: envelope?.deliveryId
    }
  });
  const auditId = workerAuditEventId({
    deliveryId: envelope?.deliveryId,
    recordId: persistedRecord.recordId,
    headSha: record.headSha,
    policyVersion: record.policyVersion,
    policyPackId: record.policyPackId
  });
  await prisma.auditEvent.upsert({
    where: { id: auditId },
    update: {},
    create: {
      id: auditId,
      organizationId: audit.organizationId,
      repositoryId: audit.repositoryId ?? null,
      pullRequestId: audit.pullRequestId ?? null,
      schemaVersion: audit.schemaVersion,
      actor: audit.actor,
      actorRole: audit.actorRole,
      action: audit.action,
      targetType: audit.targetType,
      targetId: audit.targetId,
      source: audit.source,
      requestId: audit.requestId ?? null,
      correlationId: audit.correlationId ?? null,
      policyVersion: audit.policyVersion ?? null,
      policyPackId: audit.policyPackId ?? null,
      policyPackVersion: audit.policyPackVersion ?? null,
      metadataJson: audit.metadataJson as never,
      createdAt: new Date(audit.createdAt)
    }
  });
}

async function ensureWorkerRecord(input: {
  prisma: PrismaClient;
  record: ChangeControlRecord;
  pr: PullRequestInput;
  envelope?: GithubWebhookEnvelope | undefined;
}): Promise<PersistedWorkerRecordRefs> {
  const { prisma, record, pr, envelope } = input;
  const organization = await prisma.organization.upsert({
    where: { id: record.organizationId },
    update: {},
    create: {
      id: record.organizationId,
      name: "Local Development",
      slug: record.organizationId
    }
  });
  const [owner = "unknown", name = pr.repositoryFullName] = pr.repositoryFullName.split("/");
  const repository = await prisma.repository.upsert({
    where: {
      organizationId_fullName: {
        organizationId: organization.id,
        fullName: pr.repositoryFullName
      }
    },
    update: {
      defaultBranch: pr.baseBranch,
      enabled: true
    },
    create: {
      id: record.repositoryId,
      organizationId: organization.id,
      githubRepositoryId: stableBigInt(pr.repositoryFullName),
      fullName: pr.repositoryFullName,
      owner,
      name,
      defaultBranch: pr.baseBranch,
      protected: false,
      enabled: true
    }
  });
  const pullRequest = await prisma.pullRequest.upsert({
    where: {
      repositoryId_number: {
        repositoryId: repository.id,
        number: pr.pullRequestNumber
      }
    },
    update: {
      title: pr.title,
      authorLogin: pr.authorLogin,
      baseBranch: pr.baseBranch,
      headBranch: pr.headBranch,
      headSha: pr.headSha,
      state: pullRequestState(envelope),
      closedAt: closedAt(envelope) ?? null,
      mergedAt: mergedAt(envelope) ?? null
    },
    create: {
      id: `pr_${record.id}`,
      repositoryId: repository.id,
      githubPullRequestId: stableBigInt(`${pr.repositoryFullName}#${pr.pullRequestNumber}`),
      number: pr.pullRequestNumber,
      title: pr.title,
      authorLogin: pr.authorLogin,
      baseBranch: pr.baseBranch,
      headBranch: pr.headBranch,
      headSha: pr.headSha,
      state: pullRequestState(envelope),
      closedAt: closedAt(envelope) ?? null,
      mergedAt: mergedAt(envelope) ?? null
    }
  });

  const persistedRecord = await prisma.changeControlRecord.upsert({
    where: { pullRequestId: pullRequest.id },
    update: {
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
    },
    create: {
      id: record.id,
      pullRequestId: pullRequest.id,
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
    }
  });
  return {
    organizationId: organization.id,
    repositoryId: repository.id,
    pullRequestId: pullRequest.id,
    recordId: persistedRecord.id
  };
}

async function persistWorkerEvaluationSnapshot(input: {
  prisma: PrismaClient;
  organizationId: string;
  repositoryId: string;
  pullRequestId: string;
  record: ChangeControlRecord;
  checkConclusion: string;
  publishedCheckRunId?: number | undefined;
}): Promise<void> {
  const policyVersion = await ensureWorkerPolicyVersionSnapshot(input);
  const evaluationId = workerEvaluationId({
    pullRequestId: input.pullRequestId,
    headSha: input.record.headSha,
    policyVersionId: policyVersion.id,
    policyVersion: input.record.policyVersion,
    policyPackId: input.record.policyPackId
  });
  const evaluationData = {
    pullRequestId: input.pullRequestId,
    policyVersionId: policyVersion.id,
    mode: input.record.mode,
    status: input.record.checkStatus,
    headSha: input.record.headSha,
    completedAt: new Date(input.record.updatedAt),
    explanationJson: explainChangeControlRecord(input.record) as never
  };
  await input.prisma.$transaction(async (tx) => {
    await tx.evaluation.upsert({
      where: { id: evaluationId },
      update: evaluationData,
      create: {
        id: evaluationId,
        ...evaluationData
      }
    });
    await Promise.all([
      tx.verifiedFactRecord.deleteMany({ where: { evaluationId } }),
      tx.evidenceRequirementRecord.deleteMany({ where: { evaluationId } }),
      tx.reviewerRequirementRecord.deleteMany({ where: { evaluationId } })
    ]);
    if (input.record.verifiedFindings.length > 0) {
      await tx.verifiedFactRecord.createMany({
        data: input.record.verifiedFindings.map((fact) => ({
          evaluationId,
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
      await tx.evidenceRequirementRecord.createMany({
        data: input.record.requiredEvidence.map((evidence) => ({
          evaluationId,
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
      await tx.reviewerRequirementRecord.createMany({
        data: input.record.requiredReviewers.map((reviewer) => ({
          evaluationId,
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
    const checkRunData = {
      evaluationId,
      githubCheckRunId: input.publishedCheckRunId ? BigInt(input.publishedCheckRunId) : null,
      conclusion: input.checkConclusion,
      outputTitle: "AgentForge Merge Guard",
      outputSummary: explainChangeControlRecord(input.record).join(" "),
      updatedAt: new Date(input.record.updatedAt)
    };
    await tx.checkRun.upsert({
      where: { evaluationId },
      update: checkRunData,
      create: checkRunData
    });
  });
}

function workerEvaluationId(input: {
  pullRequestId: string;
  headSha: string;
  policyVersionId: string;
  policyVersion: string;
  policyPackId?: string | null | undefined;
}): string {
  return `eval_${createHash("sha256")
    .update(
      [
        input.pullRequestId,
        input.headSha,
        input.policyVersionId,
        input.policyVersion,
        input.policyPackId ?? ""
      ].join(":")
    )
    .digest("hex")
    .slice(0, 32)}`;
}

function workerAuditEventId(input: {
  deliveryId?: string | undefined;
  recordId: string;
  headSha: string;
  policyVersion: string;
  policyPackId?: string | null | undefined;
}): string {
  return `audit_${createHash("sha256")
    .update(
      [
        input.deliveryId ?? "manual",
        input.recordId,
        input.headSha,
        input.policyVersion,
        input.policyPackId ?? ""
      ].join(":")
    )
    .digest("hex")
    .slice(0, 32)}`;
}

async function ensureWorkerPolicyVersionSnapshot(input: {
  prisma: PrismaClient;
  organizationId: string;
  repositoryId: string;
  record: ChangeControlRecord;
}) {
  const existing = await input.prisma.policyVersion.findFirst({
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
    ? await input.prisma.policyPack.findUnique({ where: { id: input.record.policyPackId } })
    : null;
  return input.prisma.policyVersion.create({
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

function pullRequestState(envelope: GithubWebhookEnvelope | undefined): string {
  if (envelope?.event === "pull_request" && envelope.action === "closed") {
    return envelope.pullRequest?.merged ? "merged" : "closed";
  }
  return envelope?.pullRequest?.state ?? "open";
}

function closedAt(envelope: GithubWebhookEnvelope | undefined): Date | undefined {
  return envelope?.event === "pull_request" && envelope.action === "closed"
    ? new Date(envelope.receivedAt)
    : undefined;
}

function mergedAt(envelope: GithubWebhookEnvelope | undefined): Date | undefined {
  return envelope?.event === "pull_request" &&
    envelope.action === "closed" &&
    envelope.pullRequest?.merged
    ? new Date(envelope.receivedAt)
    : undefined;
}

function repositoryIdFromFullName(fullName: string): string {
  return `repo_${createHash("sha256").update(fullName).digest("hex").slice(0, 12)}`;
}

function stableBigInt(value: string): bigint {
  return BigInt(`0x${createHash("sha256").update(value).digest("hex").slice(0, 15)}`);
}

if (process.env.NODE_ENV !== "test" && process.env.AGENTFORGE_WORKER_AUTOSTART !== "false") {
  startWorker();
}
