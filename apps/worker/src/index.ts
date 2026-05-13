import { createHash } from "node:crypto";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { loadConfig } from "@agentforge/config";
import type { ChangeControlRecord, PullRequestInput } from "@agentforge/core";
import { PrismaClient } from "@agentforge/db";
import { detectorConfigFromPolicy, extractVerifiedFacts } from "@agentforge/detectors";
import { buildCheckRunPayload, type GithubWebhookEnvelope } from "@agentforge/github";
import { evaluateMergeGuard, getPolicyPack, parsePolicyYaml } from "@agentforge/policy";
import { createAuditEvent, createChangeControlRecord } from "@agentforge/records";
import { sanitizeForMetadataStorage, type MetadataStoragePolicy } from "@agentforge/security";

export type MergeGuardEvaluationJobData = {
  deliveryId: string;
  envelope?: GithubWebhookEnvelope | undefined;
  pr?: PullRequestInput | undefined;
  policyYaml?: string | undefined;
};

export type MergeGuardEvaluationJobResult = {
  processedAt: string;
  recordId: string;
  repositoryFullName: string;
  pullRequestNumber: number;
  status: ChangeControlRecord["checkStatus"];
  checkConclusion: ReturnType<typeof buildCheckRunPayload>["conclusion"];
};

export async function processMergeGuardEvaluationJob(
  data: MergeGuardEvaluationJobData
): Promise<MergeGuardEvaluationJobResult> {
  const config = loadConfig();
  const storagePolicy: MetadataStoragePolicy = {
    sourceCodeStorage: config.sourceCodeStorage,
    fullDiffRetention: config.fullDiffRetention,
    redactSecrets: config.redactSecrets
  };
  const pr = data.pr ?? pullRequestInputFromEnvelope(data.envelope);
  if (!pr) {
    throw new Error("Merge Guard evaluation job requires a pull request payload.");
  }

  const policyYaml = data.policyYaml ?? getPolicyPack("fintech")?.contentYaml;
  if (!policyYaml) {
    throw new Error("Merge Guard evaluation job could not resolve a policy.");
  }

  const parsed = parsePolicyYaml(policyYaml);
  if (parsed.errors.length > 0) {
    throw new Error(`Policy validation failed: ${parsed.errors.join("; ")}`);
  }

  const facts = extractVerifiedFacts(pr, detectorConfigFromPolicy(parsed.config));
  const result = evaluateMergeGuard(pr, facts, parsed.config);
  const record = sanitizeForMetadataStorage(
    createChangeControlRecord({
      organizationId: "org_local",
      repositoryId: repositoryIdFromFullName(pr.repositoryFullName),
      pr,
      policyResult: result,
      storagePolicy
    }),
    storagePolicy
  );
  const checkRun = buildCheckRunPayload(pr, result);

  if (config.databaseUrl && config.nodeEnv !== "test") {
    process.env.DATABASE_URL = config.databaseUrl;
    const prisma = new PrismaClient();
    try {
      await persistWorkerRecord(prisma, record, pr, checkRun.conclusion);
    } finally {
      await prisma.$disconnect();
    }
  }

  return {
    processedAt: new Date().toISOString(),
    recordId: record.id,
    repositoryFullName: record.repositoryFullName,
    pullRequestNumber: record.pullRequestNumber,
    status: record.checkStatus,
    checkConclusion: checkRun.conclusion
  };
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

function pullRequestInputFromEnvelope(
  envelope: GithubWebhookEnvelope | undefined
): PullRequestInput | undefined {
  if (!envelope?.repository || !envelope.pullRequest) {
    return undefined;
  }
  return {
    repositoryFullName: envelope.repository.fullName,
    pullRequestNumber: envelope.pullRequest.number,
    title: envelope.pullRequest.title,
    authorLogin: envelope.pullRequest.authorLogin,
    baseBranch: envelope.pullRequest.baseBranch,
    headBranch: envelope.pullRequest.headBranch,
    headSha: envelope.pullRequest.headSha,
    body: envelope.pullRequest.body,
    reviews: envelope.review ? [envelope.review] : undefined,
    changedFiles: []
  };
}

async function persistWorkerRecord(
  prisma: PrismaClient,
  record: ChangeControlRecord,
  pr: PullRequestInput,
  checkConclusion: string
): Promise<void> {
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
      state: "open"
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
      state: "open"
    }
  });

  await prisma.changeControlRecord.upsert({
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

  const audit = createAuditEvent({
    organizationId: organization.id,
    repositoryId: repository.id,
    pullRequestId: pullRequest.id,
    actor: "system",
    action: "check_published",
    targetType: "change_control_record",
    targetId: record.id,
    metadataJson: {
      conclusion: checkConclusion,
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

function repositoryIdFromFullName(fullName: string): string {
  return `repo_${createHash("sha256").update(fullName).digest("hex").slice(0, 12)}`;
}

function stableBigInt(value: string): bigint {
  return BigInt(`0x${createHash("sha256").update(value).digest("hex").slice(0, 15)}`);
}

if (process.env.NODE_ENV !== "test" && process.env.AGENTFORGE_WORKER_AUTOSTART !== "false") {
  startWorker();
}
