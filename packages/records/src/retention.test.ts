import { describe, expect, it } from "vitest";
import {
  computeRetentionCutoff,
  DEFAULT_AUDIT_RECORD_RETENTION_DAYS,
  isOlderThanRetentionCutoff,
  planAuditRecordRetentionSweep,
  planExportJobRetentionSweep,
  planUnassignedRetentionSweep,
  planWebhookDeliveryRetentionSweep,
  resolveAuditRecordRetentionDays,
  summarizeAuditRecordRetentionSweep,
  summarizeUnassignedRetentionSweep
} from "./retention.js";

describe("resolveAuditRecordRetentionDays", () => {
  it("uses the global retention value when no organization override is set", () => {
    expect(
      resolveAuditRecordRetentionDays({
        globalRetentionDays: 365,
        organizationOverrideDays: undefined
      })
    ).toBe(365);
  });

  it("uses the global retention value when the organization override is null", () => {
    expect(
      resolveAuditRecordRetentionDays({
        globalRetentionDays: 365,
        organizationOverrideDays: null
      })
    ).toBe(365);
  });

  it("prefers a positive per-organization override over the global value", () => {
    expect(
      resolveAuditRecordRetentionDays({
        globalRetentionDays: 365,
        organizationOverrideDays: 2555
      })
    ).toBe(2555);
  });

  it("falls back to the global value when the override is zero or negative", () => {
    expect(
      resolveAuditRecordRetentionDays({
        globalRetentionDays: 365,
        organizationOverrideDays: 0
      })
    ).toBe(365);
    expect(
      resolveAuditRecordRetentionDays({
        globalRetentionDays: 365,
        organizationOverrideDays: -30
      })
    ).toBe(365);
  });

  it("floors a fractional override", () => {
    expect(
      resolveAuditRecordRetentionDays({
        globalRetentionDays: 365,
        organizationOverrideDays: 30.9
      })
    ).toBe(30);
  });
});

describe("computeRetentionCutoff", () => {
  it("computes a cutoff exactly retentionDays before now", () => {
    const now = new Date("2026-07-04T00:00:00.000Z");
    const cutoff = computeRetentionCutoff({ retentionDays: 365, now });
    expect(cutoff.toISOString()).toBe("2025-07-04T00:00:00.000Z");
  });

  it("supports long retention windows (e.g. 2555 days / 7 years)", () => {
    const now = new Date("2026-07-04T00:00:00.000Z");
    const cutoff = computeRetentionCutoff({ retentionDays: 2555, now });
    expect(cutoff.getTime()).toBe(now.getTime() - 2555 * 24 * 60 * 60 * 1000);
  });

  it("defaults now to the current time when not provided", () => {
    const before = Date.now();
    const cutoff = computeRetentionCutoff({ retentionDays: 1 });
    const after = Date.now();
    const expectedMin = before - 24 * 60 * 60 * 1000;
    const expectedMax = after - 24 * 60 * 60 * 1000;
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(expectedMin);
    expect(cutoff.getTime()).toBeLessThanOrEqual(expectedMax);
  });
});

describe("isOlderThanRetentionCutoff", () => {
  const cutoff = new Date("2025-07-04T00:00:00.000Z");

  it("returns true for a Date strictly before the cutoff", () => {
    expect(isOlderThanRetentionCutoff(new Date("2025-01-01T00:00:00.000Z"), cutoff)).toBe(true);
  });

  it("returns true for an ISO string strictly before the cutoff", () => {
    expect(isOlderThanRetentionCutoff("2020-01-01T00:00:00.000Z", cutoff)).toBe(true);
  });

  it("returns false for a timestamp exactly at the cutoff", () => {
    expect(isOlderThanRetentionCutoff(new Date(cutoff.getTime()), cutoff)).toBe(false);
  });

  it("returns false for a timestamp after the cutoff (within the retention window)", () => {
    expect(isOlderThanRetentionCutoff(new Date("2026-01-01T00:00:00.000Z"), cutoff)).toBe(false);
  });
});

