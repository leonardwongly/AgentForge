export const MERGE_GUARD_EVALUATION_QUEUE = "merge-guard-evaluations";
export const MERGE_GUARD_EVALUATION_JOB_NAME = "evaluate-pr";
export const MERGE_GUARD_EVALUATION_ATTEMPTS = 3;
export const MERGE_GUARD_EVALUATION_BACKOFF_MS = 30_000;

// Recurring maintenance queue that enforces AUDIT_RECORD_RETENTION_DAYS (and any
// per-organization RetentionSetting.auditRecordRetentionDays override) by
// deleting AuditEvent/ChangeControlRecord rows older than the configured
// retention window. Scheduled as a BullMQ repeatable job by the worker rather
// than an external cron script, since Postgres/Redis/the worker process are
// already the deployed maintenance surface for this codebase (see
// docs/railway-deployment.md / docs/runbook.md) and no external-cron
// deployment primitive exists yet.
export const AUDIT_RECORD_RETENTION_SWEEP_QUEUE = "audit-record-retention-sweep";
export const AUDIT_RECORD_RETENTION_SWEEP_JOB_NAME = "sweep-audit-records";
// Once daily at 03:00 server time: frequent enough that the deployed retention
// window is enforced within about a day of crossing the cutoff, infrequent
// enough that it never contends with evaluation-job throughput.
export const AUDIT_RECORD_RETENTION_SWEEP_CRON = "0 3 * * *";
