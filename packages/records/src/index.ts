import { randomUUID } from "node:crypto";
import type {
  AuditEventAction,
  AuditEventRecord,
  ChangeControlRecord,
  OverrideInput,
  OverridePolicy,
  OverrideRecord,
  PolicyResult,
  PullRequestInput
} from "@agentforge/core";
import {
  redactObject,
  sanitizeForMetadataStorage,
  summarizeSafeSnippet,
  type MetadataStoragePolicy
} from "@agentforge/security";

export const AUDIT_EVENT_SCHEMA_VERSION = 1 as const;

export function createChangeControlRecord(input: {
  organizationId: string;
  repositoryId: string;
  pr: PullRequestInput;
  policyResult: PolicyResult;
  now?: string;
  storagePolicy?: MetadataStoragePolicy | undefined;
}): ChangeControlRecord {
  const now = input.now ?? new Date().toISOString();
  return sanitizeChangeControlRecord(
    {
      id: randomUUID(),
      organizationId: input.organizationId,
      repositoryId: input.repositoryId,
      repositoryFullName: input.pr.repositoryFullName,
      pullRequestNumber: input.pr.pullRequestNumber,
      headSha: input.pr.headSha,
      baseBranch: input.pr.baseBranch,
      mode: input.policyResult.mode,
      policyVersion: input.policyResult.policyVersion,
      policyPackId: input.policyResult.policyPackId,
      policyPackVersion: input.policyResult.policyPackVersion,
      verifiedFindings: sanitizeForMetadataStorage(
        input.policyResult.findings,
        input.storagePolicy
      ),
      requiredEvidence: sanitizeForMetadataStorage(
        input.policyResult.requiredEvidence,
        input.storagePolicy
      ),
      requiredReviewers: sanitizeForMetadataStorage(
        input.policyResult.requiredReviewers,
        input.storagePolicy
      ),
      checkStatus: input.policyResult.status,
      lifecycle: lifecycleForStatus(input.policyResult.status),
      decision: {
        status: input.policyResult.status === "block" ? "blocked" : "passed",
        decidedAt: input.policyResult.evaluatedAt
      },
      createdAt: now,
      updatedAt: now
    },
    input.storagePolicy
  );
}

export function updateRecordFromPolicyResult(
  record: ChangeControlRecord,
  policyResult: PolicyResult,
  now = new Date().toISOString(),
  storagePolicy?: MetadataStoragePolicy
): ChangeControlRecord {
  return sanitizeChangeControlRecord(
    {
      ...record,
      mode: policyResult.mode,
      policyVersion: policyResult.policyVersion,
      policyPackId: policyResult.policyPackId,
      policyPackVersion: policyResult.policyPackVersion,
      verifiedFindings: sanitizeForMetadataStorage(policyResult.findings, storagePolicy),
      requiredEvidence: sanitizeForMetadataStorage(policyResult.requiredEvidence, storagePolicy),
      requiredReviewers: sanitizeForMetadataStorage(policyResult.requiredReviewers, storagePolicy),
      checkStatus: policyResult.status,
      lifecycle: lifecycleForStatus(policyResult.status),
      decision: {
        ...record.decision,
        status: policyResult.status === "block" ? "blocked" : "passed",
        decidedAt: policyResult.evaluatedAt
      },
      updatedAt: now
    },
    storagePolicy
  );
}

export function validateOverride(
  input: OverrideInput,
  policy: OverridePolicy
): { ok: true } | { ok: false; reason: string } {
  if (!policy.allowedRoles.includes(input.actorRole)) {
    return { ok: false, reason: "Actor role is not authorized for Merge Guard override." };
  }
  if (policy.requireReason && !input.reason?.trim()) {
    return { ok: false, reason: "Override reason is required by policy." };
  }
  return { ok: true };
}

