import { randomUUID } from "node:crypto";
import type {
  ChangeControlRecord,
  OverrideInput,
  OverridePolicy,
  OverrideRecord,
  PolicyResult,
  PullRequestInput
} from "@agentforge/core";
import { redactObject } from "@agentforge/security";

export function createChangeControlRecord(input: {
  organizationId: string;
  repositoryId: string;
  pr: PullRequestInput;
  policyResult: PolicyResult;
  now?: string;
}): ChangeControlRecord {
  const now = input.now ?? new Date().toISOString();
  return {
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
    verifiedFindings: redactObject(input.policyResult.findings),
    requiredEvidence: redactObject(input.policyResult.requiredEvidence),
    requiredReviewers: input.policyResult.requiredReviewers,
    checkStatus: input.policyResult.status,
    lifecycle: lifecycleForStatus(input.policyResult.status),
    decision: {
      status: input.policyResult.status === "block" ? "blocked" : "passed",
      decidedAt: input.policyResult.evaluatedAt
    },
    createdAt: now,
    updatedAt: now
  };
}

export function updateRecordFromPolicyResult(
  record: ChangeControlRecord,
  policyResult: PolicyResult,
  now = new Date().toISOString()
): ChangeControlRecord {
  return {
    ...record,
    mode: policyResult.mode,
    policyVersion: policyResult.policyVersion,
    policyPackId: policyResult.policyPackId,
    policyPackVersion: policyResult.policyPackVersion,
    verifiedFindings: redactObject(policyResult.findings),
    requiredEvidence: redactObject(policyResult.requiredEvidence),
    requiredReviewers: policyResult.requiredReviewers,
    checkStatus: policyResult.status,
    lifecycle: lifecycleForStatus(policyResult.status),
    decision: {
      ...record.decision,
      status: policyResult.status === "block" ? "blocked" : "passed",
      decidedAt: policyResult.evaluatedAt
    },
    updatedAt: now
  };
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
}): { record: ChangeControlRecord; overrideRecord: OverrideRecord } {
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
    reason: input.override.reason?.trim() ?? "No reason provided",
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

  return { record, overrideRecord };
}

export function exportChangeControlRecordsJson(records: ChangeControlRecord[]): string {
  return JSON.stringify(redactObject(records), null, 2);
}

export function exportChangeControlRecordsCsv(records: ChangeControlRecord[]): string {
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
    "decisionStatus",
    "createdAt",
    "updatedAt"
  ];
  const rows = records.map((record) => [
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
    record.decision?.status ?? "",
    record.createdAt,
    record.updatedAt
  ]);

  return [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
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
