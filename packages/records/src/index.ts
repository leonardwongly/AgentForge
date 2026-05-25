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

export type PolicyTuningInsight = {
  id: string;
  category:
    | "override_noise"
    | "evidence_quality"
    | "reviewer_routing"
    | "finding_noise"
    | "mode_transition";
  severity: "high" | "medium" | "low";
  title: string;
  recommendation: string;
  rationale: string;
  metric: {
    label: string;
    value: string;
    detail: string;
  };
  citations: PolicyTuningCitation[];
  guardrail: string;
};

export type PolicyTuningCitation = {
  recordId: string;
  repositoryFullName: string;
  pullRequestNumber: number;
  policyVersion: string;
  findingTypes: string[];
};

export type PolicyTuningReport = {
  generatedAt: string;
  recordCount: number;
  window: {
    oldestRecordAt?: string | undefined;
    newestRecordAt?: string | undefined;
  };
  metrics: {
    overrideRate: number;
    rejectedEvidenceRate: number;
    openEvidenceRate: number;
    pendingReviewerRate: number;
    medianReviewerApprovalHours?: number | undefined;
    observeOrWarnOpenRequirementCount: number;
  };
  insights: PolicyTuningInsight[];
};

export type ComplianceEvidencePackageFilters = {
  repositoryId?: string | undefined;
  policyPackId?: string | undefined;
  policyVersion?: string | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
  maxRecords?: number | undefined;
  offset?: number | undefined;
  totalMatchingRecords?: number | undefined;
  truncated?: boolean | undefined;
};

export type ComplianceEvidencePackage = {
  schemaVersion: 1;
  packageType: "compliance_evidence";
  manifest: {
    generatedAt: string;
    recordCount: number;
    repositoryCount: number;
    repositories: string[];
    policyVersions: string[];
    policyPacks: string[];
    controlFamilies: string[];
    filters: ComplianceEvidencePackageFilters;
    limitations: string[];
    redaction: {
      sourceCodeExcluded: true;
      rawPatchesExcluded: true;
      secretsRedacted: true;
      metadataOnly: true;
    };
  };
  controls: ComplianceControlMapping[];
  records: ComplianceRecordSummary[];
  timeline: ComplianceTimelineEvent[];
  redactionReport: ComplianceEvidencePackage["manifest"]["redaction"] & {
    summary: string;
    excludedFields: string[];
  };
};

export type ComplianceControlMapping = {
  controlFamily: string;
  title: string;
  rationale: string;
  recordIds: string[];
  repositoryFullNames: string[];
  findingTypes: string[];
  evidenceKinds: string[];
  reviewerRequirements: string[];
};

export type ComplianceRecordSummary = {
  recordId: string;
  organizationId: string;
  repositoryId: string;
  repositoryFullName: string;
  pullRequestNumber: number;
  headSha: string;
  baseBranch: string;
  mode: ChangeControlRecord["mode"];
  checkStatus: ChangeControlRecord["checkStatus"];
  lifecycle: ChangeControlRecord["lifecycle"];
  decision: ChangeControlRecord["decision"];
  policyVersion: string;
  policyPackId?: string | undefined;
  policyPackVersion?: string | undefined;
  controls: string[];
  findings: Array<{
    id: string;
    type: string;
    source: string;
    path?: string | undefined;
    confidence: string;
    severity?: string | undefined;
  }>;
  evidence: Array<{
    id: string;
    kind: string;
    status: string;
    source?: string | undefined;
    requiredByFindingId: string;
    providedBy?: string | undefined;
    providedAt?: string | undefined;
    approvedBy?: string | undefined;
    approvedAt?: string | undefined;
    contentSummary?: string | undefined;
  }>;
  reviewers: Array<{
    id: string;
    reviewer: string;
    reviewerType: string;
    tier: string;
    approved: boolean;
    approvedBy?: string | undefined;
    approvedAt?: string | undefined;
    triggeredByFindingId: string;
  }>;
  explanation: string[];
  createdAt: string;
  updatedAt: string;
};

