import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors the @agentforge/db mock in apps/worker/test/worker.test.ts: runWithOrgContext
// is a pass-through (no real AsyncLocalStorage/RLS binding needed to exercise the pure
// call sequence), and createPrismaClient/PrismaClient are not used directly by this test
// since runAuditRecordRetentionSweep takes an already-constructed `prisma` client.
vi.mock("@agentforge/db", () => ({
  runWithOrgContext: <T>(_organizationId: string, callback: () => Promise<T> | T) =>
    Promise.resolve(callback())
}));

const { runAuditRecordRetentionSweep, sweepUnassignedExportJobsAndWebhookDeliveries } =
  await import("../src/index.js");

type MockAuditEvent = {
  id: string;
  organizationId: string;
  createdAt: Date;
};

type MockChangeControlRecord = {
  id: string;
  organizationId: string;
  updatedAt: Date;
};

/**
 * organizationId is nullable here (unlike MockAuditEvent/MockChangeControlRecord
 * above), mirroring the schema: WebhookDelivery.organizationId and
 * ExportJob.organizationId are both `String?` in packages/db/prisma/schema.prisma,
 * so a fixture row needs to be able to represent the organizationId-null case
 * that `sweepUnassignedExportJobsAndWebhookDeliveries` targets.
 */
type MockExportJob = {
  id: string;
  organizationId: string | null;
  createdAt: Date;
};

type MockWebhookDelivery = {
  id: string;
  organizationId: string | null;
  createdAt: Date;
};

/**
 * A minimal fake Prisma client covering only what runAuditRecordRetentionSweep
 * and sweepUnassignedExportJobsAndWebhookDeliveries touch: organization.findMany
 * (for org discovery), auditEvent/changeControlRecord/exportJob/webhookDelivery
 * deleteMany (via the transaction), and auditEvent.create (for the retention_swept
 * audit trail). The fake filters in-memory data using the same shape of `where`
 * clause Prisma would receive, so the test exercises the actual filter values
 * these functions build rather than a hand-rolled stand-in.
 *
 * exportJob.deleteMany/webhookDelivery.deleteMany intentionally support BOTH
 * shapes of `where` clause used against these two models: `{ organizationId: <a
 * specific org's id>, createdAt: { lt } }` (built inline by
 * runAuditRecordRetentionSweep's per-organization transaction) and
 * `{ organizationId: null, createdAt: { lt } }` (built by
 * planUnassignedRetentionSweep and issued by
 * sweepUnassignedExportJobsAndWebhookDeliveries). A row only matches when its
 * own organizationId strictly equals the filter's organizationId (including
 * the null === null case), so a per-org sweep can never delete a null-org row
 * and the unassigned sweep can never delete a row that belongs to an
 * organization -- exercising exactly the no-double-deletion guarantee this
 * task requires.
 */
