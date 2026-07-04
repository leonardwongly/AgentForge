// Pure retention-sweep primitives for AuditEvent, ChangeControlRecord,
// ExportJob, and WebhookDelivery rows.
//
// This module intentionally contains no I/O: it only computes cutoff dates and
// shapes the query filters a caller (the worker's Prisma-backed sweep) should
// use to find rows that are strictly older than the organization's configured
// retention window. Keeping this pure mirrors the existing convention in this
// package (createChangeControlRecord, createAuditEvent, etc. are all pure
// functions that a caller wires up to persistence), and lets the boundary
// between "what should be deleted" and "how it is deleted" be tested
// independently of a live database.
//
// Retention conventionally means rows strictly older than the cutoff are no
// longer retained. All four models here are hard-deleted (not soft-deleted or
// archived) once past the cutoff; see the module-level note in apps/worker's
// retention-sweep caller for why archiving was not chosen for
// AuditEvent/ChangeControlRecord and why that choice may warrant explicit
// product sign-off, and see the note further below in this file for why
// ExportJob/WebhookDelivery follow the same hard-delete choice.

export const DEFAULT_AUDIT_RECORD_RETENTION_DAYS = 365;

/**
 * Resolves the effective retention window (in days) for an organization.
 *
 * Per-organization overrides (`RetentionSetting.auditRecordRetentionDays`) take
 * precedence over the global `AUDIT_RECORD_RETENTION_DAYS` config value when
 * present, matching how `RetentionSetting` already overrides
 * `sourceCodeStorage`/`fullDiffRetention`/`redactSecrets`/`llmFeatures` for
 * dashboard-facing data-handling settings (see `defaultDataHandling` in
 * apps/api/src/app.ts). A missing or non-positive override falls back to the
 * global value so a zeroed-out or absent per-org row can never disable
 * retention entirely.
 */
export function resolveAuditRecordRetentionDays(input: {
  globalRetentionDays: number;
  organizationOverrideDays?: number | null | undefined;
}): number {
  const override = input.organizationOverrideDays;
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  return input.globalRetentionDays;
}

/**
 * Computes the cutoff Date for a retention window: rows with a timestamp
 * strictly before this value are outside the retention window and are sweep
 * targets. Rows with a timestamp at or after this value are within the
 * window and must be preserved.
 */
export function computeRetentionCutoff(input: {
  retentionDays: number;
  now?: Date | undefined;
}): Date {
  const now = input.now ?? new Date();
  const cutoffMs = now.getTime() - input.retentionDays * 24 * 60 * 60 * 1000;
  return new Date(cutoffMs);
}

export type AuditRecordRetentionSweepPlan = {
  organizationId: string;
  retentionDays: number;
  cutoff: Date;
  /** Prisma `where` filter for AuditEvent rows this org's sweep should delete. */
  auditEventWhere: {
    organizationId: string;
    createdAt: { lt: Date };
  };
  /**
   * Prisma `where` filter for ChangeControlRecord rows this org's sweep should
   * delete. ChangeControlRecord has no direct organizationId column; it is
   * reached through pullRequestId -> PullRequest -> Repository.organizationId,
   * so the filter is expressed as a relation filter rather than a flat column
   * match.
   */
  changeControlRecordWhere: {
    updatedAt: { lt: Date };
    pullRequest: {
      repository: {
        organizationId: string;
      };
    };
  };
};

/**
 * Builds the per-organization sweep plan: the resolved retention window, the
 * cutoff Date, and the exact Prisma `where` filters to use for deleting
 * AuditEvent and ChangeControlRecord rows for that organization. Building this
 * as a pure plan (rather than issuing the delete directly) is what allows the
 * cutoff-and-filter-construction logic to be unit tested without a live
 * database, per the task's testing requirement.
 */
export function planAuditRecordRetentionSweep(input: {
  organizationId: string;
  globalRetentionDays: number;
  organizationOverrideDays?: number | null | undefined;
  now?: Date | undefined;
}): AuditRecordRetentionSweepPlan {
  const retentionDays = resolveAuditRecordRetentionDays({
    globalRetentionDays: input.globalRetentionDays,
    organizationOverrideDays: input.organizationOverrideDays
  });
  const cutoff = computeRetentionCutoff({
    retentionDays,
    now: input.now
  });
  return {
    organizationId: input.organizationId,
    retentionDays,
    cutoff,
    auditEventWhere: {
      organizationId: input.organizationId,
      createdAt: { lt: cutoff }
    },
    changeControlRecordWhere: {
      updatedAt: { lt: cutoff },
      pullRequest: {
        repository: {
          organizationId: input.organizationId
        }
      }
    }
  };
}

/**
 * Pure predicate mirroring `auditEventWhere`/`changeControlRecordWhere` above,
 * for a single row's timestamp. Used by tests (and available to callers) to
 * assert a specific row would or would not be targeted by a given plan without
 * constructing a full Prisma query.
 */