export function applyOverride(input: {
  record: ChangeControlRecord;
  policy: OverridePolicy;
  override: OverrideInput;
  pullRequestId: string;
  evaluationId?: string;
  now?: string;
}): {
  record: ChangeControlRecord;
  overrideRecord: OverrideRecord;
  auditEvent?: AuditEventRecord | undefined;
} {
  const valid = validateOverride(input.override, input.policy);
  if (!valid.ok) {
    throw new Error(valid.reason);
  }

  const now = input.now ?? input.override.createdAt ?? new Date().toISOString();
  const overrideRecord: OverrideRecord = {
    id: randomUUID(),
    pullRequestId: input.pullRequestId,
    evaluationId: input.evaluationId,
    actor: input.override.actor,
    actorRole: input.override.actorRole,
    reason: summarizeSafeSnippet(input.override.reason?.trim() ?? "No reason provided", 500),
    scope: input.override.scope,
    visibleInPr: input.override.visibleInPr ?? input.policy.visibleInPr,
    policyVersion: input.record.policyVersion,
    createdAt: now
  };

  const record: ChangeControlRecord = {
    ...input.record,
    checkStatus: "pass",
    lifecycle: "overridden",
    decision: {
      status: "override_approved",
      decidedAt: now,
      decidedBy: input.override.actor,
      overrideBy: input.override.actor,
      overrideReason: overrideRecord.reason
    },
    updatedAt: now
  };

  const auditEvent = input.policy.audit
    ? createAuditEvent({
        organizationId: input.record.organizationId,
        repositoryId: input.record.repositoryId,
        pullRequestId: input.pullRequestId,
        actor: overrideRecord.actor,
        action: "override_created",
        targetType: "change_control_record",
        targetId: input.record.id,
        metadataJson: {
          actorRole: overrideRecord.actorRole,
          reason: overrideRecord.reason,
          scope: overrideRecord.scope,
          policyVersion: overrideRecord.policyVersion,
          visibleInPr: overrideRecord.visibleInPr
        },
        createdAt: now
      })
    : undefined;

  return auditEvent ? { record, overrideRecord, auditEvent } : { record, overrideRecord };
}

export function sanitizeChangeControlRecord(
  record: ChangeControlRecord,
  storagePolicy?: MetadataStoragePolicy
): ChangeControlRecord {
  return sanitizeForMetadataStorage(redactObject(record), storagePolicy);
}

export function exportChangeControlRecordsJson(
  records: ChangeControlRecord[],
  storagePolicy?: MetadataStoragePolicy,
  auditEvents: AuditEventRecord[] = []
): string {
  return JSON.stringify(
    records.map((record) => ({
      ...sanitizeChangeControlRecord(record, storagePolicy),
      auditEvents: auditEvents
        .filter((event) => auditEventBelongsToRecord(event, record))
        .map((event) => sanitizeAuditEvent(event, storagePolicy))
    })),
    null,
    2
  );
}

