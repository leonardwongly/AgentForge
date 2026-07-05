import { createHash } from "node:crypto";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { loadConfig } from "@agentforge/config";
import {
  AUDIT_RECORD_RETENTION_SWEEP_CRON,
  AUDIT_RECORD_RETENTION_SWEEP_JOB_NAME,
  AUDIT_RECORD_RETENTION_SWEEP_QUEUE,
  MERGE_GUARD_EVALUATION_ATTEMPTS,
  MERGE_GUARD_EVALUATION_BACKOFF_MS,
  MERGE_GUARD_EVALUATION_QUEUE,
  RedisCacheManager,
  type ChangeControlRecord,
  type PolicyResult,
  type PullRequestInput,
  type VerifiedFact
} from "@agentforge/core";
import {
  assertOrgIsolationEnforced,
  createPrismaClient,
  runWithOrgContext,
  withUnmanagedOrgBinding,
  type PrismaClient
} from "@agentforge/db";
import { detectorConfigFromPolicy, extractVerifiedFacts } from "@agentforge/detectors";
import {
  buildCheckRunPayload,
  createGithubClient,
  createGithubInstallationToken,
  enrichPullRequestReviewsWithTeamMemberships,
  fetchPullRequestInputFromGithub,
  githubRetryAfterMs,
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
  explainChangeControlRecord,
  planAuditRecordRetentionSweep,
  planExportJobRetentionSweep,
  planUnassignedRetentionSweep,
  planWebhookDeliveryRetentionSweep,
  summarizeAuditRecordRetentionSweep,
  summarizeUnassignedRetentionSweep,
  type AuditRecordRetentionSweepResult,
  type UnassignedRetentionSweepResult
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
type PrismaTransactionClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

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

export class SupersededHeadShaError extends Error {
  constructor(
    readonly repositoryFullName: string,
    readonly pullRequestNumber: number,
    readonly evaluatedHeadSha: string,
    readonly currentHeadSha: string
  ) {
    super(
      `Skipping check-run publish for ${repositoryFullName}#${pullRequestNumber}: evaluation ran for head_sha ${evaluatedHeadSha} but the pull request has since advanced to ${currentHeadSha}.`
    );
    this.name = "SupersededHeadShaError";
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
    ? await runWithOrgContext(runtime.organizationId, () =>
        ensureWorkerRecord({
          prisma,
          record,
          pr,
          envelope: data.envelope
        })
      )
    : undefined;
  const checkRun = buildCheckRunPayload(pr, result);

  try {
    await rejectSupersededHeadSha({
      envelope: data.envelope,
      pr,
      owner: githubContext.owner,
      repo: githubContext.repo,
      client: githubContext.githubClient
    });
  } catch (error) {
    if (error instanceof SupersededHeadShaError) {
      return supersededHeadShaResult(error, persistedRecord?.recordId ?? record.id);
    }
    throw error;
  }

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
    await runWithOrgContext(runtime.organizationId, () =>
      persistWorkerRecord({
        prisma,
        record,
        pr,
        checkConclusion: checkRun.conclusion,
        publishedCheckRunId: published.id,
        envelope: data.envelope,
        persistedRecord
      })
    );
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

function terminalFailurePolicyResult(input: {
  attemptsMade: number;
  maxAttempts: number;
}): PolicyResult {
  return {
    mode: "enforce",
    status: "block",
    policyVersion: "evaluation_failed",
    policyPackId: "evaluation_failed",
    policyPackVersion: "evaluation_failed",
    findings: [],
    requiredEvidence: [],
    requiredReviewers: [],
    explanation: [
      `Merge Guard could not evaluate this pull request after ${input.attemptsMade} of ${input.maxAttempts} attempt(s); contact an administrator.`,
      "Merge Guard failed closed because the evaluation job did not complete successfully."
    ],
    evaluatedAt: new Date().toISOString()
  };
}

/**
 * Best-effort fail-closed check-run publication for a Merge Guard evaluation
 * job that has exhausted retries (`classifyMergeGuardEvaluationFailure`'s
 * `terminalFailure: true`), mirroring `publishNotConfiguredEvaluation`'s
 * existing "no policy selected" fail-closed pattern: without this, a PR whose
 * evaluation job fails every attempt is left with NO Merge Guard check-run at
 * all (see the task report for the investigation confirming this), which is
 * silently indistinguishable from Merge Guard never having run, and defeats a
 * required-status-check branch protection rule that depends on this check
 * ever completing.
 *
 * Deliberately best-effort and swallows its own errors: this runs from inside
 * the BullMQ `worker.on("failed", ...)` handler, which itself has no retry and
 * must never throw or return a rejected promise (an unhandled rejection here
 * would crash the worker process instead of just leaving the operator-visible
 * signal unset). If GitHub is unreachable or job.data lacks enough context to
 * resolve a client (e.g. a directly-injected job with no `pr`/`envelope`,
 * or a failure that occurred before `resolvePullRequestForJob` had anything to
 * return), this logs and returns without publishing rather than throwing.
 */
export async function publishTerminalFailureCheckRun(input: {
  job: {
    data: MergeGuardEvaluationJobData;
  };
  config: ReturnType<typeof loadConfig>;
  summary: MergeGuardEvaluationFailureSummary;
}): Promise<void> {
  try {
    const pr = input.job.data.pr;
    if (!pr) {
      // No pull request payload survives onto a directly-queued job with only
      // an `envelope` until `resolvePullRequestForJob` fetches it from GitHub --
      // exactly the call that may be what failed. There is nothing to publish a
      // check-run against without at least a headSha/repositoryFullName, so this
      // fails open on publication (the terminal-failure webhookDelivery record
      // and console.error above still capture the failure either way).
      console.error(
        "Skipping Merge Guard terminal-failure check-run publication: no pull request payload available on the failed job.",
        { deliveryId: input.job.data.deliveryId }
      );
      return;
    }
    const [owner = "unknown", repo = pr.repositoryFullName] = pr.repositoryFullName.split("/");
    const result = terminalFailurePolicyResult({
      attemptsMade: input.summary.attemptsMade,
      maxAttempts: input.summary.maxAttempts
    });
    const published = await publishCheckIfConfigured({
      data: input.job.data,
      githubContext: { owner, repo },
      pr,
      result
    });
    console.log("Published Merge Guard terminal-failure check-run", {
      deliveryId: input.job.data.deliveryId,
      repositoryFullName: pr.repositoryFullName,
      pullRequestNumber: pr.pullRequestNumber,
      published: published.published
    });
  } catch (publishError) {
    console.error("Failed to publish Merge Guard terminal-failure check-run", {
      deliveryId: input.job.data.deliveryId,
      errorClass: publishError instanceof Error ? publishError.name : "UnknownError",
      message: publishError instanceof Error ? publishError.message : String(publishError)
    });
  }
}

/**
 * Optional operator-visibility hook for permanently-failed evaluation jobs.
 * When `AGENTFORGE_WORKER_FAILURE_WEBHOOK_URL` is unset, this is a no-op --
 * the review finding this addresses was the ABSENCE of any alerting hook, not
 * a requirement to mandate a specific alerting backend, so nothing changes for
 * deployments that do not opt in. Read directly from `process.env` rather than
 * through `loadConfig()`/`AgentForgeConfig`, matching how this same file
 * already reads `AGENTFORGE_WORKER_AUTOSTART` inline at the bottom of this
 * file instead of threading it through the shared config schema.
 *
 * Best-effort: a failed or unreachable webhook endpoint must never crash the
 * BullMQ `failed` handler or produce an unhandled rejection, so any error from
 * the POST itself is caught and logged here.
 */
export async function postWorkerFailureAlert(input: {
  job: {
    id?: string | undefined;
    data: MergeGuardEvaluationJobData;
  };
  summary: MergeGuardEvaluationFailureSummary;
}): Promise<void> {
  const webhookUrl = process.env.AGENTFORGE_WORKER_FAILURE_WEBHOOK_URL;
  if (!webhookUrl) {
    return;
  }
  const pr = input.job.data.pr;
  const envelopeRepository = input.job.data.envelope?.repository;
  const repositoryFullName =
    pr?.repositoryFullName ?? envelopeRepository?.fullName ?? "unknown_repository";
  const pullRequestNumber =
    pr?.pullRequestNumber ?? input.job.data.envelope?.pullRequest?.number ?? undefined;
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Best-effort, fire-and-forget alert on every terminally-failed job: an
      // unresponsive endpoint should fail fast rather than leave this
      // promise pending for undici's much longer default timeout, which
      // could accumulate open sockets/promises during a burst of failures.
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        jobId: input.job.id,
        deliveryId: input.job.data.deliveryId,
        repositoryFullName,
        pullRequestNumber,
        errorClass: input.summary.errorClass,
        errorMessage: input.summary.message,
        attemptsMade: input.summary.attemptsMade,
        maxAttempts: input.summary.maxAttempts,
        failedAt: input.summary.failedAt
      })
    });
    if (!response.ok) {
      console.error("Merge Guard worker failure alert webhook returned a non-2xx response", {
        deliveryId: input.job.data.deliveryId,
        status: response.status
      });
    }
  } catch (alertError) {
    console.error("Failed to POST Merge Guard worker failure alert webhook", {
      deliveryId: input.job.data.deliveryId,
      errorClass: alertError instanceof Error ? alertError.name : "UnknownError",
      message: alertError instanceof Error ? alertError.message : String(alertError)
    });
  }
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