export function isOlderThanRetentionCutoff(timestamp: Date | string, cutoff: Date): boolean {
  const ms = typeof timestamp === "string" ? Date.parse(timestamp) : timestamp.getTime();
  return ms < cutoff.getTime();
}

export type AuditRecordRetentionSweepResult = {
  organizationId: string;
  retentionDays: number;
  cutoff: string;
  auditEventsDeleted: number;
  changeControlRecordsDeleted: number;
  /**
   * Count of this organization's ExportJob rows deleted by this sweep pass.
   * Present alongside auditEventsDeleted/changeControlRecordsDeleted (rather
   * than as a separate result type) because all four models are swept for
   * the same organization, at the same cutoff, in the same pass -- one
   * organization-scoped sweep naturally produces one summary. See the
   * module-level note above `planExportJobRetentionSweep` for why
   * null-organizationId rows are represented by a different result type
   * instead of being folded into this one.
   */
  exportJobsDeleted: number;
  /** Count of this organization's WebhookDelivery rows deleted by this sweep pass. */
  webhookDeliveriesDeleted: number;
};

/**
 * Summarizes the outcome of executing a sweep plan for a single organization.
 * Pure aggregation only; the actual delete counts are supplied by the caller
 * after it executes the Prisma deletes described by the plan.
 */
export function summarizeAuditRecordRetentionSweep(input: {
  plan: AuditRecordRetentionSweepPlan;
  auditEventsDeleted: number;
  changeControlRecordsDeleted: number;
  exportJobsDeleted: number;
  webhookDeliveriesDeleted: number;
}): AuditRecordRetentionSweepResult {
  return {
    organizationId: input.plan.organizationId,
    retentionDays: input.plan.retentionDays,
    cutoff: input.plan.cutoff.toISOString(),
    auditEventsDeleted: input.auditEventsDeleted,
    changeControlRecordsDeleted: input.changeControlRecordsDeleted,
    exportJobsDeleted: input.exportJobsDeleted,
    webhookDeliveriesDeleted: input.webhookDeliveriesDeleted
  };
}

// --- ExportJob / WebhookDelivery retention sweep ---
//
// Unlike AuditEvent (organizationId required) and ChangeControlRecord (reached
// through a non-nullable relation chain to Repository.organizationId), both
// `WebhookDelivery.organizationId` and `ExportJob.organizationId` are nullable
// in the schema (see packages/db/prisma/schema.prisma). A webhook delivery can
// arrive, and an export job can theoretically be requested, before a GitHub
// installation has been approved and linked to an organization -- that row
// has no organization to resolve a per-org retention override against.
//
// This module therefore models two independent sweep targets for each of
// these two models:
//   1. Per-organization rows (organizationId set): swept using that
//      organization's resolved retention window, exactly like AuditEvent and
//      ChangeControlRecord above. See `planExportJobRetentionSweep` and
//      `planWebhookDeliveryRetentionSweep`.
//   2. Unassigned rows (organizationId null): swept using the *global*
//      retention window directly, since there is no organization-specific
//      override to look up. See `planUnassignedRetentionSweep`.
//
// Both models use `createdAt` as the retention clock (matching how AuditEvent
// uses createdAt), rather than a terminal-state timestamp such as
// WebhookDelivery.completedAt/processingStartedAt. `createdAt` is the only
// timestamp guaranteed to be non-null for every row of both models --
// ExportJob has no other timestamp field at all, and a WebhookDelivery that
// never finished processing (crashed job, permanently failed delivery) would
// have a null completedAt/processingStartedAt forever, which would either
// exclude it from every sweep (leaking indefinitely) or require separate
// null-timestamp handling. Anchoring retention to "how long ago this row was
// received/created" avoids that failure mode and matches the intuitive
// meaning of a retention window for delivery/export records.
//
// Both models are hard-deleted for the same reason AuditEvent/ChangeControlRecord
// are: retention is meant to reduce what is retained, and these two models are
// lower-sensitivity than the audit trail (ExportJob.content and
// WebhookDelivery.payloadJson are already subject to this codebase's existing
// redaction/metadata-only storage policy before being persisted at all -- see
// @agentforge/security's sanitizeForMetadataStorage), so no distinct
// archive/soft-delete pattern is introduced here. See this package's task
// history / apps/worker's retention-sweep caller for the AuditEvent hard-delete
// rationale and product-sign-off note, which applies equally here.

export type ExportJobRetentionSweepPlan = {
  organizationId: string;
  retentionDays: number;
  cutoff: Date;
  /** Prisma `where` filter for this organization's expired ExportJob rows. */
  exportJobWhere: {
    organizationId: string;
    createdAt: { lt: Date };
  };
};

export type WebhookDeliveryRetentionSweepPlan = {
  organizationId: string;
  retentionDays: number;
  cutoff: Date;
  /** Prisma `where` filter for this organization's expired WebhookDelivery rows. */
  webhookDeliveryWhere: {
    organizationId: string;
    createdAt: { lt: Date };
  };
};