export type ComplianceTimelineEvent = {
  eventId: string;
  createdAt: string;
  action: AuditEventAction;
  actor: string;
  actorRole: string;
  source: AuditEventRecord["source"];
  targetType: string;
  targetId: string;
  repositoryId?: string | undefined;
  pullRequestId?: string | undefined;
  requestId?: string | undefined;
  correlationId?: string | undefined;
  policyVersion?: string | undefined;
  policyPackId?: string | undefined;
  recordIds: string[];
  metadataJson: Record<string, unknown>;
};

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

export function generatePolicyTuningReport(
  records: ChangeControlRecord[],
  now = new Date().toISOString()
): PolicyTuningReport {
  const sorted = [...records].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const evidence = sorted.flatMap((record) => record.requiredEvidence);
  const reviewers = sorted.flatMap((record) => record.requiredReviewers);
  const overrides = sorted.filter((record) => record.lifecycle === "overridden");
  const rejectedEvidence = evidence.filter((item) => item.status === "rejected");
  const openEvidence = evidence.filter((item) => item.status !== "approved");
  const requiredReviewers = reviewers.filter((item) => item.tier === "required");
  const pendingReviewers = requiredReviewers.filter((item) => !item.approved);
  const reviewerApprovalHours = requiredReviewers
    .filter((item) => item.approvedAt)
    .map((item) =>
      hoursBetween(findRecordCreatedAt(sorted, item.triggeredByFindingId), item.approvedAt)
    )
    .filter((value): value is number => value !== undefined && Number.isFinite(value));
  const observeOrWarnOpenRequirementRecords = sorted.filter(
    (record) =>
      (record.mode === "observe" || record.mode === "warn") &&
      (record.requiredEvidence.some((item) => item.status !== "approved") ||
        record.requiredReviewers.some((item) => item.tier === "required" && !item.approved))
  );
  const metrics = {
    overrideRate: percent(overrides.length, sorted.length),
    rejectedEvidenceRate: percent(rejectedEvidence.length, evidence.length),
    openEvidenceRate: percent(openEvidence.length, evidence.length),
    pendingReviewerRate: percent(pendingReviewers.length, requiredReviewers.length),
    medianReviewerApprovalHours: median(reviewerApprovalHours),
    observeOrWarnOpenRequirementCount: observeOrWarnOpenRequirementRecords.length
  };
  return {
    generatedAt: now,
    recordCount: sorted.length,
    window: {
      oldestRecordAt: sorted.at(-1)?.updatedAt,
      newestRecordAt: sorted[0]?.updatedAt
    },
    metrics,
    insights: [
      overrideNoiseInsight(sorted, overrides, metrics.overrideRate),
      evidenceQualityInsight(sorted, rejectedEvidence, openEvidence, metrics),
      reviewerRoutingInsight(sorted, pendingReviewers, metrics),
      repeatedFindingInsight(sorted),
      modeTransitionInsight(observeOrWarnOpenRequirementRecords)
    ]
      .filter((insight): insight is PolicyTuningInsight => Boolean(insight))
      .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
  };
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

export function createComplianceEvidencePackage(input: {
  records: ChangeControlRecord[];
  storagePolicy?: MetadataStoragePolicy | undefined;
  auditEvents?: AuditEventRecord[] | undefined;
  generatedAt?: string | undefined;
  filters?: ComplianceEvidencePackageFilters | undefined;
}): ComplianceEvidencePackage {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const records = input.records
    .map((record) => sanitizeChangeControlRecord(record, input.storagePolicy))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const controls = complianceControlsForRecords(records);
  const timeline = complianceTimelineForRecords(
    records,
    input.auditEvents ?? [],
    input.storagePolicy
  );
  const repositories = [...new Set(records.map((record) => record.repositoryFullName))].sort();
  const policyVersions = [...new Set(records.map((record) => record.policyVersion))].sort();
  const policyPacks = [
    ...new Set(
      records.map((record) => record.policyPackId).filter((value): value is string => !!value)
    )
  ].sort();
  const controlFamilies = controls.map((control) => control.controlFamily).sort();
  const redaction = {
    sourceCodeExcluded: true,
    rawPatchesExcluded: true,
    secretsRedacted: true,
    metadataOnly: true
  } as const;

  return {
    schemaVersion: 1,
    packageType: "compliance_evidence",
    manifest: {
      generatedAt,
      recordCount: records.length,
      repositoryCount: repositories.length,
      repositories,
      policyVersions,
      policyPacks,
      controlFamilies,
      filters: input.filters ?? {},
      limitations: [
        "Point-in-time export generated from retained Change Control Records and audit events.",
        "Source code, raw patches, credentials, tokens, and private keys are intentionally excluded.",
        "Control mappings are deterministic governance aids and still require human auditor review."
      ],
      redaction
    },
    controls,
    records: records.map((record) => complianceRecordSummary(record)),
    timeline,
    redactionReport: {
      ...redaction,
      summary:
        "Compliance packages include sanitized metadata, decision state, evidence state, reviewer state, and audit events only.",
      excludedFields: [
        "raw diff hunks",
        "previous file bodies",
        "current file bodies",
        "secrets",
        "tokens",
        "privateKeys"
      ]
    }
  };
}

export function exportComplianceEvidencePackageJson(input: {
  records: ChangeControlRecord[];
  storagePolicy?: MetadataStoragePolicy | undefined;
  auditEvents?: AuditEventRecord[] | undefined;
  generatedAt?: string | undefined;
  filters?: ComplianceEvidencePackageFilters | undefined;
}): string {
  return JSON.stringify(createComplianceEvidencePackage(input), null, 2);
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
    webhook_replayed: ["deliveryId", "replayJobId"],
    github_installation_verification_recorded: ["githubInstallationId", "accountLogin", "status"],
    github_installation_approved: ["githubInstallationId", "accountLogin"],
    github_installation_rejected: ["githubInstallationId", "accountLogin"],
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

function complianceRecordSummary(record: ChangeControlRecord): ComplianceRecordSummary {
  return {
    recordId: record.id,
    organizationId: record.organizationId,
    repositoryId: record.repositoryId,
    repositoryFullName: record.repositoryFullName,
    pullRequestNumber: record.pullRequestNumber,
    headSha: record.headSha,
    baseBranch: record.baseBranch,
    mode: record.mode,
    checkStatus: record.checkStatus,
    lifecycle: record.lifecycle,
    decision: record.decision,
    policyVersion: record.policyVersion,
    policyPackId: record.policyPackId,
    policyPackVersion: record.policyPackVersion,
    controls: complianceControlFamiliesForRecord(record).sort(),
    findings: record.verifiedFindings.map((finding) => ({
      id: finding.id,
      type: finding.type,
      source: finding.source,
      path: finding.path,
      confidence: finding.confidence,
      severity: finding.severity
    })),
    evidence: record.requiredEvidence.map((item) => ({
      id: item.id,
      kind: item.kind,
      status: item.status,
      source: item.source,
      requiredByFindingId: item.requiredByFindingId,
      providedBy: item.providedBy,
      providedAt: item.providedAt,
      approvedBy: item.approvedBy,
      approvedAt: item.approvedAt,
      contentSummary: item.contentSummary
    })),
    reviewers: record.requiredReviewers.map((reviewer) => ({
      id: reviewer.id,
      reviewer: reviewer.reviewer,
      reviewerType: reviewer.reviewerType,
      tier: reviewer.tier,
      approved: reviewer.approved,
      approvedBy: reviewer.approvedBy,
      approvedAt: reviewer.approvedAt,
      triggeredByFindingId: reviewer.triggeredByFindingId
    })),
    explanation: explainChangeControlRecord(record),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function complianceControlsForRecords(records: ChangeControlRecord[]): ComplianceControlMapping[] {
  const byControl = new Map<string, ChangeControlRecord[]>();
  for (const record of records) {
    for (const control of complianceControlFamiliesForRecord(record)) {
      byControl.set(control, [...(byControl.get(control) ?? []), record]);
    }
  }
  return [...byControl.entries()]
    .map(([controlFamily, affectedRecords]) => {
      const uniqueAffectedRecords = uniqueRecords(affectedRecords);
      return {
        controlFamily,
        title: complianceControlTitle(controlFamily),
        rationale: complianceControlRationale(controlFamily),
        recordIds: uniqueAffectedRecords.map((record) => record.id),
        repositoryFullNames: [
          ...new Set(uniqueAffectedRecords.map((record) => record.repositoryFullName))
        ].sort(),
        findingTypes: [
          ...new Set(
            uniqueAffectedRecords.flatMap((record) =>
              record.verifiedFindings.map((finding) => finding.type)
            )
          )
        ].sort(),
        evidenceKinds: [
          ...new Set(
            uniqueAffectedRecords.flatMap((record) =>
              record.requiredEvidence.map((item) => item.kind)
            )
          )
        ].sort(),
        reviewerRequirements: [
          ...new Set(
            uniqueAffectedRecords.flatMap((record) =>
              record.requiredReviewers.map((reviewer) => reviewer.reviewer)
            )
          )
        ].sort()
      };
    })
    .sort((a, b) => a.controlFamily.localeCompare(b.controlFamily));
}

function complianceControlFamiliesForRecord(record: ChangeControlRecord): string[] {
  const controls = new Set<string>(["SOC2_CC8_CHANGE_MANAGEMENT"]);
  const findingTypes = new Set(record.verifiedFindings.map((finding) => finding.type));
  const evidenceKinds = new Set(record.requiredEvidence.map((item) => item.kind));
  const reviewers = record.requiredReviewers.map((reviewer) => reviewer.reviewer.toLowerCase());
  if (
    findingTypes.has("secret_like_value_detected") ||
    findingTypes.has("sensitive_path_changed") ||
    evidenceKinds.has("security_note") ||
    reviewers.some((reviewer) => reviewer.includes("security"))
  ) {
    controls.add("SOC2_CC6_ACCESS_CONTROL");
    controls.add("SOC2_CC7_SECURITY_MONITORING");
  }
  if (
    findingTypes.has("dependency_added") ||
    findingTypes.has("dependency_bumped") ||
    evidenceKinds.has("dependency_justification")
  ) {
    controls.add("SOC2_CC8_CHANGE_MANAGEMENT");
    controls.add("PCI_DSS_6_SECURE_DEVELOPMENT");
  }
  if (
    findingTypes.has("ci_workflow_changed") ||
    findingTypes.has("test_deleted") ||
    findingTypes.has("test_skipped") ||
    findingTypes.has("coverage_threshold_reduced") ||
    findingTypes.has("suspicious_test_change") ||
    evidenceKinds.has("ci_change_reason") ||
    evidenceKinds.has("benchmark_before_after")
  ) {
    controls.add("SDLC_TESTING_ASSURANCE");
  }
  if (
    findingTypes.has("migration_added") ||
    evidenceKinds.has("migration_dry_run") ||
    evidenceKinds.has("rollback_plan")
  ) {
    controls.add("DEPLOYMENT_ROLLBACK_READINESS");
  }
  if (
    record.lifecycle === "overridden" ||
    record.decision?.status === "override_approved" ||
    record.decision?.status === "merged_after_override"
  ) {
    controls.add("EXCEPTION_MANAGEMENT");
  }
  if (findingTypes.has("agent_signal_detected") || evidenceKinds.has("manual_attestation")) {
    controls.add("HUMAN_APPROVAL_GOVERNANCE");
  }
  if (record.policyPackId?.includes("regulated")) {
    controls.add("REGULATED_WORKLOAD_GOVERNANCE");
  }
  if (record.policyPackId?.includes("fintech")) {
    controls.add("PCI_DSS_6_SECURE_DEVELOPMENT");
  }
  return [...controls];
}

function complianceControlTitle(controlFamily: string): string {
  const titles: Record<string, string> = {
    DEPLOYMENT_ROLLBACK_READINESS: "Deployment rollback readiness",
    EXCEPTION_MANAGEMENT: "Exception and override management",
    HUMAN_APPROVAL_GOVERNANCE: "Human approval governance",
    PCI_DSS_6_SECURE_DEVELOPMENT: "Secure development controls",
    REGULATED_WORKLOAD_GOVERNANCE: "Regulated workload governance",
    SDLC_TESTING_ASSURANCE: "SDLC testing assurance",
    SOC2_CC6_ACCESS_CONTROL: "Logical access and security review",
    SOC2_CC7_SECURITY_MONITORING: "Security monitoring and response",
    SOC2_CC8_CHANGE_MANAGEMENT: "Change management"
  };
  return titles[controlFamily] ?? humanize(controlFamily).toUpperCase();
}

function complianceControlRationale(controlFamily: string): string {
  const rationales: Record<string, string> = {
    DEPLOYMENT_ROLLBACK_READINESS:
      "Migration, rollback, or deployment evidence shows the change was reviewed for recoverability.",
    EXCEPTION_MANAGEMENT:
      "Override and merged-after-override decisions require traceable human authorization.",
    HUMAN_APPROVAL_GOVERNANCE:
      "Agent-assisted or manually attested changes require explicit human review evidence.",
    PCI_DSS_6_SECURE_DEVELOPMENT:
      "Dependency and fintech-related findings map to secure development and vulnerability management review.",
    REGULATED_WORKLOAD_GOVERNANCE:
      "Regulated policy packs require stronger auditability across findings, evidence, and approvals.",
    SDLC_TESTING_ASSURANCE:
      "CI, test, benchmark, and coverage findings map to software delivery assurance controls.",
    SOC2_CC6_ACCESS_CONTROL:
      "Sensitive paths, secrets, or security reviewers map to logical access control review.",
    SOC2_CC7_SECURITY_MONITORING:
      "Security-sensitive findings and required security evidence map to detection and response controls.",
    SOC2_CC8_CHANGE_MANAGEMENT:
      "Every evaluated pull request is a governed production change candidate."
  };
  return rationales[controlFamily] ?? "Mapped from deterministic AgentForge record metadata.";
}

function complianceTimelineForRecords(
  records: ChangeControlRecord[],
  auditEvents: AuditEventRecord[],
  storagePolicy?: MetadataStoragePolicy
): ComplianceTimelineEvent[] {
  return auditEvents
    .filter((event) => records.some((record) => auditEventBelongsToRecord(event, record)))
    .map((event) => {
      const sanitized = sanitizeAuditEvent(event, storagePolicy);
      return {
        eventId: sanitized.id,
        createdAt: sanitized.createdAt,
        action: sanitized.action,
        actor: sanitized.actor,
        actorRole: sanitized.actorRole,
        source: sanitized.source,
        targetType: sanitized.targetType,
        targetId: sanitized.targetId,
        repositoryId: sanitized.repositoryId,
        pullRequestId: sanitized.pullRequestId,
        requestId: sanitized.requestId,
        correlationId: sanitized.correlationId,
        policyVersion: sanitized.policyVersion,
        policyPackId: sanitized.policyPackId,
        recordIds: records
          .filter((record) => auditEventBelongsToRecord(sanitized, record))
          .map((record) => record.id),
        metadataJson: sanitized.metadataJson ?? {}
      };
    })
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
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

function overrideNoiseInsight(
  records: ChangeControlRecord[],
  overrides: ChangeControlRecord[],
  overrideRate: number
): PolicyTuningInsight | undefined {
  if (overrides.length < 2 || overrideRate < 20) {
    return undefined;
  }
  const policy = mostFrequent(overrides.map((record) => record.policyVersion));
  return {
    id: "override-noise",
    category: "override_noise",
    severity: overrideRate >= 40 ? "high" : "medium",
    title: "Review high override concentration",
    recommendation:
      "Inspect the cited records before changing policy. If the overrides are legitimate false positives, narrow the triggering rule scope or move the rule to warn mode for this repository.",
    rationale: `${overrides.length} of ${records.length} evaluated records ended with an authorized override, concentrated on policy ${policy ?? "unknown"}.`,
    metric: {
      label: "Override rate",
      value: `${overrideRate}%`,
      detail: "Share of evaluated records that required authorized override."
    },
    citations: citationsFor(overrides),
    guardrail: advisoryGuardrail()
  };
}

function evidenceQualityInsight(
  records: ChangeControlRecord[],
  rejectedEvidence: ChangeControlRecord["requiredEvidence"],
  openEvidence: ChangeControlRecord["requiredEvidence"],
  metrics: PolicyTuningReport["metrics"]
): PolicyTuningInsight | undefined {
  if (rejectedEvidence.length === 0 && metrics.openEvidenceRate < 30) {
    return undefined;
  }
  const affectedRecords = records.filter((record) =>
    record.requiredEvidence.some((item) => item.status === "rejected" || item.status === "missing")
  );
  return {
    id: "evidence-quality",
    category: "evidence_quality",
    severity: rejectedEvidence.length > 0 ? "high" : "medium",
    title: "Improve evidence instructions for recurring gaps",
    recommendation:
      "Add clearer evidence examples to the policy pack or repository runbook before tightening enforcement. Prioritize rejected evidence kinds first.",
    rationale: `${metrics.openEvidenceRate}% of required evidence is still open and ${metrics.rejectedEvidenceRate}% was rejected.`,
    metric: {
      label: "Open evidence",
      value: `${openEvidence.length}`,
      detail: "Evidence items that are missing, provided but unapproved, or rejected."
    },
    citations: citationsFor(affectedRecords),
    guardrail: advisoryGuardrail()
  };
}

function reviewerRoutingInsight(
  records: ChangeControlRecord[],
  pendingReviewers: ChangeControlRecord["requiredReviewers"],
  metrics: PolicyTuningReport["metrics"]
): PolicyTuningInsight | undefined {
  const slowReview = (metrics.medianReviewerApprovalHours ?? 0) >= 48;
  if (pendingReviewers.length < 2 && !slowReview) {
    return undefined;
  }
  const affectedRecords = records.filter((record) =>
    record.requiredReviewers.some((item) => item.tier === "required" && !item.approved)
  );
  return {
    id: "reviewer-routing",
    category: "reviewer_routing",
    severity: metrics.pendingReviewerRate >= 40 || slowReview ? "high" : "medium",
    title: "Tune reviewer routing and fallback coverage",
    recommendation:
      "Review owner mappings and add fallback teams for the cited paths or policy rules. Keep required reviewers deterministic and human-approved.",
    rationale:
      metrics.medianReviewerApprovalHours === undefined
        ? `${metrics.pendingReviewerRate}% of required reviewer requirements remain pending.`
        : `${metrics.pendingReviewerRate}% of required reviewer requirements remain pending; median approval latency is ${metrics.medianReviewerApprovalHours} hours.`,
    metric: {
      label: "Pending reviewers",
      value: `${pendingReviewers.length}`,
      detail: "Required reviewer requirements that are not yet approved."
    },
    citations: citationsFor(affectedRecords),
    guardrail: advisoryGuardrail()
  };
}

function repeatedFindingInsight(records: ChangeControlRecord[]): PolicyTuningInsight | undefined {
  const findings = records.flatMap((record) =>
    record.verifiedFindings
      .filter((finding) => finding.type !== "agent_signal_detected")
      .map((finding) => ({ record, type: finding.type }))
  );
  const byType = new Map<string, ChangeControlRecord[]>();
  for (const finding of findings) {
    byType.set(finding.type, [...(byType.get(finding.type) ?? []), finding.record]);
  }
  const noisy = [...byType.entries()]
    .map(([type, affected]) => ({ type, affected: uniqueRecords(affected) }))
    .filter((item) => item.affected.length >= 3)
    .sort((a, b) => b.affected.length - a.affected.length)[0];
  if (!noisy) {
    return undefined;
  }
  return {
    id: `finding-noise-${noisy.type}`,
    category: "finding_noise",
    severity: noisy.affected.length >= 5 ? "high" : "medium",
    title: `Review repeated ${humanize(noisy.type)} findings`,
    recommendation:
      "Compare cited records for legitimate risk versus noisy matching. If the same finding repeats without useful governance action, narrow the detector path scope or add repository-specific policy exceptions.",
    rationale: `${noisy.affected.length} records cite ${humanize(noisy.type)}.`,
    metric: {
      label: "Repeated finding",
      value: String(noisy.affected.length),
      detail: humanize(noisy.type)
    },
    citations: citationsFor(noisy.affected),
    guardrail: advisoryGuardrail()
  };
}

function modeTransitionInsight(records: ChangeControlRecord[]): PolicyTuningInsight | undefined {
  if (records.length < 2) {
    return undefined;
  }
  return {
    id: "mode-transition-readiness",
    category: "mode_transition",
    severity: "low",
    title: "Use open requirements before changing enforcement mode",
    recommendation:
      "Resolve the cited observe/warn requirements before moving rules to enforce. Use policy preview to compare proposed YAML before a platform admin saves changes.",
    rationale: `${records.length} observe or warn records still have open evidence or required-reviewer requirements.`,
    metric: {
      label: "Open observe/warn records",
      value: String(records.length),
      detail: "Records that should be cleaned up before mode escalation."
    },
    citations: citationsFor(records),
    guardrail: advisoryGuardrail()
  };
}

function citationsFor(records: ChangeControlRecord[], limit = 5): PolicyTuningCitation[] {
  return uniqueRecords(records)
    .slice(0, limit)
    .map((record) => ({
      recordId: record.id,
      repositoryFullName: record.repositoryFullName,
      pullRequestNumber: record.pullRequestNumber,
      policyVersion: record.policyVersion,
      findingTypes: [...new Set(record.verifiedFindings.map((finding) => finding.type))].slice(0, 5)
    }));
}

function uniqueRecords(records: ChangeControlRecord[]): ChangeControlRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    if (seen.has(record.id)) {
      return false;
    }
    seen.add(record.id);
    return true;
  });
}

function findRecordCreatedAt(
  records: ChangeControlRecord[],
  findingId: string
): string | undefined {
  return records.find((record) =>
    record.verifiedFindings.some((finding) => finding.id === findingId)
  )?.createdAt;
}

function hoursBetween(start: string | undefined, end: string | undefined): number | undefined {
  if (!start || !end) {
    return undefined;
  }
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 36_000) / 100 : undefined;
}

function percent(part: number, total: number): number {
  return total === 0 ? 0 : Math.round((part / total) * 100);
}

function median(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : sorted[middle];
  return Math.round((value ?? 0) * 100) / 100;
}

function mostFrequent(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function severityRank(value: PolicyTuningInsight["severity"]): number {
  return { high: 0, medium: 1, low: 2 }[value];
}

function advisoryGuardrail(): string {
  return "Advisory only: this insight cannot block, unblock, or mutate policy without an explicit authorized platform-admin action.";
}

function csvEscape(value: string): string {
  const formulaSafe = /^[\s]*[=+\-@]/u.test(value) || /^[\t\r]/u.test(value) ? `'${value}` : value;
  const safe = formulaSafe.replace(/"/g, '""');
  return /[",\n\r]/.test(safe) ? `"${safe}"` : safe;
}

function humanize(value: string): string {
  return value.replace(/_/g, " ");
}

function withSentencePeriod(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}