function createFakePrisma(input: {
  organizations: Array<{ id: string; auditRecordRetentionDays?: number | null }>;
  auditEvents: MockAuditEvent[];
  changeControlRecords: MockChangeControlRecord[];
  exportJobs?: MockExportJob[];
  webhookDeliveries?: MockWebhookDelivery[];
}) {
  const auditEvents = [...input.auditEvents];
  const changeControlRecords = [...input.changeControlRecords];
  const exportJobs = [...(input.exportJobs ?? [])];
  const webhookDeliveries = [...(input.webhookDeliveries ?? [])];
  const createdAuditEvents: unknown[] = [];

  function deleteManyByOrgAndCreatedAt<
    T extends { organizationId: string | null; createdAt: Date }
  >(
    rows: T[],
    where: { organizationId: string | null; createdAt: { lt: Date } }
  ): { count: number } {
    const before = rows.length;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i]!;
      if (row.organizationId === where.organizationId && row.createdAt < where.createdAt.lt) {
        rows.splice(i, 1);
      }
    }
    return { count: before - rows.length };
  }

  return {
    organization: {
      findMany: vi.fn().mockResolvedValue(
        input.organizations.map((org) => ({
          id: org.id,
          retentionSettings:
            org.auditRecordRetentionDays !== undefined
              ? { auditRecordRetentionDays: org.auditRecordRetentionDays }
              : null
        }))
      )
    },
    auditEvent: {
      deleteMany: vi.fn(
        ({ where }: { where: { organizationId: string; createdAt: { lt: Date } } }) => {
          const before = auditEvents.length;
          for (let i = auditEvents.length - 1; i >= 0; i -= 1) {
            const row = auditEvents[i]!;
            if (row.organizationId === where.organizationId && row.createdAt < where.createdAt.lt) {
              auditEvents.splice(i, 1);
            }
          }
          return Promise.resolve({ count: before - auditEvents.length });
        }
      ),
      create: vi.fn((args: { data: unknown }) => {
        createdAuditEvents.push(args.data);
        return Promise.resolve(args.data);
      })
    },
    changeControlRecord: {
      deleteMany: vi.fn(
        ({
          where
        }: {
          where: {
            updatedAt: { lt: Date };
            pullRequest: { repository: { organizationId: string } };
          };
        }) => {
          const orgId = where.pullRequest.repository.organizationId;
          const before = changeControlRecords.length;
          for (let i = changeControlRecords.length - 1; i >= 0; i -= 1) {
            const row = changeControlRecords[i]!;
            if (row.organizationId === orgId && row.updatedAt < where.updatedAt.lt) {
              changeControlRecords.splice(i, 1);
            }
          }
          return Promise.resolve({ count: before - changeControlRecords.length });
        }
      )
    },
    exportJob: {
      deleteMany: vi.fn(
        ({ where }: { where: { organizationId: string | null; createdAt: { lt: Date } } }) =>
          Promise.resolve(deleteManyByOrgAndCreatedAt(exportJobs, where))
      )
    },
    webhookDelivery: {
      deleteMany: vi.fn(
        ({ where }: { where: { organizationId: string | null; createdAt: { lt: Date } } }) =>
          Promise.resolve(deleteManyByOrgAndCreatedAt(webhookDeliveries, where))
      )
    },
    $transaction: vi.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
    __state: {
      auditEvents,
      changeControlRecords,
      exportJobs,
      webhookDeliveries,
      createdAuditEvents
    }
  };
}