/**
 * Builds the per-organization ExportJob sweep plan, using the same resolved
 * retention window (global value or organization override) as
 * `planAuditRecordRetentionSweep`.
 */
export function planExportJobRetentionSweep(input: {
  organizationId: string;
  globalRetentionDays: number;
  organizationOverrideDays?: number | null | undefined;
  now?: Date | undefined;
}): ExportJobRetentionSweepPlan {
  const retentionDays = resolveAuditRecordRetentionDays({
    globalRetentionDays: input.globalRetentionDays,
    organizationOverrideDays: input.organizationOverrideDays
  });
  const cutoff = computeRetentionCutoff({ retentionDays, now: input.now });
  return {
    organizationId: input.organizationId,
    retentionDays,
    cutoff,
    exportJobWhere: {
      organizationId: input.organizationId,
      createdAt: { lt: cutoff }
    }
  };
}

/**
 * Builds the per-organization WebhookDelivery sweep plan, using the same
 * resolved retention window (global value or organization override) as
 * `planAuditRecordRetentionSweep`.
 */
export function planWebhookDeliveryRetentionSweep(input: {
  organizationId: string;
  globalRetentionDays: number;
  organizationOverrideDays?: number | null | undefined;
  now?: Date | undefined;
}): WebhookDeliveryRetentionSweepPlan {
  const retentionDays = resolveAuditRecordRetentionDays({
    globalRetentionDays: input.globalRetentionDays,
    organizationOverrideDays: input.organizationOverrideDays
  });
  const cutoff = computeRetentionCutoff({ retentionDays, now: input.now });
  return {
    organizationId: input.organizationId,
    retentionDays,
    cutoff,
    webhookDeliveryWhere: {
      organizationId: input.organizationId,
      createdAt: { lt: cutoff }
    }
  };
}

export type UnassignedRetentionSweepPlan = {
  retentionDays: number;
  cutoff: Date;
  /**
   * Prisma `where` filter for ExportJob rows with no organizationId, past the
   * global retention cutoff. `organizationId: null` is included explicitly
   * (rather than left as an unstated assumption) so this filter can never
   * accidentally widen to match rows that do have an organization -- it is
   * intersected with the per-organization plans above, never a superset of
   * them.
   */
  exportJobWhere: {
    organizationId: null;
    createdAt: { lt: Date };
  };
  /** Prisma `where` filter for organizationId-null WebhookDelivery rows past the global retention cutoff. */
  webhookDeliveryWhere: {
    organizationId: null;
    createdAt: { lt: Date };
  };
};

/**
 * Builds the sweep plan for ExportJob/WebhookDelivery rows that have no
 * organizationId. These rows have no per-organization override to resolve,
 * so this plan always uses the global retention window directly -- there is
 * deliberately no `organizationOverrideDays` parameter here, unlike the
 * per-organization plan builders above.
 */
export function planUnassignedRetentionSweep(input: {
  globalRetentionDays: number;
  now?: Date | undefined;
}): UnassignedRetentionSweepPlan {
  const cutoff = computeRetentionCutoff({
    retentionDays: input.globalRetentionDays,
    now: input.now
  });
  return {
    retentionDays: input.globalRetentionDays,
    cutoff,
    exportJobWhere: {
      organizationId: null,
      createdAt: { lt: cutoff }
    },
    webhookDeliveryWhere: {
      organizationId: null,
      createdAt: { lt: cutoff }
    }
  };
}

export type UnassignedRetentionSweepResult = {
  /**
   * Distinguishes this result from `AuditRecordRetentionSweepResult`: an
   * unassigned-rows sweep result is not scoped to any single organization
   * (there is no organizationId to attach it to), so it is represented as a
   * separate top-level result type rather than a synthetic
   * `organizationId: null`/sentinel row folded into the per-organization
   * results array. Forcing it into `AuditRecordRetentionSweepResult` would
   * require widening that type's `organizationId: string` to
   * `string | null` for a case that only applies to two of its four
   * counts (exportJobsDeleted/webhookDeliveriesDeleted; AuditEvent is
   * never nullable-org and ChangeControlRecord has no direct
   * organizationId column at all), which would weaken the type for every
   * other caller. A dedicated type keeps both shapes precise.
   */
  retentionDays: number;
  cutoff: string;
  exportJobsDeleted: number;
  webhookDeliveriesDeleted: number;
};

/**
 * Summarizes the outcome of executing the unassigned-rows sweep plan. Pure
 * aggregation only; the actual delete counts are supplied by the caller after
 * it executes the Prisma deletes described by the plan.
 */
export function summarizeUnassignedRetentionSweep(input: {
  plan: UnassignedRetentionSweepPlan;
  exportJobsDeleted: number;
  webhookDeliveriesDeleted: number;
}): UnassignedRetentionSweepResult {
  return {
    retentionDays: input.plan.retentionDays,
    cutoff: input.plan.cutoff.toISOString(),
    exportJobsDeleted: input.exportJobsDeleted,
    webhookDeliveriesDeleted: input.webhookDeliveriesDeleted
  };
}