export function exportChangeControlRecordsCsv(
  records: ChangeControlRecord[],
  storagePolicy?: MetadataStoragePolicy,
  auditEvents: AuditEventRecord[] = []
): string {
  const headers = [
    "id",
    "repositoryFullName",
    "pullRequestNumber",
    "headSha",
    "baseBranch",
    "mode",
    "policyVersion",
    "checkStatus",
    "lifecycle",
    "findingCount",
    "openEvidenceCount",
    "requiredReviewerCount",
    "findingsJson",
    "requiredEvidenceJson",
    "requiredReviewersJson",
    "auditEventsJson",
    "decisionStatus",
    "decisionJson",
    "decisionExplanation",
    "createdAt",
    "updatedAt"
  ];
  const rows = records.map((inputRecord) => {
    const record = sanitizeChangeControlRecord(inputRecord, storagePolicy);
    const recordAuditEvents = auditEvents
      .filter((event) => auditEventBelongsToRecord(event, inputRecord))
      .map((event) => sanitizeAuditEvent(event, storagePolicy));
    return [
      record.id,
      record.repositoryFullName,
      String(record.pullRequestNumber),
      record.headSha,
      record.baseBranch,
      record.mode,
      record.policyVersion,
      record.checkStatus,
      record.lifecycle,
      String(record.verifiedFindings.length),
      String(record.requiredEvidence.filter((item) => item.status !== "approved").length),
      String(record.requiredReviewers.filter((item) => item.tier === "required").length),
      JSON.stringify(record.verifiedFindings),
      JSON.stringify(record.requiredEvidence),
      JSON.stringify(record.requiredReviewers),
      JSON.stringify(recordAuditEvents),
      record.decision?.status ?? "",
      JSON.stringify(record.decision ?? {}),
      explainChangeControlRecord(record).join(" "),
      record.createdAt,
      record.updatedAt
    ];
  });

  return [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
}

export function createAuditEvent(input: {
  organizationId: string;
  repositoryId?: string | undefined;
  pullRequestId?: string | undefined;
  actor: string;
  actorRole?: string | undefined;
  action: AuditEventAction;
  targetType: string;
  targetId: string;
  source?: AuditEventRecord["source"] | undefined;
  requestId?: string | undefined;
  correlationId?: string | undefined;
  policyVersion?: string | undefined;
  policyPackId?: string | undefined;
  policyPackVersion?: string | undefined;
  metadataJson?: Record<string, unknown> | undefined;
  createdAt?: string | undefined;
}): AuditEventRecord {
  const metadata = input.metadataJson ? sanitizeForMetadataStorage(input.metadataJson) : {};
  const actorRole =
    stringFromMetadata(input.actorRole) ??
    stringFromMetadata(metadata.actorRole) ??
    (input.actor === "system" ? "system" : undefined);
  if (!actorRole) {
    throw new Error(`Audit event ${input.action} is missing required metadata fields: actorRole`);
  }
  const source =
    input.source ??
    auditSourceFromMetadata(metadata.source) ??
    (input.actor === "system" ? "worker" : "api");
  const policyVersion = input.policyVersion ?? stringFromMetadata(metadata.policyVersion);
  const policyPackId = input.policyPackId ?? stringFromMetadata(metadata.policyPackId);
  const policyPackVersion =
    input.policyPackVersion ?? stringFromMetadata(metadata.policyPackVersion);
  const requestId = input.requestId ?? stringFromMetadata(metadata.requestId);
  const correlationId = input.correlationId ?? stringFromMetadata(metadata.correlationId);
  const recordId =
    stringFromMetadata(metadata.recordId) ??
    (input.targetType === "change_control_record" ? input.targetId : undefined);

  const event: AuditEventRecord = {
    id: randomUUID(),
    schemaVersion: AUDIT_EVENT_SCHEMA_VERSION,
    organizationId: input.organizationId,
    actor: input.actor,
    actorRole,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    source,
    createdAt: input.createdAt ?? new Date().toISOString()
  };
  if (requestId) {
    event.requestId = requestId;
  }
  if (correlationId) {
    event.correlationId = correlationId;
  }
  if (policyVersion) {
    event.policyVersion = policyVersion;
  }
  if (policyPackId) {
    event.policyPackId = policyPackId;
  }
  if (policyPackVersion) {
    event.policyPackVersion = policyPackVersion;
  }
  if (input.repositoryId) {
    event.repositoryId = input.repositoryId;
  }
  if (input.pullRequestId) {
    event.pullRequestId = input.pullRequestId;
  }
  event.metadataJson = sanitizeForMetadataStorage({
    ...metadata,
    schemaVersion: AUDIT_EVENT_SCHEMA_VERSION,
    actorRole,
    source,
    ...(recordId ? { recordId } : {}),
    ...(requestId ? { requestId } : {}),
    ...(correlationId ? { correlationId } : {}),
    ...(policyVersion ? { policyVersion } : {}),
    ...(policyPackId ? { policyPackId } : {}),
    ...(policyPackVersion ? { policyPackVersion } : {})
  });
  const missing = missingAuditMetadataFields(event);
  if (missing.length > 0) {
    throw new Error(
      `Audit event ${event.action} is missing required metadata fields: ${missing.join(", ")}`
    );
  }
  return event;
}

export function sanitizeAuditEvent(
  event: AuditEventRecord,
  storagePolicy?: MetadataStoragePolicy
): AuditEventRecord {
  return sanitizeForMetadataStorage(redactObject(event), storagePolicy);
}

export function missingAuditMetadataFields(event: AuditEventRecord): string[] {
  const required = requiredAuditMetadataFields(event.action);
  const metadata = event.metadataJson ?? {};
  return required.filter((field) => {
    if (field in event) {
      const value = event[field as keyof AuditEventRecord];
      if (typeof value === "string") {
        return value.trim() === "";
      }
      return value === undefined || value === null;
    }
    const value = metadata[field];
    return value === undefined || value === null || value === "";
  });
}

export function requiredAuditMetadataFields(action: AuditEventAction): string[] {
  const common = ["schemaVersion", "actorRole", "source"];
  const fieldsByAction: Record<AuditEventAction, string[]> = {
    policy_changed: ["contentHash", "policyVersion"],
    override_created: ["reason", "scope", "policyVersion", "recordId"],
    evidence_provided: ["kind", "recordId"],
    evidence_approved: ["kind", "recordId"],
    evidence_rejected: ["kind", "reason", "recordId"],
    reviewer_approved: ["reviewer", "tier", "recordId"],
    record_reevaluated: ["previousStatus", "checkStatus", "lifecycle", "policyVersion", "recordId"],
    check_published: ["conclusion", "status", "mode", "policyVersion", "recordId"],
    record_exported: ["format", "recordCount"],
    retention_changed: ["dataHandling"],
    repository_settings_changed: ["enabled", "mode"],
    owner_mapping_changed: ["ownerMappings"]
  };
  return [...common, ...fieldsByAction[action]];
}

function auditEventBelongsToRecord(event: AuditEventRecord, record: ChangeControlRecord): boolean {
  const metadataRecordId = event.metadataJson && stringFromMetadata(event.metadataJson.recordId);
  const metadataRecordIds = metadataStringArray(event.metadataJson?.recordIds);
  return (
    event.targetId === record.id ||
    metadataRecordId === record.id ||
    metadataRecordIds.includes(record.id) ||
    (event.repositoryId === record.repositoryId &&
      isRepositoryLifecycleAuditEvent(event) &&
      event.createdAt <= record.updatedAt) ||
    (event.repositoryId === record.repositoryId &&
      stringFromMetadata(event.metadataJson?.headSha) === record.headSha)
  );
}

function isRepositoryLifecycleAuditEvent(event: AuditEventRecord): boolean {
  return (
    event.action === "policy_changed" ||
    event.action === "repository_settings_changed" ||
    event.action === "retention_changed" ||
    event.action === "owner_mapping_changed"
  );
}

function stringFromMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function metadataStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => stringFromMetadata(item) !== undefined)
    : [];
}

