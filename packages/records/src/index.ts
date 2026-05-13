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
      status: "merged_after_override",
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
  storagePolicy?: MetadataStoragePolicy
): string {
  return JSON.stringify(
    records.map((record) => sanitizeChangeControlRecord(record, storagePolicy)),
    null,
    2
  );
}

export function exportChangeControlRecordsCsv(
  records: ChangeControlRecord[],
  storagePolicy?: MetadataStoragePolicy
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
    "missingEvidenceCount",
    "requiredReviewerCount",
    "findingsJson",
    "requiredEvidenceJson",
    "requiredReviewersJson",
    "decisionStatus",
    "decisionJson",
    "decisionExplanation",
    "createdAt",
    "updatedAt"
  ];
  const rows = records.map((inputRecord) => {
    const record = sanitizeChangeControlRecord(inputRecord, storagePolicy);
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
      String(record.requiredEvidence.filter((item) => item.status === "missing").length),
      String(record.requiredReviewers.filter((item) => item.tier === "required").length),
      JSON.stringify(record.verifiedFindings),
      JSON.stringify(record.requiredEvidence),
      JSON.stringify(record.requiredReviewers),
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
  action: AuditEventAction;
  targetType: string;
  targetId: string;
  metadataJson?: Record<string, unknown> | undefined;
  createdAt?: string | undefined;
}): AuditEventRecord {
  const event: AuditEventRecord = {
    id: randomUUID(),
    organizationId: input.organizationId,
    actor: input.actor,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    createdAt: input.createdAt ?? new Date().toISOString()
  };
  if (input.repositoryId) {
    event.repositoryId = input.repositoryId;
  }
  if (input.pullRequestId) {
    event.pullRequestId = input.pullRequestId;
  }
  if (input.metadataJson) {
    event.metadataJson = sanitizeForMetadataStorage(input.metadataJson);
  }
  return event;
}

export function explainChangeControlRecord(record: ChangeControlRecord): string[] {
  const lines = [
    `Policy ${record.policyVersion} evaluated PR ${record.repositoryFullName}#${record.pullRequestNumber} in ${record.mode} mode.`
  ];
  const missingEvidence = record.requiredEvidence.filter((item) => item.status === "missing");
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
  for (const reviewer of pendingReviewers) {
    lines.push(`Reviewer approval required: ${reviewer.reviewer}.`);
  }
  if (
    missingEvidence.length === 0 &&
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
