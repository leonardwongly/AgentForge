import { createHash, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { loadConfig } from "@agentforge/config";
import type {
  AuditEventRecord,
  ChangeControlRecord,
  EvidenceRequirement,
  PullRequestInput
} from "@agentforge/core";
import { PrismaClient } from "@agentforge/db";
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
  parsePolicyYaml,
  validatePolicyYaml
} from "@agentforge/policy";
import {
  applyOverride,
  createAuditEvent,
  exportChangeControlRecordsCsv,
  exportChangeControlRecordsJson,
  explainChangeControlRecord,
  sanitizeChangeControlRecord
} from "@agentforge/records";
import {
  sanitizeForMetadataStorage,
  summarizeSafeSnippet,
  type MetadataStoragePolicy
} from "@agentforge/security";
import { isAuthzFailure, requireApiActor, requireRole } from "./auth.js";
import { evaluateFixturePr } from "./evaluation.js";

type QueuedEvaluation = {
  id: string;
  deliveryId: string;
  envelope: GithubWebhookEnvelope;
  queuedAt: string;
};

type ExportJob = {
  id: string;
  status: "completed";
  format: "json" | "csv";
  recordCount: number;
  content: string;
  createdAt: string;
};

export type AppState = {
  deliveries: Set<string>;
  queuedEvaluations: QueuedEvaluation[];
  records: ChangeControlRecord[];
  auditEvents: AuditEventRecord[];
  exports: ExportJob[];
};

type RawBodyRequest = {
  rawBody?: Buffer;
};