describe("planAuditRecordRetentionSweep", () => {
  const now = new Date("2026-07-04T00:00:00.000Z");

  it("builds an AuditEvent filter scoped to the organization and the resolved cutoff", () => {
    const plan = planAuditRecordRetentionSweep({
      organizationId: "org_a",
      globalRetentionDays: 365,
      now
    });

    expect(plan.organizationId).toBe("org_a");
    expect(plan.retentionDays).toBe(365);
    expect(plan.cutoff.toISOString()).toBe("2025-07-04T00:00:00.000Z");
    expect(plan.auditEventWhere).toEqual({
      organizationId: "org_a",
      createdAt: { lt: plan.cutoff }
    });
  });

  it("builds a ChangeControlRecord filter through the pullRequest -> repository relation, not a direct organizationId column", () => {
    const plan = planAuditRecordRetentionSweep({
      organizationId: "org_a",
      globalRetentionDays: 365,
      now
    });

    expect(plan.changeControlRecordWhere).toEqual({
      updatedAt: { lt: plan.cutoff },
      pullRequest: {
        repository: {
          organizationId: "org_a"
        }
      }
    });
  });

  it("uses the per-organization RetentionSetting override instead of the global value when present", () => {
    const plan = planAuditRecordRetentionSweep({
      organizationId: "org_b",
      globalRetentionDays: 365,
      organizationOverrideDays: 2555,
      now
    });

    expect(plan.retentionDays).toBe(2555);
    expect(plan.cutoff.getTime()).toBe(now.getTime() - 2555 * 24 * 60 * 60 * 1000);
  });

  it("ignores a non-positive organization override and falls back to the global value", () => {
    const plan = planAuditRecordRetentionSweep({
      organizationId: "org_c",
      globalRetentionDays: 90,
      organizationOverrideDays: 0,
      now
    });

    expect(plan.retentionDays).toBe(90);
  });

  it("produces different cutoffs (and therefore different sweep targets) for different organizations", () => {
    const shortRetentionPlan = planAuditRecordRetentionSweep({
      organizationId: "org_short",
      globalRetentionDays: 365,
      organizationOverrideDays: 30,
      now
    });
    const longRetentionPlan = planAuditRecordRetentionSweep({
      organizationId: "org_long",
      globalRetentionDays: 365,
      organizationOverrideDays: 2555,
      now
    });

    // A row from 60 days ago is outside a 30-day retention window but well
    // within a 2555-day (7-year) retention window.
    const rowFromSixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    expect(isOlderThanRetentionCutoff(rowFromSixtyDaysAgo, shortRetentionPlan.cutoff)).toBe(true);
    expect(isOlderThanRetentionCutoff(rowFromSixtyDaysAgo, longRetentionPlan.cutoff)).toBe(false);
  });

  describe("sweep targeting: rows older than the cutoff vs rows within the retention window", () => {
    const plan = planAuditRecordRetentionSweep({
      organizationId: "org_target",
      globalRetentionDays: 365,
      now
    });

    it("targets a row from 400 days ago (older than a 365-day window) for deletion", () => {
      const rowCreatedAt = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000);
      expect(isOlderThanRetentionCutoff(rowCreatedAt, plan.cutoff)).toBe(true);
    });

    it("does NOT target a row from 10 days ago (within a 365-day window) for deletion", () => {
      const rowCreatedAt = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
      expect(isOlderThanRetentionCutoff(rowCreatedAt, plan.cutoff)).toBe(false);
    });

    it("does NOT target a row created exactly at the retention boundary for deletion", () => {
      const rowCreatedAt = new Date(plan.cutoff.getTime());
      expect(isOlderThanRetentionCutoff(rowCreatedAt, plan.cutoff)).toBe(false);
    });

    it("targets a row created one millisecond before the retention boundary for deletion", () => {
      const rowCreatedAt = new Date(plan.cutoff.getTime() - 1);
      expect(isOlderThanRetentionCutoff(rowCreatedAt, plan.cutoff)).toBe(true);
    });
  });
});

describe("summarizeAuditRecordRetentionSweep", () => {
  it("aggregates the plan and delete counts into a stable, serializable summary", () => {
    const now = new Date("2026-07-04T00:00:00.000Z");
    const plan = planAuditRecordRetentionSweep({
      organizationId: "org_a",
      globalRetentionDays: 365,
      now
    });

    const summary = summarizeAuditRecordRetentionSweep({
      plan,
      auditEventsDeleted: 42,
      changeControlRecordsDeleted: 7,
      exportJobsDeleted: 3,
      webhookDeliveriesDeleted: 11
    });

    expect(summary).toEqual({
      organizationId: "org_a",
      retentionDays: 365,
      cutoff: "2025-07-04T00:00:00.000Z",
      auditEventsDeleted: 42,
      changeControlRecordsDeleted: 7,
      exportJobsDeleted: 3,
      webhookDeliveriesDeleted: 11
    });
  });

  it("reports zero deletions for an organization with no rows past the cutoff", () => {
    const plan = planAuditRecordRetentionSweep({
      organizationId: "org_empty",
      globalRetentionDays: 365
    });

    const summary = summarizeAuditRecordRetentionSweep({
      plan,
      auditEventsDeleted: 0,
      changeControlRecordsDeleted: 0,
      exportJobsDeleted: 0,
      webhookDeliveriesDeleted: 0
    });

    expect(summary.auditEventsDeleted).toBe(0);
    expect(summary.changeControlRecordsDeleted).toBe(0);
    expect(summary.exportJobsDeleted).toBe(0);
    expect(summary.webhookDeliveriesDeleted).toBe(0);
  });
});