describe("runAuditRecordRetentionSweep", () => {
  const now = new Date("2026-07-04T00:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("deletes AuditEvent rows older than the global retention window and leaves recent rows", async () => {
    const prisma = createFakePrisma({
      organizations: [{ id: "org_a" }],
      auditEvents: [
        { id: "old", organizationId: "org_a", createdAt: new Date("2024-01-01T00:00:00.000Z") },
        { id: "recent", organizationId: "org_a", createdAt: new Date("2026-06-01T00:00:00.000Z") }
      ],
      changeControlRecords: []
    });

    const results = await runAuditRecordRetentionSweep({
      prisma: prisma as never,
      globalRetentionDays: 365,
      now
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      organizationId: "org_a",
      retentionDays: 365,
      auditEventsDeleted: 1,
      changeControlRecordsDeleted: 0
    });
    expect(prisma.__state.auditEvents.map((row) => row.id)).toEqual(["recent"]);
  });

  it("deletes ChangeControlRecord rows older than the retention window scoped through the pull request's repository organization", async () => {
    const prisma = createFakePrisma({
      organizations: [{ id: "org_a" }],
      auditEvents: [],
      changeControlRecords: [
        { id: "ccr_old", organizationId: "org_a", updatedAt: new Date("2020-01-01T00:00:00.000Z") },
        {
          id: "ccr_recent",
          organizationId: "org_a",
          updatedAt: new Date("2026-07-01T00:00:00.000Z")
        }
      ]
    });

    const results = await runAuditRecordRetentionSweep({
      prisma: prisma as never,
      globalRetentionDays: 365,
      now
    });

    expect(results[0]).toMatchObject({
      changeControlRecordsDeleted: 1
    });
    expect(prisma.__state.changeControlRecords.map((row) => row.id)).toEqual(["ccr_recent"]);
  });

  it("uses a per-organization RetentionSetting.auditRecordRetentionDays override instead of the global config value", async () => {
    // A row from 60 days ago: outside a 30-day org override, inside the 365-day global default.
    const rowFromSixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    const prisma = createFakePrisma({
      organizations: [{ id: "org_short_retention", auditRecordRetentionDays: 30 }],
      auditEvents: [
        {
          id: "should_be_swept",
          organizationId: "org_short_retention",
          createdAt: rowFromSixtyDaysAgo
        }
      ],
      changeControlRecords: []
    });

    const results = await runAuditRecordRetentionSweep({
      prisma: prisma as never,
      globalRetentionDays: 365,
      now
    });

    expect(results[0]).toMatchObject({
      organizationId: "org_short_retention",
      retentionDays: 30,
      auditEventsDeleted: 1
    });
  });

  it("processes multiple organizations independently, each with its own cutoff", async () => {
    const rowFromNinetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const prisma = createFakePrisma({
      organizations: [
        { id: "org_strict", auditRecordRetentionDays: 30 },
        { id: "org_lenient", auditRecordRetentionDays: 2555 }
      ],
      auditEvents: [
        { id: "strict_row", organizationId: "org_strict", createdAt: rowFromNinetyDaysAgo },
        { id: "lenient_row", organizationId: "org_lenient", createdAt: rowFromNinetyDaysAgo }
      ],
      changeControlRecords: []
    });

    const results = await runAuditRecordRetentionSweep({
      prisma: prisma as never,
      globalRetentionDays: 365,
      now
    });

    const strict = results.find((r) => r.organizationId === "org_strict");
    const lenient = results.find((r) => r.organizationId === "org_lenient");
    expect(strict?.auditEventsDeleted).toBe(1);
    expect(lenient?.auditEventsDeleted).toBe(0);
    expect(prisma.__state.auditEvents.map((row) => row.id)).toEqual(["lenient_row"]);
  });

  it("does not delete anything, and writes no audit trail row, when no rows are past the cutoff", async () => {
    const prisma = createFakePrisma({
      organizations: [{ id: "org_a" }],
      auditEvents: [
        { id: "recent", organizationId: "org_a", createdAt: new Date("2026-06-01T00:00:00.000Z") }
      ],
      changeControlRecords: []
    });

    const results = await runAuditRecordRetentionSweep({
      prisma: prisma as never,
      globalRetentionDays: 365,
      now
    });

    expect(results[0]).toMatchObject({ auditEventsDeleted: 0, changeControlRecordsDeleted: 0 });
    expect(prisma.__state.createdAuditEvents).toHaveLength(0);
  });

  it("writes a retention_swept audit event when rows are deleted, recording the counts and cutoff", async () => {
    const prisma = createFakePrisma({
      organizations: [{ id: "org_a" }],
      auditEvents: [
        { id: "old", organizationId: "org_a", createdAt: new Date("2024-01-01T00:00:00.000Z") }
      ],
      changeControlRecords: []
    });

    await runAuditRecordRetentionSweep({
      prisma: prisma as never,
      globalRetentionDays: 365,
      now
    });

    expect(prisma.__state.createdAuditEvents).toHaveLength(1);
    const created = prisma.__state.createdAuditEvents[0] as {
      action: string;
      organizationId: string;
      actor: string;
      metadataJson: { auditEventsDeleted: number; retentionDays: number };
    };
    expect(created.action).toBe("retention_swept");
    expect(created.organizationId).toBe("org_a");
    expect(created.actor).toBe("system");
    expect(created.metadataJson.auditEventsDeleted).toBe(1);
    expect(created.metadataJson.retentionDays).toBe(365);
  });

  it("returns an empty result set when there are no organizations to sweep", async () => {
    const prisma = createFakePrisma({
      organizations: [],
      auditEvents: [],
      changeControlRecords: []
    });

    const results = await runAuditRecordRetentionSweep({
      prisma: prisma as never,
      globalRetentionDays: 365,
      now
    });

    expect(results).toEqual([]);
  });

  it("deletes an organization's expired ExportJob rows inside the same transaction as AuditEvent/ChangeControlRecord, and leaves recent rows", async () => {
    const prisma = createFakePrisma({
      organizations: [{ id: "org_a" }],
      auditEvents: [],
      changeControlRecords: [],
      exportJobs: [
        {
          id: "export_old",
          organizationId: "org_a",
          createdAt: new Date("2024-01-01T00:00:00.000Z")
        },
        {
          id: "export_recent",
          organizationId: "org_a",
          createdAt: new Date("2026-06-01T00:00:00.000Z")
        }
      ]
    });

    const results = await runAuditRecordRetentionSweep({
      prisma: prisma as never,
      globalRetentionDays: 365,
      now
    });

    expect(results[0]).toMatchObject({ organizationId: "org_a", exportJobsDeleted: 1 });
    expect(prisma.__state.exportJobs.map((row) => row.id)).toEqual(["export_recent"]);
    // Confirms the delete happened inside the same $transaction call as the
    // pre-existing AuditEvent/ChangeControlRecord deletes, not a second,
    // separate transaction -- the transaction array now has 4 operations.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect((prisma.$transaction as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toHaveLength(4);
  });

  it("deletes an organization's expired WebhookDelivery rows inside the same transaction as the other three models, and leaves recent rows", async () => {
    const prisma = createFakePrisma({
      organizations: [{ id: "org_a" }],
      auditEvents: [],
      changeControlRecords: [],
      webhookDeliveries: [
        {
          id: "delivery_old",
          organizationId: "org_a",
          createdAt: new Date("2020-01-01T00:00:00.000Z")
        },
        {
          id: "delivery_recent",
          organizationId: "org_a",
          createdAt: new Date("2026-07-01T00:00:00.000Z")
        }
      ]
    });

    const results = await runAuditRecordRetentionSweep({
      prisma: prisma as never,
      globalRetentionDays: 365,
      now
    });

    expect(results[0]).toMatchObject({ organizationId: "org_a", webhookDeliveriesDeleted: 1 });
    expect(prisma.__state.webhookDeliveries.map((row) => row.id)).toEqual(["delivery_recent"]);
  });

  it("only sweeps an organization's OWN ExportJob/WebhookDelivery rows, not another organization's rows past the same cutoff", async () => {
    const rowFromFourHundredDaysAgo = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000);
    const prisma = createFakePrisma({
      organizations: [{ id: "org_a" }, { id: "org_b" }],
      auditEvents: [],
      changeControlRecords: [],
      exportJobs: [
        { id: "export_org_a", organizationId: "org_a", createdAt: rowFromFourHundredDaysAgo },
        { id: "export_org_b", organizationId: "org_b", createdAt: rowFromFourHundredDaysAgo }
      ],
      webhookDeliveries: [
        {
          id: "delivery_org_a",
          organizationId: "org_a",
          createdAt: rowFromFourHundredDaysAgo
        },
        {
          id: "delivery_org_b",
          organizationId: "org_b",
          createdAt: rowFromFourHundredDaysAgo
        }
      ]
    });

    const results = await runAuditRecordRetentionSweep({
      prisma: prisma as never,
      globalRetentionDays: 365,
      now
    });

    const orgA = results.find((r) => r.organizationId === "org_a");
    const orgB = results.find((r) => r.organizationId === "org_b");
    expect(orgA).toMatchObject({ exportJobsDeleted: 1, webhookDeliveriesDeleted: 1 });
    expect(orgB).toMatchObject({ exportJobsDeleted: 1, webhookDeliveriesDeleted: 1 });
    expect(prisma.__state.exportJobs).toHaveLength(0);
    expect(prisma.__state.webhookDeliveries).toHaveLength(0);
  });

  it("does NOT delete an organizationId-null ExportJob/WebhookDelivery row during the per-organization sweep, even when it is past every organization's cutoff", async () => {
    const rowFromFourHundredDaysAgo = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000);
    const prisma = createFakePrisma({
      organizations: [{ id: "org_a" }],
      auditEvents: [],
      changeControlRecords: [],
      exportJobs: [
        { id: "export_unassigned", organizationId: null, createdAt: rowFromFourHundredDaysAgo }
      ],
      webhookDeliveries: [
        {
          id: "delivery_unassigned",
          organizationId: null,
          createdAt: rowFromFourHundredDaysAgo
        }
      ]
    });

    const results = await runAuditRecordRetentionSweep({
      prisma: prisma as never,
      globalRetentionDays: 365,
      now
    });

    // org_a's sweep filters on organizationId: "org_a"; a null-organizationId
    // row can never match that filter, so it must survive this pass entirely.
    expect(results[0]).toMatchObject({ exportJobsDeleted: 0, webhookDeliveriesDeleted: 0 });
    expect(prisma.__state.exportJobs.map((row) => row.id)).toEqual(["export_unassigned"]);
    expect(prisma.__state.webhookDeliveries.map((row) => row.id)).toEqual(["delivery_unassigned"]);
  });

  it("extends the retention_swept audit event's metadataJson with exportJobsDeleted/webhookDeliveriesDeleted counts", async () => {
    const prisma = createFakePrisma({
      organizations: [{ id: "org_a" }],
      auditEvents: [
        { id: "old", organizationId: "org_a", createdAt: new Date("2024-01-01T00:00:00.000Z") }
      ],
      changeControlRecords: [],
      exportJobs: [
        {
          id: "export_old",
          organizationId: "org_a",
          createdAt: new Date("2024-01-01T00:00:00.000Z")
        }
      ],
      webhookDeliveries: [
        {
          id: "delivery_old",
          organizationId: "org_a",
          createdAt: new Date("2024-01-01T00:00:00.000Z")
        }
      ]
    });

    await runAuditRecordRetentionSweep({
      prisma: prisma as never,
      globalRetentionDays: 365,
      now
    });

    const created = prisma.__state.createdAuditEvents[0] as {
      metadataJson: { exportJobsDeleted: number; webhookDeliveriesDeleted: number };
    };
    expect(created.metadataJson.exportJobsDeleted).toBe(1);
    expect(created.metadataJson.webhookDeliveriesDeleted).toBe(1);
  });

  it("writes a retention_swept audit event when only ExportJob/WebhookDelivery rows are deleted, even with zero AuditEvent/ChangeControlRecord deletions", async () => {
    const prisma = createFakePrisma({
      organizations: [{ id: "org_a" }],
      auditEvents: [],
      changeControlRecords: [],
      exportJobs: [
        {
          id: "export_old",
          organizationId: "org_a",
          createdAt: new Date("2024-01-01T00:00:00.000Z")
        }
      ]
    });

    await runAuditRecordRetentionSweep({
      prisma: prisma as never,
      globalRetentionDays: 365,
      now
    });

    expect(prisma.__state.createdAuditEvents).toHaveLength(1);
  });
});