function supersededHeadShaResult(
  error: SupersededHeadShaError,
  recordId: string
): MergeGuardEvaluationJobResult {
  return {
    processedAt: new Date().toISOString(),
    recordId,
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
  workerPrisma ??= createPrismaClient(config.databaseUrl);
  return workerPrisma;
}

/**
 * Enforces AUDIT_RECORD_RETENTION_DAYS (and any per-organization
 * RetentionSetting.auditRecordRetentionDays override) by hard-deleting
 * AuditEvent, ChangeControlRecord, ExportJob, and WebhookDelivery rows whose
 * timestamp is strictly older than the resolved retention cutoff.
 *
 * Hard-delete vs archive: this deletes rows outright rather than soft-deleting
 * them (the pattern used for removed repositories via
 * `archiveRemovedRepositoriesInPrisma`, which sets `archivedAt`/`archiveReason`
 * and keeps the row). "Retention" for audit/compliance logs conventionally
 * means rows outside the window are not retained, and the repository archive
 * pattern does not map cleanly here: archiving a repository preserves a live,
 * still-queryable entity that can be un-archived; there is no equivalent
 * "un-delete" concept requested for audit trail rows, and keeping them forever
 * under a different flag would defeat the purpose of a retention control.
 * That said, hard-deleting compliance/audit records is a bigger decision than
 * a plain bug fix and may warrant explicit product sign-off before running
 * this in a real production environment with real customer data -- see the
 * task report for this flag. ExportJob and WebhookDelivery follow the same
 * hard-delete choice for consistency: both are lower-sensitivity than the
 * audit trail (their persisted content is already redacted/metadata-only
 * before being written at all), and introducing a different archive pattern
 * for only two of the four swept models would fragment the retention story
 * without a distinct legal/compliance reason to do so.
 *
 * RLS: organization discovery below runs unbound/permissively (there is no
 * single actor/org to scope a system-wide maintenance sweep to), exactly like
 * the worker's existing repository bootstrap lookup in
 * `resolveRuntimeEvaluationContext`. Once a specific organization's rows are
 * being deleted, that delete (and its audit event) runs inside
 * `runWithOrgContext(organizationId, ...)`, matching how `persistWorkerRecord`
 * binds org context before writing AuditEvent/ChangeControlRecord rows. This
 * keeps the Postgres RLS backstop meaningful for the sweep's writes even though
 * it is a cross-tenant system job rather than a single request/job with one
 * natural actor.
 *
 * Unassigned rows: `WebhookDelivery.organizationId` and
 * `ExportJob.organizationId` are nullable in the schema (a webhook delivery
 * can arrive, or an export job can exist, before a GitHub installation is
 * approved and linked to an organization). The per-organization loop below
 * can never reach those rows, since it only ever filters by a specific
 * `organizationId`. A second, separate pass after the loop sweeps
 * organizationId-null ExportJob/WebhookDelivery rows against the *global*
 * retention window (there is no per-org override to resolve for a row with
 * no org). That pass runs unbound -- no `runWithOrgContext` -- because there
 * is no single organization to bind for a cross-tenant, no-tenant row; this
 * matches how this sweep's own organization-discovery query above, and the
 * worker's existing repository bootstrap lookup, also run unbound for the
 * same reason (see docs/tenant-isolation-rls.md). Because
 * `AuditEvent.organizationId` is required (non-nullable) in the schema, there
 * is no organization to attach a `retention_swept` AuditEvent to for this
 * pass; it is logged via `console.log` with structured fields instead. See
 * the task report for this tradeoff.
 */
export async function runAuditRecordRetentionSweep(input: {
  prisma: PrismaClient;
  globalRetentionDays: number;
  now?: Date | undefined;
}): Promise<AuditRecordRetentionSweepResult[]> {
  const organizations = await input.prisma.organization.findMany({
    select: {
      id: true,
      retentionSettings: { select: { auditRecordRetentionDays: true } }
    }
  });

  const results: AuditRecordRetentionSweepResult[] = [];
  for (const organization of organizations) {
    const plan = planAuditRecordRetentionSweep({
      organizationId: organization.id,
      globalRetentionDays: input.globalRetentionDays,
      organizationOverrideDays: organization.retentionSettings?.auditRecordRetentionDays,
      now: input.now
    });

    const result = await runWithOrgContext(organization.id, async () => {
      // Interactive transaction: the automatic RLS-binding hook in
      // @agentforge/db cannot safely re-wrap operations already running on
      // `tx` (see createPrismaClient's doc comment), so this binds the org GUC
      // explicitly as the transaction's own first statement on the real `tx`
      // connection, wrapped in withUnmanagedOrgBinding so the hook forwards
      // every operation below -- including this raw call -- straight to `tx`
      // instead of attempting its own (disconnected) wrap-in-transaction.
      return withUnmanagedOrgBinding(() =>
        input.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('agentforge.current_org', ${organization.id}, true)`;
          // Sequential, not Promise.all: see the identical fix and rationale
          // a few dozen lines below in persistWorkerEvaluationSnapshot --
          // these four deleteMany calls share this transaction's single
          // connection, so real concurrency isn't possible here regardless,
          // only the documented Prisma hang/deadlock risk of running
          // multiple operations "concurrently" against one interactive
          // transaction client.
          const auditEventsDeleted = await tx.auditEvent.deleteMany({
            where: plan.auditEventWhere
          });
          const changeControlRecordsDeleted = await tx.changeControlRecord.deleteMany({
            where: plan.changeControlRecordWhere
          });
          const exportJobsDeleted = await tx.exportJob.deleteMany({
            where: planExportJobRetentionSweep({
              organizationId: organization.id,
              globalRetentionDays: input.globalRetentionDays,
              organizationOverrideDays: organization.retentionSettings?.auditRecordRetentionDays,
              now: input.now
            }).exportJobWhere
          });
          const webhookDeliveriesDeleted = await tx.webhookDelivery.deleteMany({
            where: planWebhookDeliveryRetentionSweep({
              organizationId: organization.id,
              globalRetentionDays: input.globalRetentionDays,
              organizationOverrideDays: organization.retentionSettings?.auditRecordRetentionDays,
              now: input.now
            }).webhookDeliveryWhere
          });
          const summary = summarizeAuditRecordRetentionSweep({
            plan,
            auditEventsDeleted: auditEventsDeleted.count,
            changeControlRecordsDeleted: changeControlRecordsDeleted.count,
            exportJobsDeleted: exportJobsDeleted.count,
            webhookDeliveriesDeleted: webhookDeliveriesDeleted.count
          });

          if (
            summary.auditEventsDeleted > 0 ||
            summary.changeControlRecordsDeleted > 0 ||
            summary.exportJobsDeleted > 0 ||
            summary.webhookDeliveriesDeleted > 0
          ) {
            const audit = createAuditEvent({
              organizationId: organization.id,
              actor: "system",
              actorRole: "system",
              action: "retention_swept",
              targetType: "organization",
              targetId: organization.id,
              source: "worker",
              metadataJson: {
                retentionDays: summary.retentionDays,
                cutoff: summary.cutoff,
                auditEventsDeleted: summary.auditEventsDeleted,
                changeControlRecordsDeleted: summary.changeControlRecordsDeleted,
                exportJobsDeleted: summary.exportJobsDeleted,
                webhookDeliveriesDeleted: summary.webhookDeliveriesDeleted
              }
            });
            // Written in the SAME transaction as the deletes above: if the
            // deletion commits, the audit record documenting it commits with it.
            // A crash between "deletes committed" and "audit event written" would
            // otherwise leave a permanent, silent deletion with no audit trail —
            // exactly the failure mode this system exists to prevent for every
            // other governance action.
            await tx.auditEvent.create({
              data: {
                id: audit.id,
                organizationId: audit.organizationId,
                schemaVersion: audit.schemaVersion,
                actor: audit.actor,
                actorRole: audit.actorRole,
                action: audit.action,
                targetType: audit.targetType,
                targetId: audit.targetId,
                source: audit.source,
                metadataJson: audit.metadataJson as never,
                createdAt: new Date(audit.createdAt)
              }
            });
          }

          return summary;
        })
      );
    });
    results.push(result);
  }
  return results;
}

/**
 * Sibling to `runAuditRecordRetentionSweep`: hard-deletes organizationId-null
 * ExportJob/WebhookDelivery rows past the *global* retention cutoff.
 *
 * This is a separate function (rather than folded into the per-organization
 * loop above) because it targets rows the per-organization loop structurally
 * cannot reach -- that loop only ever queries `where: { organizationId: <a
 * specific org> }`, so a row with `organizationId: null` never matches any
 * iteration of it, no matter how many organizations exist. Both models allow
 * a null organizationId in the schema for rows that predate GitHub
 * installation approval (e.g. a webhook delivery received before its
 * installation was linked to an organization) or any other system-level row
 * with no org assigned yet.
 *
 * Unbound / no `runWithOrgContext`: there is no single organization to bind
 * for a delete that, by definition, only ever touches organizationId-null
 * rows. This mirrors how this file's own organization-discovery query in
 * `runAuditRecordRetentionSweep` above, and the worker's existing repository
 * bootstrap lookup in `resolveRuntimeEvaluationContext`, also run
 * unbound/permissively for system-wide, no-single-tenant operations (see
 * docs/tenant-isolation-rls.md).
 *
 * No AuditEvent: `AuditEvent.organizationId` is required (non-nullable) in
 * the schema, so there is no organization to attach a `retention_swept`
 * AuditEvent to for a delete that is, by construction, not scoped to any
 * organization. This is logged via `console.log`/`console.info` with
 * structured fields instead, following this file's existing console logging
 * conventions (see e.g. the "Processing Merge Guard evaluation job" and
 * "Retention sweep completed" call sites). This means unassigned-row
 * deletions are visible in worker logs but are not part of the durable
 * AuditEvent trail -- see the task report for this tradeoff.
 */
export async function sweepUnassignedExportJobsAndWebhookDeliveries(input: {
  prisma: PrismaClient;
  globalRetentionDays: number;
  now?: Date | undefined;
}): Promise<UnassignedRetentionSweepResult> {
  const plan = planUnassignedRetentionSweep({
    globalRetentionDays: input.globalRetentionDays,
    now: input.now
  });

  const [exportJobsDeleted, webhookDeliveriesDeleted] = await input.prisma.$transaction([
    input.prisma.exportJob.deleteMany({ where: plan.exportJobWhere }),
    input.prisma.webhookDelivery.deleteMany({ where: plan.webhookDeliveryWhere })
  ]);

  const summary = summarizeUnassignedRetentionSweep({
    plan,
    exportJobsDeleted: exportJobsDeleted.count,
    webhookDeliveriesDeleted: webhookDeliveriesDeleted.count
  });

  if (summary.exportJobsDeleted > 0 || summary.webhookDeliveriesDeleted > 0) {
    console.info("Retention sweep deleted unassigned (organizationId-null) rows", {
      deletedCount: summary.exportJobsDeleted,
      model: "ExportJob",
      cutoff: summary.cutoff,
      retentionDays: summary.retentionDays
    });
    console.info("Retention sweep deleted unassigned (organizationId-null) rows", {
      deletedCount: summary.webhookDeliveriesDeleted,
      model: "WebhookDelivery",
      cutoff: summary.cutoff,
      retentionDays: summary.retentionDays
    });
  }

  return summary;
}

/**
 * Upper bound on any single backoff delay, including GitHub-directed waits.
 *
 * GitHub's `retry-after` / `x-ratelimit-reset` signals are normally well
 * under this (rate-limit windows reset hourly at most, and secondary rate
 * limits are typically minutes), but a malformed or unexpectedly distant
 * reset timestamp should not leave a job looking permanently stuck in the
 * queue. 15 minutes keeps jobs retrying within an operator-visible timeframe
 * while still respecting a legitimately long server-specified wait.
 */
const MAX_BACKOFF_DELAY_MS = 15 * 60 * 1000;

/**
 * Bounded jitter added on top of an explicit GitHub-specified wait, so that
 * multiple workers/jobs that hit the same rate limit at the same time don't
 * all retry in the same instant (thundering herd). Kept small and additive
 * (not multiplicative) since GitHub already told us the wait it wants.
 */
const RATE_LIMIT_JITTER_MS = 2000;

/**
 * Pure backoff-delay calculation used by BullMQ's `backoffStrategy` hook.
 *
 * Extracted from the `Worker` settings closure so it can be unit tested
 * directly without needing a live BullMQ `Worker`/`Job` instance. Behavior is
 * unchanged from the original inline closure except for the new
 * GitHub-aware branch: when the failing error carries a `retry-after` or
 * `x-ratelimit-reset` header, that server-specified wait is used directly
 * (plus small jitter) instead of the generic exponential-with-jitter curve,
 * since GitHub has already told us exactly how long to wait.
 */
export function computeBackoffDelay(
  attemptsMade: number,
  type: string | undefined,
  err: unknown,
  job: { opts: { backoff?: { delay?: number } } }
): number {
  const retryAfterMs = githubRetryAfterMs(err);
  if (retryAfterMs !== undefined) {
    const jittered = retryAfterMs + Math.random() * RATE_LIMIT_JITTER_MS;
    return Math.min(MAX_BACKOFF_DELAY_MS, Math.max(1000, Math.floor(jittered)));
  }

  if (type === "exponentialWithJitter") {
    const baseDelay = job.opts.backoff?.delay ?? MERGE_GUARD_EVALUATION_BACKOFF_MS;
    const delay = baseDelay * Math.pow(2, attemptsMade - 1);
    const min = delay * 0.5;
    const max = delay * 1.5;
    const jittered = Math.floor(min + Math.random() * (max - min));
    return Math.min(MAX_BACKOFF_DELAY_MS, Math.max(1000, jittered));
  }
  // Fallback delay calculation
  const baseDelay = job.opts.backoff?.delay ?? 30000;
  return Math.min(MAX_BACKOFF_DELAY_MS, baseDelay * Math.pow(2, attemptsMade - 1));
}

let workerCache: RedisCacheManager | undefined;

async function startWorker(): Promise<void> {
  const config = loadConfig();

  if (!config.redisUrl) {
    console.log("AgentForge worker started without REDIS_URL; queue processing is disabled.");
    return;
  }

  if (config.databaseUrl) {
    // Verify the RLS tenant-isolation backstop is actually enforceable for
    // the connected Postgres role before processing any jobs. Reuses the
    // same lazy singleton getWorkerPrisma(config) that the rest of this
    // module uses, so this adds no extra connection. Best-effort in
    // non-production (warns only); fails closed (throws) in production.
    const isolationCheckClient = getWorkerPrisma(config);
    if (isolationCheckClient) {
      await assertOrgIsolationEnforced(isolationCheckClient, config.nodeEnv);
    }
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
        backoffStrategy: (attemptsMade: number, type: string | undefined, err: any, job: any) =>
          computeBackoffDelay(attemptsMade, type, err, job)
      }
    }
  );

  startAuditRecordRetentionSweepSchedule(config, connection);

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
    // Terminal failure means BullMQ will not retry this job again (see
    // classifyMergeGuardEvaluationFailure: !retryable || attemptsMade >=
    // maxAttempts). Before this, the only signals were the console.error above
    // and the webhookDelivery row updated by recordMergeGuardEvaluationFailure --
    // neither is visible on the PR itself. Both steps below are best-effort
    // (each catches its own errors internally) and run only once retries are
    // actually exhausted, so a job that will still retry (attemptsMade <
    // maxAttempts, retryable) does not get a premature failure check-run or
    // alert while it may yet succeed on a later attempt.
    if (job && summary.terminalFailure) {
      void publishTerminalFailureCheckRun({ job, config, summary });
      void postWorkerFailureAlert({ job, summary });
    }
  });
}

/**
 * Schedules the recurring AuditEvent/ChangeControlRecord/ExportJob/WebhookDelivery
 * retention sweep as a BullMQ repeatable job on
 * `AUDIT_RECORD_RETENTION_SWEEP_QUEUE`, and starts a `Worker` that runs
 * `runAuditRecordRetentionSweep` (per-organization sweep of all four models)
 * followed by `sweepUnassignedExportJobsAndWebhookDeliveries` (the
 * organizationId-null ExportJob/WebhookDelivery pass) whenever that job
 * fires. This remains one queue/schedule rather than a second, competing
 * cron -- extending the existing AuditEvent/ChangeControlRecord sweep to
 * cover two more models is the same maintenance operation, not a distinct
 * one.
 *
 * Architectural choice: BullMQ repeatable job vs an external cron script.
 * This uses BullMQ's `Queue.upsertJobScheduler(schedulerId, repeatOpts,
 * jobTemplate)` API (bullmq 5.78.1) rather than the legacy `Queue.add(name,
 * data, { repeat: { pattern } })` form. BullMQ's own docs recommend
 * `upsertJobScheduler` specifically for registering repeatable jobs
 * idempotently: it explicitly creates-or-updates the named scheduler rather
 * than relying on `add()` + a fixed `jobId` to implicitly de-duplicate across
 * repeated registrations (e.g. on every worker restart), which does not carry
 * the same documented guarantee. No separate `QueueScheduler` class is needed
 * either way -- that class was removed after BullMQ v2; repeat-delay handling
 * has been built into the `Worker` itself since. The alternative considered
 * was a standalone `scripts/*.ts` script invoked by an external Railway cron
 * trigger, matching the `scripts/*.ts` pattern already used for one-off local
 * tooling (fixtures, policy validation, smoke tests). BullMQ was chosen
 * because:
 *   - `docs/railway-deployment.md` and `docs/runbook.md` document exactly one
 *     scheduled/periodic-task mechanism already deployed: the worker process
 *     consuming a Redis-backed BullMQ queue. There is no existing Railway cron
 *     service, cron trigger, or documented external-cron pattern anywhere in
 *     this repository to be consistent with.
 *   - The worker already holds a live Postgres (Prisma) connection and Redis
 *     connection; a standalone script would need to duplicate that connection
 *     setup and would run as a second deployable unit with its own
 *     build/start/health story that Railway's topology doesn't define yet.
 *   - A BullMQ repeatable job is visible through the same admin queue APIs
 *     (`GET /api/admin/queue`) already documented for operating this system,
 *     rather than requiring a new out-of-band monitoring surface for cron
 *     success/failure.
 */
function startAuditRecordRetentionSweepSchedule(
  config: ReturnType<typeof loadConfig>,
  connection: Redis
): void {
  const retentionQueue = new Queue(AUDIT_RECORD_RETENTION_SWEEP_QUEUE, { connection });
  void retentionQueue
    .upsertJobScheduler(
      AUDIT_RECORD_RETENTION_SWEEP_JOB_NAME,
      { pattern: AUDIT_RECORD_RETENTION_SWEEP_CRON },
      { name: AUDIT_RECORD_RETENTION_SWEEP_JOB_NAME, data: {} }
    )
    .catch((error) => {
      console.error(
        "Failed to schedule AuditEvent/ChangeControlRecord/ExportJob/WebhookDelivery retention sweep",
        {
          errorClass: error instanceof Error ? error.name : "UnknownError",
          message: error instanceof Error ? error.message : String(error)
        }
      );
    });

  const retentionWorker = new Worker(
    AUDIT_RECORD_RETENTION_SWEEP_QUEUE,
    async (job) => {
      const prisma = getWorkerPrisma(config);
      if (!prisma) {
        console.log(
          "Skipping AuditEvent/ChangeControlRecord/ExportJob/WebhookDelivery retention sweep: no database configured."
        );
        return {
          organizations: [] as AuditRecordRetentionSweepResult[],
          unassigned: undefined as UnassignedRetentionSweepResult | undefined
        };
      }
      console.log(
        "Running AuditEvent/ChangeControlRecord/ExportJob/WebhookDelivery retention sweep",
        { jobId: job.id }
      );
      // Per-organization sweep of all four models (AuditEvent,
      // ChangeControlRecord, ExportJob, WebhookDelivery) for rows that do
      // have an organizationId, followed by a separate unbound pass for
      // organizationId-null ExportJob/WebhookDelivery rows. These are kept
      // as one scheduled job (not two competing cron schedules) since both
      // passes are the same maintenance operation running back-to-back.
      const organizations = await runAuditRecordRetentionSweep({
        prisma,
        globalRetentionDays: config.auditRecordRetentionDays
      });
      const unassigned = await sweepUnassignedExportJobsAndWebhookDeliveries({
        prisma,
        globalRetentionDays: config.auditRecordRetentionDays
      });
      return { organizations, unassigned };
    },
    { connection }
  );

  retentionWorker.on(
    "completed",
    (
      job,
      result: {
        organizations: AuditRecordRetentionSweepResult[];
        unassigned: UnassignedRetentionSweepResult | undefined;
      }
    ) => {
      const totalAuditEventsDeleted = result.organizations.reduce(
        (sum, item) => sum + item.auditEventsDeleted,
        0
      );
      const totalChangeControlRecordsDeleted = result.organizations.reduce(
        (sum, item) => sum + item.changeControlRecordsDeleted,
        0
      );
      const totalExportJobsDeleted =
        result.organizations.reduce((sum, item) => sum + item.exportJobsDeleted, 0) +
        (result.unassigned?.exportJobsDeleted ?? 0);
      const totalWebhookDeliveriesDeleted =
        result.organizations.reduce((sum, item) => sum + item.webhookDeliveriesDeleted, 0) +
        (result.unassigned?.webhookDeliveriesDeleted ?? 0);
      console.log("Retention sweep completed", {
        jobId: job.id,
        organizationsSwept: result.organizations.length,
        totalAuditEventsDeleted,
        totalChangeControlRecordsDeleted,
        totalExportJobsDeleted,
        totalWebhookDeliveriesDeleted,
        unassignedExportJobsDeleted: result.unassigned?.exportJobsDeleted ?? 0,
        unassignedWebhookDeliveriesDeleted: result.unassigned?.webhookDeliveriesDeleted ?? 0
      });
    }
  );
  retentionWorker.on("failed", (job, error) => {
    console.error("Retention sweep job failed", {
      jobId: job?.id,
      errorClass: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : String(error)
    });
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

// Two rapid `synchronize` webhooks for the same PR are each processed as independent,
// deliveryId-scoped BullMQ jobs with no ordering guarantee between them. A job for an
// older push can finish evaluating after a job for a newer push has already published
// its check-run, and would otherwise overwrite the newer/correct result with a stale one.
//
// This check is intentionally scoped to `pull_request` events with action `synchronize`:
// that is the only case where two evaluations can legitimately be in flight for the same
// PR at once as a direct result of the head_sha changing out from under an in-progress
// job. Other envelope types (`opened`, `reopened`, `edited`, `ready_for_review`, `closed`,
// `pull_request_review`, direct/manual jobs with no envelope) do not race a competing
// evaluation of a newer commit in the same way, and `check_run` replay staleness is
// already covered by `rejectStaleCheckRun` above using data already on the envelope (no
// extra API call needed). Scoping the fresh GitHub lookup this way avoids adding a GitHub
// API call to every single evaluation job, which would be expensive at scale.
async function rejectSupersededHeadSha(input: {
  envelope: GithubWebhookEnvelope | undefined;
  pr: PullRequestInput;
  owner: string;
  repo: string;
  client?: GithubAdapterClient | undefined;
}): Promise<void> {
  if (input.envelope?.event !== "pull_request" || input.envelope.action !== "synchronize") {
    return;
  }
  if (!input.client) {
    // No GitHub client available to check freshness (e.g. a directly-injected job with
    // no client). Fail open rather than block publication on a check we cannot perform.
    return;
  }
  const currentHeadSha = await fetchCurrentPullRequestHeadSha({
    client: input.client,
    owner: input.owner,
    repo: input.repo,
    pullNumber: input.pr.pullRequestNumber
  });
  if (!currentHeadSha || currentHeadSha === input.pr.headSha) {
    return;
  }
  throw new SupersededHeadShaError(
    input.pr.repositoryFullName,
    input.pr.pullRequestNumber,
    input.pr.headSha,
    currentHeadSha
  );
}

async function fetchCurrentPullRequestHeadSha(input: {
  client: GithubAdapterClient;
  owner: string;
  repo: string;
  pullNumber: number;
}): Promise<string | undefined> {
  const response = await input.client.pulls.get({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.pullNumber
  });
  const head = response.data.head as Record<string, unknown> | undefined;
  const sha = head?.sha;
  return typeof sha === "string" && sha.length > 0 ? sha : undefined;
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
  // Interactive transaction: bind the org GUC explicitly as the transaction's
  // own first statement on the real `tx` connection (see createPrismaClient's
  // doc comment in @agentforge/db for why the automatic hook cannot safely do
  // this for operations already running on a `tx` handle).
  await withUnmanagedOrgBinding(() =>
    input.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      await tx.$executeRaw`SELECT set_config('agentforge.current_org', ${input.organizationId}, true)`;
      await tx.evaluation.upsert({
        where: { id: evaluationId },
        update: evaluationData,
        create: {
          id: evaluationId,
          ...evaluationData
        }
      });
      // Sequential, not Promise.all: these three deleteMany calls share the
      // single connection this interactive transaction holds, so running
      // them "concurrently" cannot actually parallelize at the database
      // level -- it only risks the documented Prisma hang/deadlock class
      // that concurrent operations on one interactive-transaction client can
      // trigger (prisma/prisma#8707, #11750, #8880). The atomicity this code
      // needs comes from the transaction itself, not from concurrency here.
      await tx.verifiedFactRecord.deleteMany({ where: { evaluationId } });
      await tx.evidenceRequirementRecord.deleteMany({ where: { evaluationId } });
      await tx.reviewerRequirementRecord.deleteMany({ where: { evaluationId } });
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
    })
  );
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
  await startWorker();
}