describe("DEFAULT_AUDIT_RECORD_RETENTION_DAYS", () => {
  it("matches the schema default for RetentionSetting/RepositorySetting.auditRecordRetentionDays", () => {
    // packages/db/prisma/schema.prisma defines auditRecordRetentionDays with
    // @default(365) on both RetentionSetting and RepositorySetting. Keeping
    // this constant in sync documents that relationship for future readers.
    expect(DEFAULT_AUDIT_RECORD_RETENTION_DAYS).toBe(365);
  });
});

describe("planExportJobRetentionSweep", () => {
  const now = new Date("2026-07-04T00:00:00.000Z");

  it("builds an ExportJob filter scoped to the organization and the resolved cutoff", () => {
    const plan = planExportJobRetentionSweep({
      organizationId: "org_a",
      globalRetentionDays: 365,
      now
    });

    expect(plan.organizationId).toBe("org_a");
    expect(plan.retentionDays).toBe(365);
    expect(plan.cutoff.toISOString()).toBe("2025-07-04T00:00:00.000Z");
    expect(plan.exportJobWhere).toEqual({
      organizationId: "org_a",
      createdAt: { lt: plan.cutoff }
    });
  });

  it("uses the per-organization RetentionSetting override instead of the global value when present", () => {
    const plan = planExportJobRetentionSweep({
      organizationId: "org_b",
      globalRetentionDays: 365,
      organizationOverrideDays: 2555,
      now
    });

    expect(plan.retentionDays).toBe(2555);
    expect(plan.cutoff.getTime()).toBe(now.getTime() - 2555 * 24 * 60 * 60 * 1000);
  });

  it("ignores a non-positive organization override and falls back to the global value", () => {
    const plan = planExportJobRetentionSweep({
      organizationId: "org_c",
      globalRetentionDays: 90,
      organizationOverrideDays: 0,
      now
    });

    expect(plan.retentionDays).toBe(90);
  });

  it("targets an ExportJob row created before the cutoff and preserves one created after it", () => {
    const plan = planExportJobRetentionSweep({
      organizationId: "org_target",
      globalRetentionDays: 365,
      now
    });

    const rowFromFourHundredDaysAgo = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000);
    const rowFromTenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    expect(isOlderThanRetentionCutoff(rowFromFourHundredDaysAgo, plan.cutoff)).toBe(true);
    expect(isOlderThanRetentionCutoff(rowFromTenDaysAgo, plan.cutoff)).toBe(false);
  });
});