describe("sweepUnassignedExportJobsAndWebhookDeliveries", () => {
  const now = new Date("2026-07-04T00:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("deletes organizationId-null ExportJob rows past the global cutoff and leaves organizationId-null rows within the window", async () => {
    const prisma = createFakePrisma({
      organizations: [],
      auditEvents: [],
      changeControlRecords: [],
      exportJobs: [
        {
          id: "export_old_unassigned",
          organizationId: null,
          createdAt: new Date("2024-01-01T00:00:00.000Z")
        },
        {
          id: "export_recent_unassigned",
          organizationId: null,
          createdAt: new Date("2026-06-01T00:00:00.000Z")
        }
      ]
    });

    const summary = await sweepUnassignedExportJobsAndWebhookDeliveries({
      prisma: prisma as never,
      globalRetentionDays: 365,
      now
    });

    expect(summary.exportJobsDeleted).toBe(1);
    expect(prisma.__state.exportJobs.map((row) => row.id)).toEqual(["export_recent_unassigned"]);
  });

  it("deletes organizationId-null WebhookDelivery rows past the global cutoff and leaves organizationId-null rows within the window", async () => {
    const prisma = createFakePrisma({
      organizations: [],
      auditEvents: [],
      changeControlRecords: [],
      webhookDeliveries: [
        {
          id: "delivery_old_unassigned",
          organizationId: null,
          createdAt: new Date("2020-01-01T00:00:00.000Z")
        },
        {
          id: "delivery_recent_unassigned",
          organizationId: null,
          createdAt: new Date("2026-07-01T00:00:00.000Z")
        }
      ]
    });

    const summary = await sweepUnassignedExportJobsAndWebhookDeliveries({
      prisma: prisma as never,
      globalRetentionDays: 365,
      now
    });

    expect(summary.webhookDeliveriesDeleted).toBe(1);
    expect(prisma.__state.webhookDeliveries.map((row) => row.id)).toEqual([
      "delivery_recent_unassigned"
    ]);
  });

  it("does NOT delete a row that belongs to an organization, even when it is past the global cutoff (no double-deletion / no cross-contamination with the per-org sweep)", async () => {
    const rowFromFourHundredDaysAgo = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000);
    const prisma = createFakePrisma({
      organizations: [],
      auditEvents: [],
      changeControlRecords: [],
      exportJobs: [
        { id: "export_org_a", organizationId: "org_a", createdAt: rowFromFourHundredDaysAgo },
        { id: "export_unassigned", organizationId: null, createdAt: rowFromFourHundredDaysAgo }
      ],
      webhookDeliveries: [
        {
          id: "delivery_org_a",
          organizationId: "org_a",
          createdAt: rowFromFourHundredDaysAgo
        },
        {
          id: "delivery_unassigned",
          organizationId: null,
          createdAt: rowFromFourHundredDaysAgo
        }
      ]
    });

    const summary = await sweepUnassignedExportJobsAndWebhookDeliveries({
      prisma: prisma as never,
      globalRetentionDays: 365,
      now
    });

    // Only the organizationId-null rows should be counted/deleted by this pass.
    expect(summary.exportJobsDeleted).toBe(1);
    expect(summary.webhookDeliveriesDeleted).toBe(1);
    expect(prisma.__state.exportJobs.map((row) => row.id)).toEqual(["export_org_a"]);
    expect(prisma.__state.webhookDeliveries.map((row) => row.id)).toEqual(["delivery_org_a"]);
  });

  it("combined with the per-organization sweep, deletes every expired row exactly once with no double-counting: org-scoped rows via the per-org sweep, unassigned rows via this pass", async () => {
    const rowFromFourHundredDaysAgo = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000);
    const prisma = createFakePrisma({
      organizations: [{ id: "org_a" }],
      auditEvents: [],
      changeControlRecords: [],
      exportJobs: [
        { id: "export_org_a", organizationId: "org_a", createdAt: rowFromFourHundredDaysAgo },
        { id: "export_unassigned", organizationId: null, createdAt: rowFromFourHundredDaysAgo }
      ],
      webhookDeliveries: [
        {
          id: "delivery_org_a",
          organizationId: "org_a",
          createdAt: rowFromFourHundredDaysAgo
        },
        {
          id: "delivery_unassigned",
          organizationId: null,
          createdAt: rowFromFourHundredDaysAgo
        }
      ]
    });

    const orgResults = await runAuditRecordRetentionSweep({
      prisma: prisma as never,
      globalRetentionDays: 365,
      now
    });
    const unassignedResult = await sweepUnassignedExportJobsAndWebhookDeliveries({
      prisma: prisma as never,
      globalRetentionDays: 365,
      now
    });

    expect(orgResults[0]).toMatchObject({ exportJobsDeleted: 1, webhookDeliveriesDeleted: 1 });
    expect(unassignedResult).toMatchObject({ exportJobsDeleted: 1, webhookDeliveriesDeleted: 1 });
    // Every fixture row was expired; after both passes run, nothing should remain,
    // and nothing should have been counted by both passes at once.
    expect(prisma.__state.exportJobs).toHaveLength(0);
    expect(prisma.__state.webhookDeliveries).toHaveLength(0);
  });

  it("does not write an AuditEvent for unassigned-row deletions, since AuditEvent.organizationId is required and there is no organization to attach one to", async () => {
    const prisma = createFakePrisma({
      organizations: [],
      auditEvents: [],
      changeControlRecords: [],
      exportJobs: [
        {
          id: "export_old_unassigned",
          organizationId: null,
          createdAt: new Date("2024-01-01T00:00:00.000Z")
        }
      ]
    });

    await sweepUnassignedExportJobsAndWebhookDeliveries({
      prisma: prisma as never,
      globalRetentionDays: 365,
      now
    });

    expect(prisma.__state.createdAuditEvents).toHaveLength(0);
    expect(prisma.auditEvent.create).not.toHaveBeenCalled();
  });

  it("returns zero counts and deletes nothing when there are no organizationId-null rows past the cutoff", async () => {
    const prisma = createFakePrisma({
      organizations: [],
      auditEvents: [],
      changeControlRecords: [],
      exportJobs: [
        {
          id: "export_recent_unassigned",
          organizationId: null,
          createdAt: new Date("2026-06-01T00:00:00.000Z")
        }
      ],
      webhookDeliveries: [
        {
          id: "delivery_recent_unassigned",
          organizationId: null,
          createdAt: new Date("2026-06-01T00:00:00.000Z")
        }
      ]
    });

    const summary = await sweepUnassignedExportJobsAndWebhookDeliveries({
      prisma: prisma as never,
      globalRetentionDays: 365,
      now
    });

    expect(summary.exportJobsDeleted).toBe(0);
    expect(summary.webhookDeliveriesDeleted).toBe(0);
    expect(prisma.__state.exportJobs).toHaveLength(1);
    expect(prisma.__state.webhookDeliveries).toHaveLength(1);
  });
});
