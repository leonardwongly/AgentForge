import { createHash, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { z } from "zod";
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

type RepositoryPolicyState = {
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

type RepositorySettingsState = {
  repositoryId: string;
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
  repositoryPolicies: Map<string, RepositoryPolicyState>;
  repositorySettings: Map<string, RepositorySettingsState>;
  ownerMappings: OwnerMappingState[];
};

type RawBodyRequest = {
  rawBody?: Buffer;
};

const policyModeSchema = z.enum(["observe", "warn", "enforce", "optimize"]);
const diffRetentionSchema = z.enum(["disabled", "7d", "30d", "custom"]);
const dataHandlingPatchSchema = z
  .object({
    sourceCodeStorage: z.boolean().optional(),
    fullDiffRetention: diffRetentionSchema.optional(),
    redactSecrets: z.boolean().optional(),
    llmFeatures: z.boolean().optional(),
    auditRecordRetentionDays: z.number().int().positive().max(3650).optional()
  })
  .strict();
const ownerMappingPatchSchema = z
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
  .strict();
const repositorySettingsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: policyModeSchema.optional(),
    policyVersion: z.string().trim().min(1).max(160).optional(),
    dataHandling: dataHandlingPatchSchema.optional(),
    ownerMappings: z.array(ownerMappingPatchSchema).max(20).optional(),
    sourceCodeStorage: z.boolean().optional(),
    fullDiffRetention: diffRetentionSchema.optional(),
    redactSecrets: z.boolean().optional(),
    llmFeatures: z.boolean().optional(),
    auditRecordRetentionDays: z.number().int().positive().max(3650).optional()
  })
  .strict();

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
  const listRepositories = () => listRepositorySummaries(state, prisma, config.defaultPolicyMode);
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
    repositories: safe(await listRepositories())
  }));

  app.get("/api/settings", async () => {
    const repositories = await listRepositories();
    const ownerMappings = await listOwnerMappings();
    return safe({
      githubInstallation: await githubInstallationSummary(prisma, config),
      repositories,
      dataHandling: await defaultDataHandlingSettings(prisma, config),
      ownerMappings: ownerMappings.map(ownerMappingForApi),
      exports: {
        json: true,
        csv: true,
        storageBucketConfigured: Boolean(config.exportStorageBucket),
        storageRegion: config.exportStorageRegion
      }
    });
  });

  app.get("/api/onboarding/status", async () => {
    const repositories = await listRepositories();
    const records = await listRecords();
    const settings = {
      githubInstallation: await githubInstallationSummary(prisma, config),
      ownerMappings: await listOwnerMappings()
    };
    return safe({
      steps: onboardingStepsFromRuntime({
        repositories,
        records,
        githubConnected: settings.githubInstallation.connected,
        ownerMappingsConfigured: settings.ownerMappings.length > 0
      })
    });
  });

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
    const repositoryId = (request.params as { id: string }).id;
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
            action: "repository_settings_changed",
            targetType: "repository",
            targetId: repositoryId,
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
            action: "retention_changed",
            targetType: "repository_setting",
            targetId: repositoryId,
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
            action: "owner_mapping_changed",
            targetType: "owner_mapping",
            targetId: repositoryId,
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

  app.get("/api/repositories/:id/policy", async (request, reply) => {
    const repositoryId = (request.params as { id: string }).id;
    const policy = await getRepositoryPolicy(repositoryId);
    if (!policy) {
      return reply.code(404).send({ error: "Active policy is not configured for this repository" });
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
    let policy: RepositoryPolicyState;
    try {
      policy = await saveRepositoryPolicy(
        (request.params as { id: string }).id,
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
      organizationId: "org_local",
      repositoryId: (request.params as { id: string }).id,
      actor: actor.login,
      action: "policy_changed",
      targetType: "policy",
      targetId: policy.contentHash,
      metadataJson: { contentHash: parsed.contentHash, actorRole: actor.role }
    });
    return {
      repositoryId: (request.params as { id: string }).id,
      contentHash: policy.contentHash,
      version: policy.version,
      valid: true
    };
  });

  app.post("/api/policies/validate", async (request) => {
    const body = request.body as { contentYaml?: string };
    return validatePolicyYaml(body.contentYaml ?? "");
  });

  app.post("/api/policies/preview", async (request, reply) => {
    const body = request.body as { contentYaml?: string; pr?: PullRequestInput };
    const repositoryId = body.pr
      ? await findRepositoryIdByFullName(state, prisma, body.pr.repositoryFullName)
      : undefined;
    const activePolicy = body.pr
      ? await getRepositoryPolicy(
          repositoryId ?? repositoryIdFromFullName(body.pr.repositoryFullName)
        )
      : undefined;
    const contentYaml = body.contentYaml ?? activePolicy?.contentYaml;
    if (!body.pr) {
      return reply.code(400).send({ error: "pull request input is required" });
    }
    if (!contentYaml) {
      return reply
        .code(400)
        .send({ error: "contentYaml is required when the repository has no active policy" });
    }
    const evaluationInput: Parameters<typeof evaluateFixturePr>[0] = {
      pr: body.pr,
      policyYaml: contentYaml,
      storagePolicy
    };
    if (repositoryId) {
      evaluationInput.repositoryId = repositoryId;
      const modeOverride = await getRepositoryModeOverride(state, prisma, repositoryId);
      if (modeOverride) {
        evaluationInput.modeOverride = modeOverride;
      }
    }
    const output = evaluateFixturePr(evaluationInput);
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
        (item) =>
          item.repositoryId === params.id && item.pullRequestNumber === Number(params.number)
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
    const savedRecord = await saveRecord(recomputeRequirementStatus(record));
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
        const savedRecord = await saveRecord(recomputeRequirementStatus(record));
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
        const savedRecord = await saveRecord(recomputeRequirementStatus(record));
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
      const policy = await getRecordPolicyConfig(record);
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
  app.get("/api/dashboard/records", async () => ({
    records: safe(
      (await listRecords()).map((record) => sanitizeChangeControlRecord(record, storagePolicy))
    )
  }));
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
    exports: [],
    repositoryPolicies: new Map(),
    repositorySettings: new Map(),
    ownerMappings: []
  };
}

async function listRepositorySummaries(
  state: AppState,
  prisma: PrismaClient | undefined,
  defaultMode: ChangeControlRecord["mode"]
) {
  if (prisma) {
    const rows = await prisma.repository.findMany({
      include: { currentPolicyVersion: true, settings: true },
      orderBy: { fullName: "asc" }
    });
    return rows.map((row) => {
      const parsedPolicy = row.currentPolicyVersion
        ? parsePolicyYaml(row.currentPolicyVersion.contentYaml)
        : undefined;
      return {
        id: row.id,
        fullName: row.fullName,
        enabled: row.enabled,
        mode: row.mode ?? row.currentPolicyVersion?.mode ?? defaultMode,
        currentPolicyPack: parsedPolicy?.config.policy_pack_id,
        currentPolicyVersion: row.currentPolicyVersion?.version,
        protected: row.protected,
        defaultBranch: row.defaultBranch,
        dataHandling: row.settings ? dataHandlingFromRepositorySetting(row.settings) : undefined
      };
    });
  }

  const repositories = new Map<
    string,
    {
      id: string;
      fullName: string;
      enabled: boolean;
      mode: ChangeControlRecord["mode"];
      currentPolicyPack?: string | undefined;
      currentPolicyVersion?: string | undefined;
      protected: boolean;
      defaultBranch: string;
      dataHandling?: RepositoryDataHandlingState | undefined;
    }
  >();

  for (const record of state.records) {
    const policy = state.repositoryPolicies.get(record.repositoryId);
    const settings = state.repositorySettings.get(record.repositoryId);
    repositories.set(record.repositoryId, {
      id: record.repositoryId,
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
    if (!repositories.has(policy.repositoryId)) {
      const settings = state.repositorySettings.get(policy.repositoryId);
      repositories.set(policy.repositoryId, {
        id: policy.repositoryId,
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
    if (!repositories.has(settings.repositoryId)) {
      repositories.set(settings.repositoryId, {
        id: settings.repositoryId,
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
    const findArgs: Parameters<typeof prisma.ownerMapping.findMany>[0] = {
      orderBy: [{ repositoryId: "asc" }, { ownerKey: "asc" }]
    };
    if (repositoryId) {
      findArgs.where = { repositoryId };
    }
    const rows = await prisma.ownerMapping.findMany(findArgs);
    return rows.map((row) => {
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
  state: AppState,
  prisma: PrismaClient | undefined
): Promise<ChangeControlRecord[]> {
  if (!prisma) {
    return state.records;
  }
  const rows = await prisma.changeControlRecord.findMany({
    include: { pullRequest: { select: { repositoryId: true } } },
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
  const row = await prisma.changeControlRecord.findUnique({
    where: { id },
    include: { pullRequest: { select: { repositoryId: true } } }
  });
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
  const savedRecord = changeControlRecordFromRow({
    ...persisted,
    pullRequest: { repositoryId: repository.id }
  });
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
  pullRequest?: { repositoryId: string } | null;
}): ChangeControlRecord {
  const output = {
    id: row.id,
    organizationId: "org_local",
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

function humanizeIdentifier(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

async function githubInstallationSummary(
  prisma: PrismaClient | undefined,
  config: ReturnType<typeof loadConfig>
) {
  if (prisma) {
    const installation = await prisma.gitHubInstallation.findFirst({
      orderBy: { createdAt: "desc" }
    });
    if (installation) {
      return {
        connected: true,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        githubInstallationId: installation.githubInstallationId.toString()
      };
    }
  }
  return {
    connected: Boolean(
      config.github.appId && config.github.privateKey && config.github.webhookSecret
    ),
    accountLogin: undefined,
    accountType: undefined,
    githubInstallationId: undefined
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

function recomputeRequirementStatus(
  record: ChangeControlRecord,
  now = new Date().toISOString()
): ChangeControlRecord {
  if (record.lifecycle === "overridden") {
    return { ...record, updatedAt: now };
  }

  const hasMissingEvidence = record.requiredEvidence.some((item) => item.status === "missing");
  const hasPendingRequiredReview = record.requiredReviewers.some(
    (item) => item.tier === "required" && !item.approved
  );
  const wouldBlock = hasMissingEvidence || hasPendingRequiredReview;
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