describe("planWebhookDeliveryRetentionSweep", () => {
  const now = new Date("2026-07-04T00:00:00.000Z");

  it("builds a WebhookDelivery filter scoped to the organization and the resolved cutoff", () => {
    const plan = planWebhookDeliveryRetentionSweep({
      organizationId: "org_a",
      globalRetentionDays: 365,
      now
    });

    expect(plan.organizationId).toBe("org_a");
    expect(plan.retentionDays).toBe(365);
    expect(plan.cutoff.toISOString()).toBe("2025-07-04T00:00:00.000Z");
    expect(plan.webhookDeliveryWhere).toEqual({
      organizationId: "org_a",
      createdAt: { lt: plan.cutoff }
    });
  });

  it("uses the per-organization RetentionSetting override instead of the global value when present", () => {
    const plan = planWebhookDeliveryRetentionSweep({
      organizationId: "org_b",
      globalRetentionDays: 365,
      organizationOverrideDays: 30,
      now
    });

    expect(plan.retentionDays).toBe(30);
    expect(plan.cutoff.getTime()).toBe(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  });

  it("produces different cutoffs for different organizations, matching planAuditRecordRetentionSweep's per-org behavior", () => {
    const shortRetentionPlan = planWebhookDeliveryRetentionSweep({
      organizationId: "org_short",
      globalRetentionDays: 365,
      organizationOverrideDays: 30,
      now
    });
    const longRetentionPlan = planWebhookDeliveryRetentionSweep({
      organizationId: "org_long",
      globalRetentionDays: 365,
      organizationOverrideDays: 2555,
      now
    });

    const rowFromSixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    expect(isOlderThanRetentionCutoff(rowFromSixtyDaysAgo, shortRetentionPlan.cutoff)).toBe(true);
    expect(isOlderThanRetentionCutoff(rowFromSixtyDaysAgo, longRetentionPlan.cutoff)).toBe(false);
  });
});

describe("planUnassignedRetentionSweep", () => {
  const now = new Date("2026-07-04T00:00:00.000Z");

  it("builds organizationId-null filters for both ExportJob and WebhookDelivery using the GLOBAL retention window directly", () => {
    const plan = planUnassignedRetentionSweep({
      globalRetentionDays: 365,
      now
    });

    expect(plan.retentionDays).toBe(365);
    expect(plan.cutoff.toISOString()).toBe("2025-07-04T00:00:00.000Z");
    expect(plan.exportJobWhere).toEqual({
      organizationId: null,
      createdAt: { lt: plan.cutoff }
    });
    expect(plan.webhookDeliveryWhere).toEqual({
      organizationId: null,
      createdAt: { lt: plan.cutoff }
    });
  });

  it("has no organizationOverrideDays parameter: the global retention window always applies, since there is no per-org override to resolve for a null-organizationId row", () => {
    // A 2555-day per-org override would never apply here; unassigned rows
    // only ever see the global retention window regardless of how generous
    // any individual organization's override is.
    const plan = planUnassignedRetentionSweep({
      globalRetentionDays: 90,
      now
    });

    expect(plan.retentionDays).toBe(90);
    expect(plan.cutoff.getTime()).toBe(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  });

  it("targets a null-organizationId row past the global cutoff for deletion", () => {
    const plan = planUnassignedRetentionSweep({ globalRetentionDays: 365, now });
    const rowFromFourHundredDaysAgo = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000);
    expect(isOlderThanRetentionCutoff(rowFromFourHundredDaysAgo, plan.cutoff)).toBe(true);
  });

  it("does NOT target a null-organizationId row within the global retention window", () => {
    const plan = planUnassignedRetentionSweep({ globalRetentionDays: 365, now });
    const rowFromTenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    expect(isOlderThanRetentionCutoff(rowFromTenDaysAgo, plan.cutoff)).toBe(false);
  });

  it("does NOT target a row created exactly at the retention boundary, and DOES target one millisecond before it (boundary parity with planAuditRecordRetentionSweep)", () => {
    const plan = planUnassignedRetentionSweep({ globalRetentionDays: 365, now });
    expect(isOlderThanRetentionCutoff(new Date(plan.cutoff.getTime()), plan.cutoff)).toBe(false);
    expect(isOlderThanRetentionCutoff(new Date(plan.cutoff.getTime() - 1), plan.cutoff)).toBe(true);
  });
});

describe("summarizeUnassignedRetentionSweep", () => {
  it("aggregates the unassigned-rows plan and delete counts into a stable, serializable summary", () => {
    const now = new Date("2026-07-04T00:00:00.000Z");
    const plan = planUnassignedRetentionSweep({ globalRetentionDays: 365, now });

    const summary = summarizeUnassignedRetentionSweep({
      plan,
      exportJobsDeleted: 5,
      webhookDeliveriesDeleted: 13
    });

    expect(summary).toEqual({
      retentionDays: 365,
      cutoff: "2025-07-04T00:00:00.000Z",
      exportJobsDeleted: 5,
      webhookDeliveriesDeleted: 13
    });
  });

  it("has no organizationId field, unlike AuditRecordRetentionSweepResult, since unassigned rows are not scoped to any single organization", () => {
    const plan = planUnassignedRetentionSweep({ globalRetentionDays: 365 });
    const summary = summarizeUnassignedRetentionSweep({
      plan,
      exportJobsDeleted: 0,
      webhookDeliveriesDeleted: 0
    });

    expect(summary).not.toHaveProperty("organizationId");
  });

  it("reports zero deletions when no unassigned rows are past the cutoff", () => {
    const plan = planUnassignedRetentionSweep({ globalRetentionDays: 365 });
    const summary = summarizeUnassignedRetentionSweep({
      plan,
      exportJobsDeleted: 0,
      webhookDeliveriesDeleted: 0
    });

    expect(summary.exportJobsDeleted).toBe(0);
    expect(summary.webhookDeliveriesDeleted).toBe(0);
  });
});