function auditSourceFromMetadata(value: unknown): AuditEventRecord["source"] | undefined {
  return value === "api" || value === "worker" || value === "webhook" || value === "system"
    ? value
    : undefined;
}

export function explainChangeControlRecord(record: ChangeControlRecord): string[] {
  const lines = [
    `Policy ${record.policyVersion} evaluated PR ${record.repositoryFullName}#${record.pullRequestNumber} in ${record.mode} mode.`
  ];
  const missingEvidence = record.requiredEvidence.filter((item) => item.status === "missing");
  const unapprovedEvidence = record.requiredEvidence.filter((item) => item.status === "provided");
  const rejectedEvidence = record.requiredEvidence.filter((item) => item.status === "rejected");
  const pendingReviewers = record.requiredReviewers.filter(
    (item) => item.tier === "required" && !item.approved
  );

  if (record.lifecycle === "overridden") {
    lines.push(
      `Authorized override recorded by ${record.decision?.overrideBy ?? record.decision?.decidedBy ?? "unknown actor"}.`
    );
    if (record.decision?.overrideReason) {
      lines.push(`Override reason: ${withSentencePeriod(record.decision.overrideReason)}`);
    }
    return lines;
  }

  if (record.decision?.status === "merged") {
    lines.push("Merge was recorded after configured policy requirements were satisfied.");
    return lines;
  }

  if (record.checkStatus === "block") {
    lines.push(
      "Merge Guard blocked merge because configured policy requirements are not satisfied."
    );
  } else if (record.checkStatus === "warn") {
    lines.push("Merge Guard warned because these findings would block in enforce mode.");
  } else {
    lines.push(
      "Merge Guard passed because configured policy requirements are satisfied for this mode."
    );
  }

  for (const item of missingEvidence) {
    lines.push(`Required evidence missing: ${humanize(item.kind)}.`);
  }
  for (const item of unapprovedEvidence) {
    lines.push(`Required evidence awaiting approval: ${humanize(item.kind)}.`);
  }
  for (const item of rejectedEvidence) {
    lines.push(`Required evidence rejected: ${humanize(item.kind)}.`);
  }
  for (const reviewer of pendingReviewers) {
    lines.push(`Reviewer approval required: ${reviewer.reviewer}.`);
  }
  if (
    missingEvidence.length === 0 &&
    unapprovedEvidence.length === 0 &&
    rejectedEvidence.length === 0 &&
    pendingReviewers.length === 0 &&
    record.checkStatus !== "block"
  ) {
    lines.push("No required evidence or required reviewer approval is pending.");
  }
  return lines;
}

function lifecycleForStatus(status: PolicyResult["status"]): ChangeControlRecord["lifecycle"] {
  if (status === "block") {
    return "blocked";
  }
  if (status === "warn") {
    return "warned";
  }
  return "passed";
}

function csvEscape(value: string): string {
  const safe = value.replace(/"/g, '""');
  return /[",\n\r]/.test(safe) ? `"${safe}"` : safe;
}

function humanize(value: string): string {
  return value.replace(/_/g, " ");
}

function withSentencePeriod(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}