export function createApp(state: AppState = createInitialState()): FastifyInstance {
  const config = loadConfig();
  if (config.databaseUrl) {
    process.env.DATABASE_URL = config.databaseUrl;
  }
  const storagePolicy: MetadataStoragePolicy = {
    sourceCodeStorage: config.sourceCodeStorage,
    fullDiffRetention: config.fullDiffRetention,
    redactSecrets: config.redactSecrets
  };
  const safe = <T>(value: T): T => sanitizeForMetadataStorage(value, storagePolicy);
  const prisma = config.databaseUrl && config.nodeEnv !== "test" ? new PrismaClient() : undefined;
  const queueConnection =
    config.redisUrl && config.nodeEnv !== "test"
      ? new Redis(config.redisUrl, { maxRetriesPerRequest: null })
      : undefined;
  const evaluationQueue = queueConnection
    ? new Queue("merge-guard-evaluations", { connection: queueConnection })
    : undefined;
  const listRecords = () => listChangeControlRecords(state, prisma);
  const getRecord = (id: string) => getChangeControlRecord(state, prisma, id);
  const saveRecord = (record: ChangeControlRecord, pr?: PullRequestInput) =>
    saveChangeControlRecord(state, prisma, record, pr);
  const audit = (input: Parameters<typeof createAuditEvent>[0]) =>
    recordAuditEvent(state, prisma, input);
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
    max: 120,
    timeWindow: "1 minute"
  });

  app.addHook("onClose", async () => {
    await evaluationQueue?.close();
    await queueConnection?.quit();
    await prisma?.$disconnect();
  });

  app.get("/health", async () => ({
    status: "ok",
    database: config.databaseUrl ? "configured" : "not_configured",
    workerQueue: config.redisUrl ? "configured" : "in_memory",
    runtimeStore: prisma ? "postgres" : "in_memory",
    demoMode: config.demoMode,
    unsignedWebhookMode:
      !config.github.webhookSecret && config.github.allowUnsignedWebhooks ? "enabled" : "disabled",
    version: "0.1.0"
  }));

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
    if (await hasWebhookDelivery(state, prisma, deliveryId)) {
      return reply.code(202).send({ accepted: true, duplicate: true });
    }

    const envelope = normalizeGithubWebhook({
      deliveryId,
      event,
      payload: request.body as Record<string, unknown>
    });
    const enqueued = shouldEnqueueEvaluation(envelope);
    await recordWebhookDelivery(state, prisma, envelope, enqueued);
    if (enqueued && evaluationQueue) {
      await evaluationQueue.add(
        "evaluate-pr",
        { deliveryId, envelope },
        {
          jobId: deliveryId,
          attempts: 3,
          removeOnComplete: 100,
          removeOnFail: 500
        }
      );
    } else if (enqueued) {
      state.queuedEvaluations.push({
        id: randomUUID(),
        deliveryId,
        envelope,
        queuedAt: new Date().toISOString()
      });
    }

    return reply.code(202).send({
      accepted: true,
      duplicate: false,
      enqueued
    });
  });

  app.get("/api/repositories", async () => ({
    repositories: [
      {
        id: "repo_local",
        fullName: "acme/payments",
        enabled: true,
        mode: config.defaultPolicyMode,
        currentPolicyPack: "fintech"
      }
    ]
  }));

  app.patch("/api/repositories/:id/settings", async (request, reply) => {
    const actor = requireApiActor(request);
    if (isAuthzFailure(actor)) {
      return reply.code(actor.statusCode).send({ error: actor.reason });
    }
    const allowed = requireRole(
      actor,
      ["platform_admin", "engineering_manager"],
      "Repository settings update"
    );
    if (!allowed.ok) {
      return reply.code(allowed.statusCode).send({ error: allowed.reason });
    }
    return {
      id: (request.params as { id: string }).id,
      updated: true,
      settings: safe(request.body),
      auditEvent: await audit({
        organizationId: "org_local",
        repositoryId: (request.params as { id: string }).id,
        actor: actor.login,
        action: "retention_changed",
        targetType: "repository",
        targetId: (request.params as { id: string }).id,
        metadataJson: { ...safe(request.body as Record<string, unknown>), actorRole: actor.role }
      })
    };
  });

  app.get("/api/policy-packs", async () => ({ policyPacks: builtinPolicyPacks }));
  app.get("/api/policy-packs/:id", async (request, reply) => {
    const pack = getPolicyPack((request.params as { id: string }).id);
    if (!pack) {
      return reply.code(404).send({ error: "Policy pack not found" });
    }
    return pack;
  });
  app.post("/api/policy-packs/:id/fork", async (request, reply) => {
    const actor = requireApiActor(request);
    if (isAuthzFailure(actor)) {
      return reply.code(actor.statusCode).send({ error: actor.reason });
    }
    const allowed = requireRole(
      actor,
      ["platform_admin", "engineering_manager"],
      "Policy pack fork"
    );
    if (!allowed.ok) {
      return reply.code(allowed.statusCode).send({ error: allowed.reason });
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

  app.get("/api/repositories/:id/policy", async (request) => ({
    repositoryId: (request.params as { id: string }).id,
    policy: getPolicyPack("fintech")?.contentYaml
  }));

  app.put("/api/repositories/:id/policy", async (request, reply) => {
    const actor = requireApiActor(request);
    if (isAuthzFailure(actor)) {
      return reply.code(actor.statusCode).send({ error: actor.reason });
    }
    const allowed = requireRole(actor, ["platform_admin", "engineering_manager"], "Policy update");
    if (!allowed.ok) {
      return reply.code(allowed.statusCode).send({ error: allowed.reason });
    }
    const body = request.body as { contentYaml?: string };
    const validation = validatePolicyYaml(body.contentYaml ?? "");
    if (!validation.valid) {
      return reply.code(400).send(validation);
    }
    const parsed = parsePolicyYaml(body.contentYaml ?? "");
    await audit({
      organizationId: "org_local",
      repositoryId: (request.params as { id: string }).id,
      actor: actor.login,
      action: "policy_changed",
      targetType: "policy",
      targetId: parsed.contentHash,
      metadataJson: { contentHash: parsed.contentHash, actorRole: actor.role }
    });
    return {
      repositoryId: (request.params as { id: string }).id,
      contentHash: parsed.contentHash,
      valid: true
    };
  });

  app.post("/api/policies/validate", async (request) => {
    const body = request.body as { contentYaml?: string };
    return validatePolicyYaml(body.contentYaml ?? "");
  });

  app.post("/api/policies/preview", async (request, reply) => {
    const body = request.body as { contentYaml?: string; pr?: PullRequestInput };
    const contentYaml = body.contentYaml ?? getPolicyPack("fintech")?.contentYaml ?? "";
    if (!body.pr) {
      return reply.code(400).send({ error: "pr fixture is required" });
    }
    const output = evaluateFixturePr({ pr: body.pr, policyYaml: contentYaml, storagePolicy });
    const record = await saveRecord(
      sanitizeChangeControlRecord(output.record, storagePolicy),
      body.pr
    );
    await audit({
      organizationId: record.organizationId,
      repositoryId: record.repositoryId,
      pullRequestId: record.id,
      actor: "system",
      action: "check_published",
      targetType: "change_control_record",
      targetId: record.id,
      metadataJson: {
        conclusion: output.checkRun.conclusion,
        status: output.result.status,
        mode: output.result.mode,
        policyVersion: output.result.policyVersion
      }
    });
    return safe({ ...output, record });
  });

  app.get("/api/pull-requests", async () => ({
    pullRequests: (await listRecords()).map((record) => ({
      id: record.id,
      repositoryFullName: record.repositoryFullName,
      pullRequestNumber: record.pullRequestNumber,
      headSha: record.headSha,
      mode: record.mode,
      checkStatus: record.checkStatus,
      missingEvidence: record.requiredEvidence.filter((item) => item.status === "missing").length,
      pendingReviewers: record.requiredReviewers.filter(
        (item) => item.tier === "required" && !item.approved
      ).length
    }))
  }));

  app.get("/api/pull-requests/:id/change-control-record", async (request, reply) => {
    const record = await getRecord((request.params as { id: string }).id);
    if (!record) {
      return reply.code(404).send({ error: "Change Control Record not found" });
    }
    return {
      record: sanitizeChangeControlRecord(record, storagePolicy),
      explanation: explainChangeControlRecord(record)
    };
  });

  app.get(
    "/api/repositories/:id/pull-requests/:number/change-control-record",
    async (request, reply) => {
      const params = request.params as { id: string; number: string };
      const record = (await listRecords()).find(
        (item) => item.pullRequestNumber === Number(params.number)
      );
      if (!record) {
        return reply.code(404).send({ error: "Change Control Record not found" });
      }
      return {
        record: sanitizeChangeControlRecord(record, storagePolicy),
        explanation: explainChangeControlRecord(record)
      };
    }
  );

  app.post("/api/pull-requests/:id/evidence", async (request, reply) => {
    const params = request.params as { id: string };
    const body = request.body as {
      kind?: EvidenceRequirement["kind"];
      content?: string;
      actor?: string;
    };
    const record = await getRecord(params.id);
    if (!record) {
      return reply.code(404).send({ error: "Change Control Record not found" });
    }
    const actor = requireApiActor(request);
    if (isAuthzFailure(actor)) {
      return reply.code(actor.statusCode).send({ error: actor.reason });
    }
    if (!body.kind || !body.content?.trim()) {
      return reply.code(400).send({ error: "kind and content are required" });
    }
    const evidenceContent = body.content;
    record.requiredEvidence = record.requiredEvidence.map((item) =>
      item.kind === body.kind
        ? {
            ...item,
            status: "provided",
            source: "manual_attestation",
            providedBy: actor.login,
            providedAt: new Date().toISOString(),
            contentSummary: summarizeSafeSnippet(evidenceContent)
          }
        : item
    );
    record.updatedAt = new Date().toISOString();
    const savedRecord = await saveRecord(record);
    await audit({
      organizationId: record.organizationId,
      repositoryId: record.repositoryId,
      pullRequestId: record.id,
      actor: actor.login,
      action: "evidence_provided",
      targetType: "evidence_requirement",
      targetId: body.kind,
      metadataJson: { kind: body.kind, source: "manual_attestation", actorRole: actor.role }
    });
    return { evidence: safe(savedRecord.requiredEvidence) };
  });

  app.patch("/api/evidence/:id/approve", async (request, reply) => {
    const actor = requireApiActor(request);
    if (isAuthzFailure(actor)) {
      return reply.code(actor.statusCode).send({ error: actor.reason });
    }
    const allowed = requireRole(
      actor,
      ["engineering_manager", "platform_admin", "security_reviewer"],
      "Evidence approval"
    );
    if (!allowed.ok) {
      return reply.code(allowed.statusCode).send({ error: allowed.reason });
    }
    for (const record of await listRecords()) {
      const evidence = record.requiredEvidence.find(
        (item) => item.id === (request.params as { id: string }).id
      );
      if (evidence) {
        evidence.status = "approved";
        evidence.approvedBy = actor.login;
        evidence.approvedAt = new Date().toISOString();
        record.updatedAt = new Date().toISOString();
        const savedRecord = await saveRecord(record);
        await audit({
          organizationId: record.organizationId,
          repositoryId: record.repositoryId,
          pullRequestId: record.id,
          actor: actor.login,
          action: "evidence_approved",
          targetType: "evidence_requirement",
          targetId: evidence.id,
          metadataJson: { kind: evidence.kind, actorRole: actor.role }
        });
        return {
          evidence: safe(savedRecord.requiredEvidence.find((item) => item.id === evidence.id))
        };
      }
    }
    return reply.code(404).send({ error: "Evidence requirement not found" });
  });

  app.patch("/api/reviewers/:id/approve", async (request, reply) => {
    const actor = requireApiActor(request);
    if (isAuthzFailure(actor)) {
      return reply.code(actor.statusCode).send({ error: actor.reason });
    }
    for (const record of await listRecords()) {
      const reviewer = record.requiredReviewers.find(
        (item) => item.id === (request.params as { id: string }).id
      );
      if (reviewer) {
        const canApprove =
          actor.login === reviewer.reviewer ||
          ["engineering_manager", "platform_admin", "security_reviewer"].includes(actor.role);
        if (!canApprove) {
          return reply
            .code(403)
            .send({ error: "Reviewer approval requires the reviewer or an authorized role." });
        }
        reviewer.approved = true;
        reviewer.approvedBy = actor.login;
        reviewer.approvedAt = new Date().toISOString();
        record.updatedAt = new Date().toISOString();
        const savedRecord = await saveRecord(record);
        await audit({
          organizationId: record.organizationId,
          repositoryId: record.repositoryId,
          pullRequestId: record.id,
          actor: actor.login,
          action: "reviewer_approved",
          targetType: "reviewer_requirement",
          targetId: reviewer.id,
          metadataJson: { reviewer: reviewer.reviewer, tier: reviewer.tier, actorRole: actor.role }
        });
        return {
          reviewer: safe(savedRecord.requiredReviewers.find((item) => item.id === reviewer.id))
        };
      }
    }
    return reply.code(404).send({ error: "Reviewer requirement not found" });
  });

  app.post("/api/pull-requests/:id/override", async (request, reply) => {
    const record = await getRecord((request.params as { id: string }).id);
    if (!record) {
      return reply.code(404).send({ error: "Change Control Record not found" });
    }
    const policy = parsePolicyYaml(getPolicyPack("fintech")?.contentYaml ?? "").config;
    const body = request.body as {
      actorRole?: string;
      reason?: string;
      scope?: "pr" | "finding" | "evidence" | "reviewer";
    };
    const actor = requireApiActor(request);
    if (isAuthzFailure(actor)) {
      return reply.code(actor.statusCode).send({ error: actor.reason });
    }
    try {
      const output = applyOverride({
        record,
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
      const savedRecord = await saveRecord(output.record);
      if (output.auditEvent) {
        await saveAuditEvent(state, prisma, output.auditEvent);
      }
      return reply.code(201).send({
        override: safe(output.overrideRecord),
        record: sanitizeChangeControlRecord(savedRecord, storagePolicy),
        auditEvent: output.auditEvent,
        prVisibleMessage:
          "Merge Guard override recorded. Merge was allowed after authorized override with reason."
      });
    } catch (error) {
      return reply
        .code(403)
        .send({ error: error instanceof Error ? error.message : "Override rejected" });
    }
  });

  app.get("/api/dashboard/summary", async () => safe(dashboardSummary(await listRecords())));
  app.get("/api/dashboard/blocked-prs", async () => ({
    blockedPullRequests: safe(
      (await listRecords()).filter(
        (record) =>
          record.checkStatus === "block" ||
          record.requiredEvidence.some((item) => item.status === "missing") ||
          record.requiredReviewers.some((item) => item.tier === "required" && !item.approved)
      )
    )
  }));
  app.get("/api/dashboard/policy-violations", async () => ({
    violations: safe(
      groupBy(
        (await listRecords()).flatMap((record) => record.verifiedFindings),
        (finding) => finding.type
      )
    )
  }));
  app.get("/api/dashboard/overrides", async () => ({
    overrides: safe((await listRecords()).filter((record) => record.lifecycle === "overridden"))
  }));
  app.get("/api/dashboard/evidence-completion", async () => {
    const evidence = (await listRecords()).flatMap((record) => record.requiredEvidence);
    const complete = evidence.filter((item) => item.status !== "missing").length;
    return {
      total: evidence.length,
      complete,
      completionRate: evidence.length === 0 ? 1 : complete / evidence.length
    };
  });

  app.post("/api/exports/change-control-records", async (request, reply) => {
    const actor = requireApiActor(request);
    if (isAuthzFailure(actor)) {
      return reply.code(actor.statusCode).send({ error: actor.reason });
    }
    const allowed = requireRole(
      actor,
      ["auditor", "platform_admin", "engineering_manager"],
      "Change Control Record export"
    );
    if (!allowed.ok) {
      return reply.code(allowed.statusCode).send({ error: allowed.reason });
    }
    const body = request.body as { format?: "json" | "csv" };
    const format = body.format ?? "json";
    const records = await listRecords();
    const content =
      format === "csv"
        ? exportChangeControlRecordsCsv(records, storagePolicy)
        : exportChangeControlRecordsJson(records, storagePolicy);
    const job: ExportJob = {
      id: randomUUID(),
      status: "completed",
      format,
      recordCount: records.length,
      content,
      createdAt: new Date().toISOString()
    };
    await saveExportJob(state, prisma, job, actor.login, actor.role);
    await audit({
      organizationId: "org_local",
      actor: actor.login,
      action: "record_exported",
      targetType: "change_control_records_export",
      targetId: job.id,
      metadataJson: { format, recordCount: job.recordCount, actorRole: actor.role }
    });
    return reply.code(201).send({ id: job.id, status: job.status, recordCount: job.recordCount });
  });
  app.get("/api/exports/:id", async (request, reply) => {
    const actor = requireApiActor(request);
    if (isAuthzFailure(actor)) {
      return reply.code(actor.statusCode).send({ error: actor.reason });
    }
    const allowed = requireRole(
      actor,
      ["auditor", "platform_admin", "engineering_manager"],
      "Change Control Record export"
    );
    if (!allowed.ok) {
      return reply.code(allowed.statusCode).send({ error: allowed.reason });
    }
    const job = await getExportJob(state, prisma, (request.params as { id: string }).id);
    if (!job) {
      return reply.code(404).send({ error: "Export job not found" });
    }
    return job;
  });

  app.get("/api/audit-events", async (request, reply) => {
    const actor = requireApiActor(request);
    if (isAuthzFailure(actor)) {
      return reply.code(actor.statusCode).send({ error: actor.reason });
    }
    const allowed = requireRole(
      actor,
      ["auditor", "platform_admin", "engineering_manager"],
      "Audit event access"
    );
    if (!allowed.ok) {
      return reply.code(allowed.statusCode).send({ error: allowed.reason });
    }
    return { auditEvents: safe(await listAuditEvents(state, prisma)) };
  });

  app.get("/api/check-output/:recordId", async (request, reply) => {
    const record = await getRecord((request.params as { recordId: string }).recordId);
    if (!record) {
      return reply.code(404).send({ error: "Change Control Record not found" });
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

  return app;
}

export function createInitialState(): AppState {
  return {
    deliveries: new Set(),
    queuedEvaluations: [],
    records: [],
    auditEvents: [],
    exports: []
  };
}

async function listChangeControlRecords(
  state: AppState,
  prisma: PrismaClient | undefined
): Promise<ChangeControlRecord[]> {
  if (!prisma) {
    return state.records;
  }
  const rows = await prisma.changeControlRecord.findMany({
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }]
  });
  return rows.map(changeControlRecordFromRow);
}

async function getChangeControlRecord(
  state: AppState,
  prisma: PrismaClient | undefined,
  id: string
): Promise<ChangeControlRecord | undefined> {
  if (!prisma) {
    return state.records.find((item) => item.id === id);
  }
  const row = await prisma.changeControlRecord.findUnique({ where: { id } });
  return row ? changeControlRecordFromRow(row) : state.records.find((item) => item.id === id);
}

async function saveChangeControlRecord(
  state: AppState,
  prisma: PrismaClient | undefined,
  record: ChangeControlRecord,
  pr?: PullRequestInput
): Promise<ChangeControlRecord> {
  if (!prisma) {
    rememberRecord(state, record);
    return record;
  }

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
      githubPullRequestId: stableBigInt(`${record.repositoryFullName}#${record.pullRequestNumber}`),
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
  const savedRecord = changeControlRecordFromRow(persisted);
  rememberRecord(state, savedRecord);
  return savedRecord;
}

async function hasWebhookDelivery(
  state: AppState,
  prisma: PrismaClient | undefined,
  deliveryId: string
): Promise<boolean> {
  if (state.deliveries.has(deliveryId)) {
    return true;
  }
  if (!prisma) {
    return false;
  }
  const existing = await prisma.webhookDelivery.findUnique({
    where: { deliveryId },
    select: { deliveryId: true }
  });
  return Boolean(existing);
}

async function recordWebhookDelivery(
  state: AppState,
  prisma: PrismaClient | undefined,
  envelope: GithubWebhookEnvelope,
  enqueued: boolean
): Promise<void> {
  state.deliveries.add(envelope.deliveryId);
  if (!prisma) {
    return;
  }
  await prisma.webhookDelivery.create({
    data: {
      deliveryId: envelope.deliveryId,
      event: envelope.event,
      action: envelope.action ?? null,
      repositoryFullName: envelope.repository?.fullName ?? null,
      pullRequestNumber:
        envelope.pullRequest?.number ?? envelope.checkRun?.pullRequests[0]?.number ?? null,
      headSha: envelope.pullRequest?.headSha ?? envelope.checkRun?.headSha ?? null,
      enqueued,
      payloadJson: {
        installationId: envelope.installationId,
        repository: envelope.repository,
        pullRequest: envelope.pullRequest,
        review: envelope.review,
        checkRun: envelope.checkRun,
        installation: envelope.installation,
        receivedAt: envelope.receivedAt
      } as never
    }
  });
}

async function saveExportJob(
  state: AppState,
  prisma: PrismaClient | undefined,
  job: ExportJob,
  actor: string,
  actorRole: string
): Promise<void> {
  state.exports = [job, ...state.exports.filter((item) => item.id !== job.id)];
  if (!prisma) {
    return;
  }
  await prisma.exportJob.create({
    data: {
      id: job.id,
      organizationId: "org_local",
      actor,
      actorRole,
      status: job.status,
      format: job.format,
      recordCount: job.recordCount,
      content: job.content,
      createdAt: new Date(job.createdAt)
    }
  });
}

async function getExportJob(
  state: AppState,
  prisma: PrismaClient | undefined,
  id: string
): Promise<ExportJob | undefined> {
  if (!prisma) {
    return state.exports.find((item) => item.id === id);
  }
  const row = await prisma.exportJob.findUnique({ where: { id } });
  return row
    ? {
        id: row.id,
        status: "completed",
        format: row.format === "csv" ? "csv" : "json",
        recordCount: row.recordCount,
        content: row.content,
        createdAt: row.createdAt.toISOString()
      }
    : state.exports.find((item) => item.id === id);
}

async function listAuditEvents(
  state: AppState,
  prisma: PrismaClient | undefined
): Promise<AuditEventRecord[]> {
  if (!prisma) {
    return state.auditEvents;
  }
  const rows = await prisma.auditEvent.findMany({
    orderBy: { createdAt: "desc" },
    take: 250
  });
  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    repositoryId: row.repositoryId ?? undefined,
    pullRequestId: row.pullRequestId ?? undefined,
    actor: row.actor,
    action: row.action as AuditEventRecord["action"],
    targetType: row.targetType,
    targetId: row.targetId,
    metadataJson: (row.metadataJson as Record<string, unknown> | null) ?? undefined,
    createdAt: row.createdAt.toISOString()
  }));
}

async function recordAuditEvent(
  state: AppState,
  prisma: PrismaClient | undefined,
  input: Parameters<typeof createAuditEvent>[0]
): Promise<AuditEventRecord> {
  const event = createAuditEvent(input);
  await saveAuditEvent(state, prisma, event);
  return event;
}

async function saveAuditEvent(
  state: AppState,
  prisma: PrismaClient | undefined,
  event: AuditEventRecord
): Promise<void> {
  state.auditEvents.push(event);
  if (!prisma) {
    return;
  }
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
      actor: event.actor,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      metadataJson: event.metadataJson as never,
      createdAt: new Date(event.createdAt)
    }
  });
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
  }
) {
  const [owner = "unknown", name = input.fullName] = input.fullName.split("/");
  return prisma.repository.upsert({
    where: {
      organizationId_fullName: {
        organizationId: input.organizationId,
        fullName: input.fullName
      }
    },
    update: {
      defaultBranch: input.defaultBranch,
      enabled: true
    },
    create: {
      id: input.repositoryId,
      organizationId: input.organizationId,
      githubRepositoryId: stableBigInt(input.fullName),
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
}): ChangeControlRecord {
  const output = {
    id: row.id,
    organizationId: "org_local",
    repositoryId: row.pullRequestId.replace(/^pr_/, "repo_"),
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

function humanizeIdentifier(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

function dashboardSummary(records: ChangeControlRecord[]) {
  const evidence = records.flatMap((record) => record.requiredEvidence);
  const complete = evidence.filter((item) => item.status !== "missing").length;
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

function groupBy<T>(items: T[], getKey: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((accumulator, item) => {
    const key = getKey(item);
    accumulator[key] = (accumulator[key] ?? 0) + 1;
    return accumulator;
  }, {});
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
