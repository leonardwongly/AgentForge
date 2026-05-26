import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getMembershipCacheKey, type ChangeControlRecord } from "@agentforge/core";
import {
  formatMergeGuardCheck,
  normalizeGithubWebhook,
  shouldEnqueueEvaluation,
  verifyGithubSignature
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
import { summarizeSafeSnippet, type MetadataStoragePolicy } from "@agentforge/security";
import {
  isAuthzFailure,
  requireApiActor,
  requireOrganizationAccess,
  requireRole,
  type ApiActor
} from "../auth.js";
import { evaluateFixturePr } from "../evaluation.js";
import type { ExportJob, RepositoryPolicyState } from "../app.js";

type RawBodyRequest = {
  rawBody?: Buffer;
};

type RouteSchema<T = any> = {
  safeParse: (value: unknown) =>
    | { success: true; data: T }
    | {
        success: false;
        error: {
          issues: Array<{ path: PropertyKey[]; message: string }>;
          flatten: () => any;
        };
      };
};

type ApiRouteContext = {
  apiCache: { del: (key: string) => Promise<unknown> };
  audit: (...args: any[]) => Promise<any>;
  auditReevaluation: (...args: any[]) => Promise<any>;
  config: any;
  evaluationQueue: any;
  getRecord: (id: string) => Promise<ChangeControlRecord | undefined>;
  listOwnerMappings: () => Promise<any[]>;
  listRecords: () => Promise<ChangeControlRecord[]>;
  listRepositories: (organizationId?: string) => Promise<any[]>;
  prisma: any;
  recordsForAction: (recordId?: string) => Promise<ChangeControlRecord[]>;
  recordsVisibleTo: (actor: ApiActor) => Promise<ChangeControlRecord[]>;
  recordRequiresAction: (record: ChangeControlRecord) => boolean;
  filterAndSortRecords: (records: ChangeControlRecord[], query: any) => ChangeControlRecord[];
  paginateRecords: (
    records: ChangeControlRecord[],
    query: any
  ) => { records: ChangeControlRecord[]; pageInfo: any };
  dashboardSummary: (records: ChangeControlRecord[]) => any;
  groupBy: <T>(items: T[], getKey: (item: T) => string) => Record<string, number>;
  requireReadActor: (request: any, reply: any) => ApiActor | undefined;
  safe: <T>(value: T) => T;
  saveRecord: (record: ChangeControlRecord, pr?: any) => Promise<ChangeControlRecord>;
  storagePolicy: MetadataStoragePolicy;
  codeownersPreviewSchema: RouteSchema;
  compliancePackageRequestSchema: RouteSchema;
  evidenceRejectionSchema: RouteSchema;
  evidenceSubmissionSchema: RouteSchema;
  exportRequestSchema: RouteSchema;
  githubInstallationDecisionSchema: RouteSchema;
  githubInstallationVerifySchema: RouteSchema;
  policyPreviewSchema: RouteSchema;
  policyUpdateSchema: RouteSchema;
  queueReplaySchema: RouteSchema;
  recordPageQuerySchema: RouteSchema;
  recordScopedActionSchema: RouteSchema;
  repositorySettingsPatchSchema: RouteSchema;
  [key: string]: any;
};

export function registerApiRoutes(app: FastifyInstance, context: ApiRouteContext): void {
  const {
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
    findReplayableDelivery,
    findRepositoryIdByFullName,
    fetchGithubInstallationAccount,
    getExportJob,
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
    listAuditEvents,
    listAuditEventsForRecordExport,
    listGithubInstallations,
    listOwnerMappings,
    listRecentWebhookDeliveryFailures,
    listRecords,
    listRepositories,
    markWebhookDeliveryCompleted,
    markWebhookDeliveryEnqueueFailed,
    markWebhookDeliveryQueued,
    markWebhookDeliveryReplayed,
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
    repositoryIdFromFullName,
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
  } = context;

  void app.register(async function systemRoutes(app) {
    app.get("/health", async () => ({
      status: "ok",
      database: config.databaseUrl ? "configured" : "not_configured",
      workerQueue: config.redisUrl ? "configured" : "in_memory",
      runtimeStore: prisma ? "postgres" : "in_memory",
      unsignedWebhookMode:
        !config.github.webhookSecret && config.github.allowUnsignedWebhooks
          ? "enabled"
          : "disabled",
      version: "0.1.0"
    }));

    app.get("/ready", async (_request, reply) => {
      const queue = await queueOperationalStatus({ state, evaluationQueue });
      const ready = queue.status === "ready";
      return reply.code(ready ? 200 : 503).send({
        status: ready ? "ready" : "not_ready",
        database: config.databaseUrl ? "configured" : "not_configured",
        workerQueue: config.redisUrl ? "configured" : "in_memory",
        runtimeStore: prisma ? "postgres" : "in_memory",
        queue,
        version: "0.1.0"
      });
    });

    app.get("/metrics", async (_request, reply) => {
      const body = await collectPrometheusMetrics({ state, prisma, evaluationQueue, config });
      return reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8").send(body);
    });
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
      const delivery = await recordWebhookDeliveryReceived(state, prisma, envelope);
      await processGithubInstallationWebhook(state, prisma, envelope, config);

      if (!shouldQueue) {
        await markWebhookDeliveryCompleted(state, prisma, deliveryId);
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
        await markWebhookDeliveryQueued(state, prisma, deliveryId, queued.jobId);
      } catch (error) {
        await markWebhookDeliveryEnqueueFailed(state, prisma, deliveryId, error);
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
      const actor = requireApiActor(request);
      if (isAuthzFailure(actor)) {
        return reply.code(actor.statusCode).send({ error: actor.reason });
      }
      const allowed = requireRole(
        actor,
        ["platform_admin", "engineering_manager", "auditor"],
        "Queue inspection"
      );
      if (isAuthzFailure(allowed)) {
        return reply.code(allowed.statusCode).send({ error: allowed.reason });
      }

      const queue = await queueOperationalStatus({ state, evaluationQueue });
      const deliveryFailures = await listRecentWebhookDeliveryFailures(
        prisma,
        actor.organizationId
      );
      return {
        queue: safe(queue),
        deliveryFailures: safe(deliveryFailures),
        payloadsIncluded: false
      };
    });

    app.post("/api/admin/queue/replay", async (request, reply) => {
      const actor = requireApiActor(request);
      if (isAuthzFailure(actor)) {
        return reply.code(actor.statusCode).send({ error: actor.reason });
      }
      const allowed = requireRole(
        actor,
        ["platform_admin", "engineering_manager"],
        "Webhook replay"
      );
      if (isAuthzFailure(allowed)) {
        return reply.code(allowed.statusCode).send({ error: allowed.reason });
      }
      const parsed = queueReplaySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: parsed.error.issues[0]?.message ?? "Invalid replay request" });
      }

      const replayable = await findReplayableDelivery(
        state,
        prisma,
        parsed.data,
        actor.organizationId
      );
      if (!replayable) {
        return reply.code(404).send({ error: "Replayable webhook delivery was not found." });
      }
      const replayOrganizationId =
        replayable.delivery.organizationId ??
        (replayable.delivery.repositoryId
          ? await repositoryOrganizationId(state, prisma, replayable.delivery.repositoryId)
          : undefined);
      if (!replayOrganizationId) {
        return reply
          .code(403)
          .send({ error: "Webhook replay requires a tenant-scoped delivery record." });
      }
      const tenantAccess = requireOrganizationAccess(actor, replayOrganizationId, "Webhook replay");
      if (!tenantAccess.ok) {
        return reply.code(tenantAccess.statusCode).send({ error: tenantAccess.reason });
      }
      if (!shouldEnqueueEvaluation(replayable.envelope)) {
        return reply.code(400).send({ error: "Webhook delivery is not an evaluation event." });
      }

      const replayJobId = `replay:${replayable.envelope.deliveryId}:${randomUUID()}`;
      const queued = await enqueueMergeGuardEvaluation({
        state,
        evaluationQueue,
        deliveryId: replayable.envelope.deliveryId,
        envelope: replayable.envelope,
        jobId: replayJobId
      });
      await markWebhookDeliveryReplayed(prisma, replayable.envelope.deliveryId, actor.login);
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
  });

  void app.register(async function repositorySettingsRoutes(app) {
    app.get("/api/repositories", async (request, reply) => {
      const actor = requireReadActor(request, reply);
      if (!actor) {
        return;
      }
      return {
        repositories: safe(await listRepositories(actor.organizationId))
      };
    });

    app.get("/api/settings", async (request, reply) => {
      const actor = requireReadActor(request, reply);
      if (!actor) {
        return;
      }
      const repositories = await listRepositories(actor.organizationId);
      const ownerMappings = (await listOwnerMappings()).filter(
        (mapping) => mapping.organizationId === actor.organizationId
      );
      const githubInstallation = await githubInstallationSummary(
        prisma,
        config,
        actor.organizationId
      );
      return safe({
        runtimeStore: prisma ? "postgres" : "in_memory",
        githubInstallation,
        auth: {
          builtInGithubOAuthConfigured: Boolean(
            config.github.clientId && config.github.clientSecret
          ),
          trustedProxyConfigured: config.auth.apiTrustProxyHeaders
        },
        repositories,
        dataHandling: await defaultDataHandlingSettings(prisma, config),
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
      const actor = requireReadActor(request, reply);
      if (!actor) {
        return;
      }
      const repositories = await listRepositories(actor.organizationId);
      const records = await recordsVisibleTo(actor);
      const settings = {
        githubInstallation: await githubInstallationSummary(prisma, config, actor.organizationId),
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
      const actor = requireApiActor(request);
      if (isAuthzFailure(actor)) {
        return reply.code(actor.statusCode).send({ error: actor.reason });
      }
      const allowed = requireRole(
        actor,
        ["platform_admin", "engineering_manager"],
        "GitHub installation administration"
      );
      if (!allowed.ok) {
        return reply.code(allowed.statusCode).send({ error: allowed.reason });
      }
      return safe({
        installations: await listGithubInstallations(prisma, actor.organizationId),
        installUrl: githubInstallUrl(config),
        credentialsConfigured: githubCredentialsConfigured(config)
      });
    });

    app.post("/api/github/installations/verify", async (request, reply) => {
      const actor = requireApiActor(request);
      if (isAuthzFailure(actor)) {
        return reply.code(actor.statusCode).send({ error: actor.reason });
      }
      const allowed = requireRole(actor, ["platform_admin"], "GitHub installation verification");
      if (!allowed.ok) {
        return reply.code(allowed.statusCode).send({ error: allowed.reason });
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
      if (!prisma) {
        return reply.code(409).send({
          error:
            "Manual GitHub installation verification requires the Postgres runtime store. Start Postgres, run migrations, and use the Postgres-backed API before recording or approving installations."
        });
      }
      const githubAccount = parsed.data.accountLogin
        ? undefined
        : await fetchGithubInstallationAccount(config, parsed.data.githubInstallationId);
      const installation = await upsertPendingGithubInstallation(prisma, {
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
      const actor = requireApiActor(request);
      if (isAuthzFailure(actor)) {
        return reply.code(actor.statusCode).send({ error: actor.reason });
      }
      const allowed = requireRole(actor, ["platform_admin"], "GitHub installation approval");
      if (!allowed.ok) {
        return reply.code(allowed.statusCode).send({ error: allowed.reason });
      }
      const parsed = githubInstallationDecisionSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid GitHub installation approval request" });
      }
      const installation = await approveGithubInstallation(prisma, {
        id: (request.params as { id: string }).id,
        organizationId: actor.organizationId,
        actor: actor.login
      });
      if (!installation) {
        return reply.code(404).send({ error: "GitHub installation was not found." });
      }
      await syncRepositoriesFromStoredInstallationEvents(state, prisma, installation);
      await syncRepositoriesFromCurrentGithubInstallation(state, prisma, config, {
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
      const actor = requireApiActor(request);
      if (isAuthzFailure(actor)) {
        return reply.code(actor.statusCode).send({ error: actor.reason });
      }
      const allowed = requireRole(actor, ["platform_admin"], "GitHub installation rejection");
      if (!allowed.ok) {
        return reply.code(allowed.statusCode).send({ error: allowed.reason });
      }
      const parsed = githubInstallationDecisionSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid GitHub installation rejection request" });
      }
      const installation = await rejectGithubInstallation(prisma, {
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
      const organizationId = await repositoryOrganizationId(state, prisma, repositoryId);
      if (!organizationId) {
        return reply.code(404).send({ error: "Repository not found" });
      }
      const tenantAccess = requireOrganizationAccess(
        actor,
        organizationId,
        "Repository settings update"
      );
      if (!tenantAccess.ok) {
        return reply.code(tenantAccess.statusCode).send({ error: tenantAccess.reason });
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
      const actor = requireReadActor(request, reply);
      if (!actor) {
        return;
      }
      const repositoryId = (request.params as { id: string }).id;
      const organizationId = await repositoryOrganizationId(state, prisma, repositoryId);
      if (!organizationId) {
        return reply.code(404).send({ error: "Repository not found" });
      }
      const tenantAccess = requireOrganizationAccess(actor, organizationId, "Policy access");
      if (!tenantAccess.ok) {
        return reply.code(tenantAccess.statusCode).send({ error: tenantAccess.reason });
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
      const actor = requireApiActor(request);
      if (isAuthzFailure(actor)) {
        return reply.code(actor.statusCode).send({ error: actor.reason });
      }
      const allowed = requireRole(
        actor,
        ["platform_admin", "engineering_manager"],
        "Policy update"
      );
      if (!allowed.ok) {
        return reply.code(allowed.statusCode).send({ error: allowed.reason });
      }
      const repositoryId = (request.params as { id: string }).id;
      const organizationId = await repositoryOrganizationId(state, prisma, repositoryId);
      if (!organizationId) {
        return reply.code(404).send({ error: "Repository not found" });
      }
      const tenantAccess = requireOrganizationAccess(actor, organizationId, "Policy update");
      if (!tenantAccess.ok) {
        return reply.code(tenantAccess.statusCode).send({ error: tenantAccess.reason });
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

    app.post("/api/policies/preview", async (request, reply) => {
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
      if (body.persist) {
        const resolvedActor = requireApiActor(request);
        if (isAuthzFailure(resolvedActor)) {
          return reply.code(resolvedActor.statusCode).send({ error: resolvedActor.reason });
        }
        actor = resolvedActor;
        const allowed = requireRole(
          resolvedActor,
          ["platform_admin", "engineering_manager"],
          "Persisted policy preview"
        );
        if (!allowed.ok) {
          return reply.code(allowed.statusCode).send({ error: allowed.reason });
        }
      }
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
        organizationId: actor?.organizationId ?? "org_local",
        storagePolicy
      };
      if (repositoryId) {
        if (body.persist) {
          const repositoryOrganization = await repositoryOrganizationId(
            state,
            prisma,
            repositoryId
          );
          if (repositoryOrganization) {
            const tenantAccess = requireOrganizationAccess(
              actor!,
              repositoryOrganization,
              "Persisted policy preview"
            );
            if (!tenantAccess.ok) {
              return reply.code(tenantAccess.statusCode).send({ error: tenantAccess.reason });
            }
          }
        }
        evaluationInput.repositoryId = repositoryId;
        const modeOverride = await getRepositoryModeOverride(state, prisma, repositoryId);
        if (modeOverride) {
          evaluationInput.modeOverride = modeOverride;
        }
      }
      const output = evaluateFixturePr(evaluationInput);
      if (!body.persist) {
        return safe({ ...output, persisted: false });
      }

      if (!actor) {
        const resolvedActor = requireApiActor(request);
        if (isAuthzFailure(resolvedActor)) {
          return reply.code(resolvedActor.statusCode).send({ error: resolvedActor.reason });
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
    });
  });

  void app.register(async function recordEvidenceReviewerRoutes(app) {
    app.get("/api/pull-requests", async (request, reply) => {
      const actor = requireReadActor(request, reply);
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
      const actor = requireReadActor(request, reply);
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
        return reply.code(tenantAccess.statusCode).send({ error: tenantAccess.reason });
      }
      return {
        record: sanitizeChangeControlRecord(record, storagePolicy),
        explanation: explainChangeControlRecord(record)
      };
    });

    app.get(
      "/api/repositories/:id/pull-requests/:number/change-control-record",
      async (request, reply) => {
        const actor = requireReadActor(request, reply);
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
          record: sanitizeChangeControlRecord(record, storagePolicy),
          explanation: explainChangeControlRecord(record)
        };
      }
    );

    app.post("/api/pull-requests/:id/evidence", async (request, reply) => {
      const params = request.params as { id: string };
      const record = await getRecord(params.id);
      if (!record) {
        return reply.code(404).send({ error: "Change Control Record not found" });
      }
      const actor = requireApiActor(request);
      if (isAuthzFailure(actor)) {
        return reply.code(actor.statusCode).send({ error: actor.reason });
      }
      const tenantAccess = requireOrganizationAccess(
        actor,
        record.organizationId,
        "Evidence submission"
      );
      if (!tenantAccess.ok) {
        return reply.code(tenantAccess.statusCode).send({ error: tenantAccess.reason });
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
      const previousStatus = record.checkStatus;
      record.requiredEvidence = record.requiredEvidence.map((item) =>
        item.id === evidence.id
          ? {
              ...item,
              status: "provided",
              source: "manual_attestation",
              providedBy: actor.login,
              providedAt: new Date().toISOString(),
              approvedBy: undefined,
              approvedAt: undefined,
              contentSummary: summarizeSafeSnippet(body.content)
            }
          : item
      );
      const savedRecord = await saveRecord(recomputeRequirementStatus(record));
      await audit({
        organizationId: record.organizationId,
        repositoryId: record.repositoryId,
        pullRequestId: record.id,
        actor: actor.login,
        actorRole: actor.role,
        action: "evidence_provided",
        targetType: "evidence_requirement",
        targetId: evidence.id,
        requestId: request.id,
        metadataJson: {
          kind: evidence.kind,
          recordId: record.id,
          evidenceSource: "manual_attestation",
          actorRole: actor.role
        }
      });
      await auditReevaluation(savedRecord, actor, previousStatus, request.id);
      return {
        evidence: safe(savedRecord.requiredEvidence.find((item) => item.id === evidence.id)),
        record: sanitizeChangeControlRecord(savedRecord, storagePolicy)
      };
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
      for (const record of await recordsForAction(parsedBody.data.recordId)) {
        const tenantAccess = requireOrganizationAccess(
          actor,
          record.organizationId,
          "Evidence approval"
        );
        if (!tenantAccess.ok) {
          return reply.code(tenantAccess.statusCode).send({ error: tenantAccess.reason });
        }
        const evidence = record.requiredEvidence.find(
          (item) => item.id === (request.params as { id: string }).id
        );
        if (evidence) {
          if (evidence.status === "missing" || evidence.status === "rejected") {
            return reply
              .code(409)
              .send({ error: "Evidence must be provided before it can be approved." });
          }
          const approvedAt = new Date().toISOString();
          const previousStatus = record.checkStatus;
          for (const item of record.requiredEvidence) {
            if (item.id === evidence.id) {
              item.status = "approved";
              item.approvedBy = actor.login;
              item.approvedAt = approvedAt;
            }
          }
          const savedRecord = await saveRecord(recomputeRequirementStatus(record));
          await audit({
            organizationId: record.organizationId,
            repositoryId: record.repositoryId,
            pullRequestId: record.id,
            actor: actor.login,
            actorRole: actor.role,
            action: "evidence_approved",
            targetType: "evidence_requirement",
            targetId: evidence.id,
            requestId: request.id,
            metadataJson: { kind: evidence.kind, recordId: record.id, actorRole: actor.role }
          });
          await auditReevaluation(savedRecord, actor, previousStatus, request.id);
          return {
            evidence: safe(savedRecord.requiredEvidence.find((item) => item.id === evidence.id)),
            record: sanitizeChangeControlRecord(savedRecord, storagePolicy)
          };
        }
      }
      return reply.code(404).send({ error: "Evidence requirement not found" });
    });

    app.patch("/api/evidence/:id/reject", async (request, reply) => {
      const actor = requireApiActor(request);
      if (isAuthzFailure(actor)) {
        return reply.code(actor.statusCode).send({ error: actor.reason });
      }
      const allowed = requireRole(
        actor,
        ["engineering_manager", "platform_admin", "security_reviewer"],
        "Evidence rejection"
      );
      if (!allowed.ok) {
        return reply.code(allowed.statusCode).send({ error: allowed.reason });
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
      for (const record of await recordsForAction(parsedBody.data.recordId)) {
        const tenantAccess = requireOrganizationAccess(
          actor,
          record.organizationId,
          "Evidence rejection"
        );
        if (!tenantAccess.ok) {
          return reply.code(tenantAccess.statusCode).send({ error: tenantAccess.reason });
        }
        const evidence = record.requiredEvidence.find(
          (item) => item.id === (request.params as { id: string }).id
        );
        if (evidence) {
          if (evidence.status !== "provided" && evidence.status !== "approved") {
            return reply
              .code(409)
              .send({ error: "Only provided or approved evidence can be rejected." });
          }
          const previousStatus = record.checkStatus;
          const rejectedAt = new Date().toISOString();
          const reasonSummary = summarizeSafeSnippet(parsedBody.data.reason);
          evidence.status = "rejected";
          evidence.approvedBy = undefined;
          evidence.approvedAt = undefined;
          evidence.contentSummary = `Rejected: ${reasonSummary}`;
          evidence.providedAt = evidence.providedAt ?? rejectedAt;
          const savedRecord = await saveRecord(recomputeRequirementStatus(record));
          await audit({
            organizationId: record.organizationId,
            repositoryId: record.repositoryId,
            pullRequestId: record.id,
            actor: actor.login,
            actorRole: actor.role,
            action: "evidence_rejected",
            targetType: "evidence_requirement",
            targetId: evidence.id,
            requestId: request.id,
            metadataJson: {
              kind: evidence.kind,
              reason: reasonSummary,
              recordId: record.id,
              actorRole: actor.role
            }
          });
          await auditReevaluation(savedRecord, actor, previousStatus, request.id);
          return {
            evidence: safe(savedRecord.requiredEvidence.find((item) => item.id === evidence.id)),
            record: sanitizeChangeControlRecord(savedRecord, storagePolicy)
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
      for (const record of await recordsForAction(parsedBody.data.recordId)) {
        const tenantAccess = requireOrganizationAccess(
          actor,
          record.organizationId,
          "Reviewer approval"
        );
        if (!tenantAccess.ok) {
          return reply.code(tenantAccess.statusCode).send({ error: tenantAccess.reason });
        }
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
          const previousStatus = record.checkStatus;
          const savedRecord = await saveRecord(recomputeRequirementStatus(record));
          await audit({
            organizationId: record.organizationId,
            repositoryId: record.repositoryId,
            pullRequestId: record.id,
            actor: actor.login,
            actorRole: actor.role,
            action: "reviewer_approved",
            targetType: "reviewer_requirement",
            targetId: reviewer.id,
            requestId: request.id,
            metadataJson: {
              reviewer: reviewer.reviewer,
              tier: reviewer.tier,
              recordId: record.id,
              actorRole: actor.role
            }
          });
          await auditReevaluation(savedRecord, actor, previousStatus, request.id);
          return {
            reviewer: safe(savedRecord.requiredReviewers.find((item) => item.id === reviewer.id)),
            record: sanitizeChangeControlRecord(savedRecord, storagePolicy)
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
      const tenantAccess = requireOrganizationAccess(actor, record.organizationId, "Override");
      if (!tenantAccess.ok) {
        return reply.code(tenantAccess.statusCode).send({ error: tenantAccess.reason });
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
        await saveOverrideRecord(prisma, output.overrideRecord);
        if (output.auditEvent) {
          output.auditEvent.requestId = request.id;
          output.auditEvent.metadataJson = {
            ...(output.auditEvent.metadataJson ?? {}),
            requestId: request.id
          };
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

    app.get("/api/dashboard/summary", async (request, reply) => {
      const actor = requireReadActor(request, reply);
      if (!actor) {
        return;
      }
      return safe(dashboardSummary(await recordsVisibleTo(actor)));
    });
    app.get("/api/dashboard/records", async (request, reply) => {
      const actor = requireReadActor(request, reply);
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
      const actor = requireReadActor(request, reply);
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
      const actor = requireReadActor(request, reply);
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
      const actor = requireReadActor(request, reply);
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
      const actor = requireReadActor(request, reply);
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
      const actor = requireReadActor(request, reply);
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
      const actor = requireReadActor(request, reply);
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
      return {
        ...safe(generatePolicyTuningReport(page.records)),
        pageInfo: page.pageInfo
      };
    });
  });

  void app.register(async function exportAuditRoutes(app) {
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
      const auditEvents = await listAuditEventsForRecordExport(state, prisma, records);
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
      await saveExportJob(state, prisma, job, actor.login, actor.role);
      await saveAuditEvent(state, prisma, exportAuditEvent);
      return reply.code(201).send({
        id: job.id,
        status: job.status,
        recordCount: job.recordCount,
        totalMatchingRecords: job.totalMatchingRecords,
        truncated: job.truncated
      });
    });

    app.post("/api/exports/compliance-evidence-package", async (request, reply) => {
      const actor = requireApiActor(request);
      if (isAuthzFailure(actor)) {
        return reply.code(actor.statusCode).send({ error: actor.reason });
      }
      const allowed = requireRole(
        actor,
        ["auditor", "platform_admin"],
        "Compliance evidence package export"
      );
      if (!allowed.ok) {
        return reply.code(allowed.statusCode).send({ error: allowed.reason });
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
      const auditEvents = await listAuditEventsForRecordExport(state, prisma, records);
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
      await saveExportJob(state, prisma, job, actor.login, actor.role);
      await saveAuditEvent(state, prisma, exportAuditEvent);
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
      const tenantAccess = requireOrganizationAccess(
        actor,
        job.organizationId,
        "Export job access"
      );
      if (!tenantAccess.ok) {
        return reply.code(tenantAccess.statusCode).send({ error: tenantAccess.reason });
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
      return { auditEvents: safe(await listAuditEvents(state, prisma, actor.organizationId)) };
    });

    app.get("/api/check-output/:recordId", async (request, reply) => {
      const actor = requireReadActor(request, reply);
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
        return reply.code(tenantAccess.statusCode).send({ error: tenantAccess.reason });
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
