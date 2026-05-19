import { createHash } from "node:crypto";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { loadConfig } from "@agentforge/config";
import type { ChangeControlRecord, PolicyResult, PullRequestInput } from "@agentforge/core";
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
import { sanitizeForMetadataStorage, type MetadataStoragePolicy } from "@agentforge/security";

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

let workerPrisma: PrismaClient | undefined;

export class RepositoryNotConfiguredError extends Error {
  constructor(repositoryFullName: string) {
    super(
      `Repository ${repositoryFullName} is not configured for Merge Guard evaluation. Configure a repository policy or provide an explicit policy for this job.`
    );
    this.name = "RepositoryNotConfiguredError";
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

export async function processMergeGuardEvaluationJob(
  data: MergeGuardEvaluationJobData
): Promise<MergeGuardEvaluationJobResult> {
  const config = loadConfig();
  const prisma = getWorkerPrisma(config);

  const githubContext = await resolvePullRequestForJob(data, config);
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
  const persistedRecord = prisma
    ? await ensureWorkerRecord({
        prisma,
        record,
        pr,
        envelope: data.envelope
      })
    : undefined;
  const checkRun = buildCheckRunPayload(pr, result);
  const published = await publishCheckIfConfigured({
    data,
    githubContext,
    result,
    pr,
    detailsUrl: persistedRecord
      ? recordDetailsUrl(config.appBaseUrl, persistedRecord.recordId)
      : undefined
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
  const published = await publishCheckIfConfigured({
    data: input.data,
    githubContext: input.githubContext,
    pr: input.pr,
    result
  });

  return {
    processedAt: new Date().toISOString(),
    recordId: `not_configured:${input.data.deliveryId}`,
    repositoryFullName: input.pr.repositoryFullName,
    pullRequestNumber: input.pr.pullRequestNumber,
    status: result.status,
    lifecycle: "evaluated",
    checkConclusion: checkRun.conclusion,
    checkPublished: published.published,
    publishedCheckRunId: published.id
  };
}

function notConfiguredPolicyResult(reason: string): PolicyResult {
  return {
    mode: "warn",
    status: "warn",
    policyVersion: "not_configured",
    policyPackId: "not_configured",
    policyPackVersion: "not_configured",
    findings: [],
    requiredEvidence: [],
    requiredReviewers: [],
    explanation: [
      reason,
      "Merge Guard skipped deterministic policy evaluation because no repository policy was selected."
    ],
    evaluatedAt: new Date().toISOString()
  };
}

function getWorkerPrisma(config: ReturnType<typeof loadConfig>): PrismaClient | undefined {
  if (!config.databaseUrl || config.nodeEnv === "test") {
    return undefined;
  }
  workerPrisma ??= new PrismaClient({ datasourceUrl: config.databaseUrl });
  return workerPrisma;
}

function startWorker(): void {
  const config = loadConfig();

  if (!config.redisUrl) {
    console.log("AgentForge worker started without REDIS_URL; queue processing is disabled.");
    return;
  }

  const connection = new Redis(config.redisUrl, {
    maxRetriesPerRequest: null
  });

  const worker = new Worker<MergeGuardEvaluationJobData>(
    "merge-guard-evaluations",
    async (job) => {
      console.log("Processing Merge Guard evaluation job", {
        jobId: job.id,
        name: job.name,
        deliveryId: job.data.deliveryId
      });
      return processMergeGuardEvaluationJob(job.data);
    },
    { connection }
  );

  worker.on("completed", (job, result) => {
    console.log("Merge Guard evaluation job completed", {
      jobId: job.id,
      recordId: result.recordId,
      status: result.status,
      checkConclusion: result.checkConclusion
    });
  });
  worker.on("failed", (job, error) => {
    console.error("Merge Guard evaluation job failed", {
      jobId: job?.id,
      deliveryId: job?.data.deliveryId,
      message: error.message
    });
  });
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
    pullNumber
  });

  return {
    pr,
    owner: envelope.repository.owner,
    repo: envelope.repository.name,
    githubClient: configuredClient.client,
    checkPublisherClient: configuredClient.checkPublisherClient
  };
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
      teamSlugs
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
}): Promise<{ published: boolean; id?: number | undefined }> {
  if (input.data.githubCheckPublisher) {
    const published = await input.data.githubCheckPublisher({
      owner: input.githubContext.owner,
      repo: input.githubContext.repo,
      pr: input.pr,
      result: input.result,
      detailsUrl: input.detailsUrl
    });
    return { published: true, id: published.id };
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
    return { published: true, id: published.id };
  }
  return { published: false };
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
    action: "check_published",
    targetType: "change_control_record",
    targetId: persistedRecord.recordId,
    metadataJson: {
      conclusion: checkConclusion,
      githubCheckRunId: publishedCheckRunId,
      status: record.checkStatus,
      mode: record.mode,
      policyVersion: record.policyVersion
    }
  });
  await prisma.auditEvent.upsert({
    where: { id: audit.id },
    update: {},
    create: {
      id: audit.id,
      organizationId: audit.organizationId,
      repositoryId: audit.repositoryId ?? null,
      pullRequestId: audit.pullRequestId ?? null,
      actor: audit.actor,
      action: audit.action,
      targetType: audit.targetType,
      targetId: audit.targetId,
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
  const evaluation = await input.prisma.evaluation.create({
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
    await input.prisma.verifiedFactRecord.createMany({
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
    await input.prisma.evidenceRequirementRecord.createMany({
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
    await input.prisma.reviewerRequirementRecord.createMany({
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
  await input.prisma.checkRun.create({
    data: {
      evaluationId: evaluation.id,
      githubCheckRunId: input.publishedCheckRunId ? BigInt(input.publishedCheckRunId) : null,
      conclusion: input.checkConclusion,
      outputTitle: "AgentForge Merge Guard",
      outputSummary: explainChangeControlRecord(input.record).join(" "),
      updatedAt: new Date(input.record.updatedAt)
    }
  });
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
