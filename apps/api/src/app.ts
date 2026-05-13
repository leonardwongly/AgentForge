import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { loadConfig } from "@agentforge/config";
import type {
  AuditEventRecord,
  ChangeControlRecord,
  EvidenceRequirement,
  PullRequestInput
} from "@agentforge/core";
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
  const storagePolicy: MetadataStoragePolicy = {
    sourceCodeStorage: config.sourceCodeStorage,
    fullDiffRetention: config.fullDiffRetention,
    redactSecrets: config.redactSecrets
  };
  const safe = <T>(value: T): T => sanitizeForMetadataStorage(value, storagePolicy);
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

  app.get("/health", async () => ({
    status: "ok",
    database: config.databaseUrl ? "configured" : "not_configured",
    workerQueue: config.redisUrl ? "configured" : "in_memory",
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
    if (state.deliveries.has(deliveryId)) {
      return reply.code(202).send({ accepted: true, duplicate: true });
    }

    state.deliveries.add(deliveryId);
    const envelope = normalizeGithubWebhook({
      deliveryId,
      event,
      payload: request.body as Record<string, unknown>
    });
    if (shouldEnqueueEvaluation(envelope)) {
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
      enqueued: shouldEnqueueEvaluation(envelope)
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
      auditEvent: recordAuditEvent(state, {
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
    const allowed = requireRole(actor, ["platform_admin", "engineering_manager"], "Policy pack fork");
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
    recordAuditEvent(state, {
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
    const record = sanitizeChangeControlRecord(output.record, storagePolicy);
    state.records.push(record);
    recordAuditEvent(state, {
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
    pullRequests: state.records.map((record) => ({
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
    const record = state.records.find((item) => item.id === (request.params as { id: string }).id);
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
      const record = state.records.find((item) => item.pullRequestNumber === Number(params.number));
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
    const record = state.records.find((item) => item.id === params.id);
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
    recordAuditEvent(state, {
      organizationId: record.organizationId,
      repositoryId: record.repositoryId,
      pullRequestId: record.id,
      actor: actor.login,
      action: "evidence_provided",
      targetType: "evidence_requirement",
      targetId: body.kind,
      metadataJson: { kind: body.kind, source: "manual_attestation", actorRole: actor.role }
    });
    return { evidence: safe(record.requiredEvidence) };
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
    for (const record of state.records) {
      const evidence = record.requiredEvidence.find(
        (item) => item.id === (request.params as { id: string }).id
      );
      if (evidence) {
        evidence.status = "approved";
        evidence.approvedBy = actor.login;
        evidence.approvedAt = new Date().toISOString();
        record.updatedAt = new Date().toISOString();
        recordAuditEvent(state, {
          organizationId: record.organizationId,
          repositoryId: record.repositoryId,
          pullRequestId: record.id,
          actor: actor.login,
          action: "evidence_approved",
          targetType: "evidence_requirement",
          targetId: evidence.id,
          metadataJson: { kind: evidence.kind, actorRole: actor.role }
        });
        return { evidence: safe(evidence) };
      }
    }
    return reply.code(404).send({ error: "Evidence requirement not found" });
  });

  app.patch("/api/reviewers/:id/approve", async (request, reply) => {
    const actor = requireApiActor(request);
    if (isAuthzFailure(actor)) {
      return reply.code(actor.statusCode).send({ error: actor.reason });
    }
    for (const record of state.records) {
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
        recordAuditEvent(state, {
          organizationId: record.organizationId,
          repositoryId: record.repositoryId,
          pullRequestId: record.id,
          actor: actor.login,
          action: "reviewer_approved",
          targetType: "reviewer_requirement",
          targetId: reviewer.id,
          metadataJson: { reviewer: reviewer.reviewer, tier: reviewer.tier, actorRole: actor.role }
        });
        return { reviewer: safe(reviewer) };
      }
    }
    return reply.code(404).send({ error: "Reviewer requirement not found" });
  });

  app.post("/api/pull-requests/:id/override", async (request, reply) => {
    const record = state.records.find((item) => item.id === (request.params as { id: string }).id);
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
      state.records = state.records.map((item) => (item.id === record.id ? output.record : item));
      if (output.auditEvent) {
        state.auditEvents.push(output.auditEvent);
      }
      return reply.code(201).send({
        override: safe(output.overrideRecord),
        record: sanitizeChangeControlRecord(output.record, storagePolicy),
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

  app.get("/api/dashboard/summary", async () => safe(dashboardSummary(state.records)));
  app.get("/api/dashboard/blocked-prs", async () => ({
    blockedPullRequests: safe(
      state.records.filter(
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
        state.records.flatMap((record) => record.verifiedFindings),
        (finding) => finding.type
      )
    )
  }));
  app.get("/api/dashboard/overrides", async () => ({
    overrides: safe(state.records.filter((record) => record.lifecycle === "overridden"))
  }));
  app.get("/api/dashboard/evidence-completion", async () => {
    const evidence = state.records.flatMap((record) => record.requiredEvidence);
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
    const content =
      format === "csv"
        ? exportChangeControlRecordsCsv(state.records, storagePolicy)
        : exportChangeControlRecordsJson(state.records, storagePolicy);
    const job: ExportJob = {
      id: randomUUID(),
      status: "completed",
      format,
      recordCount: state.records.length,
      content,
      createdAt: new Date().toISOString()
    };
    state.exports.push(job);
    recordAuditEvent(state, {
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
    const job = state.exports.find((item) => item.id === (request.params as { id: string }).id);
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
    return { auditEvents: safe(state.auditEvents) };
  });

  app.get("/api/check-output/:recordId", async (request, reply) => {
    const record = state.records.find(
      (item) => item.id === (request.params as { recordId: string }).recordId
    );
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

function recordAuditEvent(
  state: AppState,
  input: Parameters<typeof createAuditEvent>[0]
): AuditEventRecord {
  const event = createAuditEvent(input);
  state.auditEvents.push(event);
  return event;
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
