import { describe, expect, it, vi } from "vitest";
import { testInternals } from "../src/index.js";

type InstallationRow = {
  id: string;
  organizationId: string | null;
  githubInstallationId: bigint;
  accountLogin: string;
  accountType: string;
  status: string;
  approvedBy: string | null;
  approvedAt: Date | null;
  rejectedBy: string | null;
  rejectedAt: Date | null;
  archivedAt: Date | null;
  lastWebhookAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

type WebhookDeliveryRow = {
  id: string;
  deliveryId: string;
  event: string;
  action: string | null;
  payloadJson: unknown;
  createdAt: Date;
};

type RepositoryRow = {
  id: string;
  organizationId: string;
  githubRepositoryId?: bigint;
  fullName: string;
  enabled: boolean;
  archivedAt: Date | null;
  mode: string | null;
};

function installationRow(
  overrides: Partial<InstallationRow> & Pick<InstallationRow, "id" | "githubInstallationId">
): InstallationRow {
  const now = new Date("2026-05-25T00:00:00.000Z");
  return {
    organizationId: null,
    accountLogin: "acme",
    accountType: "Organization",
    status: "pending_approval",
    approvedBy: null,
    approvedAt: null,
    rejectedBy: null,
    rejectedAt: null,
    archivedAt: null,
    lastWebhookAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function installationPayload(
  id: number,
  repositoriesAdded: Array<{ id: number; fullName: string }> = [],
  repositoriesRemoved: Array<{ id: number; fullName: string }> = []
) {
  return {
    id,
    accountLogin: "acme",
    accountType: "Organization",
    repositoriesAdded,
    repositoriesRemoved
  };
}

function webhookDelivery(
  index: number,
  installationId: number,
  repositoriesAdded: Array<{ id: number; fullName: string }> = []
): WebhookDeliveryRow {
  return {
    id: `delivery-row-${String(index).padStart(3, "0")}`,
    deliveryId: `delivery-${String(index).padStart(3, "0")}`,
    event: "installation",
    action: "created",
    payloadJson: {
      installation: installationPayload(installationId, repositoriesAdded),
      receivedAt: new Date(Date.UTC(2026, 4, 25, 0, 0, index)).toISOString()
    },
    createdAt: new Date(Date.UTC(2026, 4, 25, 0, 0, index))
  };
}

function createPrismaMock(
  rows: InstallationRow[] = [],
  deliveries: WebhookDeliveryRow[] = [],
  repositories: RepositoryRow[] = []
) {
  const repositoryUpserts: unknown[] = [];
  const repositoryArchiveCalls: unknown[] = [];
  const prisma = {
    organization: {
      upsert: vi.fn(async (input: unknown) => input)
    },
    gitHubInstallation: {
      findUnique: vi.fn(async ({ where }: { where: { githubInstallationId: bigint } }) => {
        return rows.find((row) => row.githubInstallationId === where.githubInstallationId) ?? null;
      }),
      findFirst: vi.fn(async ({ where }: { where: { id?: string; organizationId?: string } }) => {
        return (
          rows.find(
            (row) =>
              (where.id === undefined || row.id === where.id) &&
              (where.organizationId === undefined || row.organizationId === where.organizationId)
          ) ?? null
        );
      }),
      findMany: vi.fn(async ({ where }: { where: { organizationId: string } }) => {
        return rows.filter((row) => row.organizationId === where.organizationId);
      }),
      create: vi.fn(async ({ data }: { data: Partial<InstallationRow> }) => {
        const now = new Date("2026-05-25T00:00:00.000Z");
        const row = installationRow({
          id: `installation-${rows.length + 1}`,
          githubInstallationId: data.githubInstallationId ?? BigInt(rows.length + 1),
          organizationId: data.organizationId ?? null,
          accountLogin: data.accountLogin ?? "installation",
          accountType: data.accountType ?? "Organization",
          status: data.status ?? "pending_approval",
          approvedBy: data.approvedBy ?? null,
          approvedAt: data.approvedAt ?? null,
          rejectedBy: data.rejectedBy ?? null,
          rejectedAt: data.rejectedAt ?? null,
          archivedAt: data.archivedAt ?? null,
          lastWebhookAt: data.lastWebhookAt ?? now,
          createdAt: now,
          updatedAt: now
        });
        rows.push(row);
        return row;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<InstallationRow> }) => {
          const row = rows.find((candidate) => candidate.id === where.id);
          if (!row) {
            throw new Error("row not found");
          }
          Object.assign(row, data, { updatedAt: new Date("2026-05-25T00:00:00.000Z") });
          return row;
        }
      ),
      upsert: vi.fn(
        async ({
          where,
          update,
          create
        }: {
          where: { githubInstallationId: bigint };
          update: Partial<InstallationRow>;
          create: Partial<InstallationRow> & { githubInstallationId: bigint };
        }) => {
          const row = rows.find(
            (candidate) => candidate.githubInstallationId === where.githubInstallationId
          );
          if (row) {
            Object.assign(row, update, { updatedAt: new Date("2026-05-25T00:00:00.000Z") });
            return row;
          }
          const now = new Date("2026-05-25T00:00:00.000Z");
          const created = installationRow({
            id: `installation-${rows.length + 1}`,
            githubInstallationId: create.githubInstallationId,
            organizationId: create.organizationId ?? null,
            accountLogin: create.accountLogin ?? "installation",
            accountType: create.accountType ?? "Organization",
            status: create.status ?? "pending_approval",
            approvedBy: create.approvedBy ?? null,
            approvedAt: create.approvedAt ?? null,
            rejectedBy: create.rejectedBy ?? null,
            rejectedAt: create.rejectedAt ?? null,
            archivedAt: create.archivedAt ?? null,
            lastWebhookAt: create.lastWebhookAt ?? now,
            createdAt: now,
            updatedAt: now
          });
          rows.push(created);
          return created;
        }
      )
    },
    repository: {
      findUnique: vi.fn(
        async ({
          where
        }: {
          where: {
            githubRepositoryId?: bigint;
            organizationId_fullName?: { organizationId: string; fullName: string };
          };
        }) => {
          if (where.githubRepositoryId !== undefined) {
            return (
              repositories.find(
                (repository) => repository.githubRepositoryId === where.githubRepositoryId
              ) ?? null
            );
          }
          if (!where.organizationId_fullName) {
            return null;
          }
          const scopedName = where.organizationId_fullName;
          return (
            repositories.find(
              (repository) =>
                repository.organizationId === scopedName.organizationId &&
                repository.fullName === scopedName.fullName
            ) ?? null
          );
        }
      ),
      upsert: vi.fn(async (input: unknown) => {
        repositoryUpserts.push(input);
        const upsert = input as {
          where: {
            githubRepositoryId?: bigint;
            organizationId_fullName?: { organizationId: string; fullName: string };
          };
          update: Partial<RepositoryRow>;
          create: RepositoryRow & { githubRepositoryId: bigint };
        };
        const existing = repositories.find((repository) => {
          if (upsert.where.githubRepositoryId !== undefined) {
            return repository.githubRepositoryId === upsert.where.githubRepositoryId;
          }
          return (
            upsert.where.organizationId_fullName !== undefined &&
            repository.organizationId === upsert.where.organizationId_fullName.organizationId &&
            repository.fullName === upsert.where.organizationId_fullName.fullName
          );
        });
        if (existing) {
          Object.assign(existing, upsert.update);
          return existing;
        }
        const created = {
          ...upsert.create,
          enabled: upsert.create.enabled ?? true,
          archivedAt: upsert.create.archivedAt ?? null,
          mode: upsert.create.mode ?? null
        };
        repositories.push(created);
        return created;
      }),
      updateMany: vi.fn(async (input: unknown) => {
        repositoryArchiveCalls.push(input);
        return { count: 0 };
      })
    },
    webhookDelivery: {
      findMany: vi.fn(
        async ({
          take,
          cursor,
          where
        }: {
          take: number;
          cursor?: { id: string } | undefined;
          where?: {
            event?: { in?: string[] };
            OR?: Array<{ payloadJson?: { path?: string[]; equals?: unknown } }>;
          };
        }) => {
          const eventFilter = where?.event?.in;
          const installationIdFilters =
            where?.OR?.map((filter) => filter.payloadJson?.equals).filter(
              (value) => value !== undefined
            ) ?? [];
          const scopedDeliveries = deliveries.filter((delivery) => {
            if (eventFilter && !eventFilter.includes(delivery.event)) {
              return false;
            }
            const payload = delivery.payloadJson as
              { installation?: { id?: string | number | bigint } } | null | undefined;
            if (installationIdFilters.length === 0) {
              return true;
            }
            return installationIdFilters.some(
              (expected) => String(payload?.installation?.id) === String(expected)
            );
          });
          const sorted = [...scopedDeliveries].sort((left, right) => {
            const createdDelta = left.createdAt.getTime() - right.createdAt.getTime();
            return createdDelta === 0 ? left.id.localeCompare(right.id) : createdDelta;
          });
          const start = cursor
            ? Math.max(sorted.findIndex((delivery) => delivery.id === cursor.id) + 1, 0)
            : 0;
          return sorted.slice(start, start + take);
        }
      )
    }
  };
  return { prisma, repositoryArchiveCalls, repositoryUpserts, rows };
}

describe("GitHub installation tenancy", () => {
  it("requires webhook-confirmed or manually described installation details before verification", async () => {
    const { prisma, rows } = createPrismaMock();

    await expect(
      testInternals.upsertPendingGithubInstallation(prisma as never, {
        githubInstallationId: "12345",
        accountType: "Organization",
        organizationId: "org-a"
      })
    ).resolves.toBeUndefined();
    expect(rows).toHaveLength(0);
  });

  it("claims webhook-confirmed callback verification for the actor organization", async () => {
    const { prisma, rows } = createPrismaMock([
      installationRow({
        id: "installation-a",
        organizationId: null,
        githubInstallationId: 12345n,
        accountLogin: "acme-webhook"
      })
    ]);

    const installation = await testInternals.upsertPendingGithubInstallation(prisma as never, {
      githubInstallationId: "12345",
      accountType: "Organization",
      organizationId: "org-a"
    });

    expect(installation).toMatchObject({
      organizationId: "org-a",
      accountLogin: "acme-webhook",
      status: "pending_approval"
    });
    expect(rows[0]?.organizationId).toBe("org-a");
  });

  it("claims manually described installation verification for the actor organization", async () => {
    const { prisma, rows } = createPrismaMock();

    const installation = await testInternals.upsertPendingGithubInstallation(prisma as never, {
      githubInstallationId: "12345",
      accountLogin: "acme",
      accountType: "Organization",
      organizationId: "org-a"
    });

    expect(installation).toMatchObject({
      organizationId: "org-a",
      githubInstallationId: "12345",
      status: "pending_approval"
    });
    expect(rows[0]?.organizationId).toBe("org-a");
  });

  it("clears stale rejected state when verification reopens an installation", async () => {
    const { prisma, rows } = createPrismaMock([
      installationRow({
        id: "installation-a",
        organizationId: "org-a",
        githubInstallationId: 12345n,
        status: "rejected",
        rejectedBy: "admin-a",
        rejectedAt: new Date("2026-05-24T00:00:00.000Z"),
        archivedAt: new Date("2026-05-24T00:00:00.000Z")
      })
    ]);

    const installation = await testInternals.upsertPendingGithubInstallation(prisma as never, {
      githubInstallationId: "12345",
      accountLogin: "acme",
      accountType: "Organization",
      organizationId: "org-a"
    });

    expect(installation).toMatchObject({
      status: "pending_approval"
    });
    expect(installation).not.toHaveProperty("rejectedBy");
    expect(installation).not.toHaveProperty("rejectedAt");
    expect(installation).not.toHaveProperty("archivedAt");
    expect(rows[0]).toMatchObject({
      status: "pending_approval",
      rejectedBy: null,
      rejectedAt: null,
      archivedAt: null
    });
  });

  it("preserves approved state while clearing stale rejection fields during verification", async () => {
    const approvedAt = new Date("2026-05-23T00:00:00.000Z");
    const { prisma, rows } = createPrismaMock([
      installationRow({
        id: "installation-a",
        organizationId: "org-a",
        githubInstallationId: 12345n,
        status: "approved",
        approvedBy: "admin-a",
        approvedAt,
        rejectedBy: "stale-admin",
        rejectedAt: new Date("2026-05-24T00:00:00.000Z")
      })
    ]);

    const installation = await testInternals.upsertPendingGithubInstallation(prisma as never, {
      githubInstallationId: "12345",
      accountLogin: "acme",
      accountType: "Organization",
      organizationId: "org-a"
    });

    expect(installation).toMatchObject({
      status: "approved",
      approvedBy: "admin-a",
      approvedAt: approvedAt.toISOString()
    });
    expect(installation).not.toHaveProperty("rejectedBy");
    expect(installation).not.toHaveProperty("rejectedAt");
    expect(rows[0]).toMatchObject({
      status: "approved",
      approvedBy: "admin-a",
      approvedAt,
      rejectedBy: null,
      rejectedAt: null
    });
  });

  it("rejects attempts to claim or decide another tenant's installation", async () => {
    const { prisma } = createPrismaMock([
      installationRow({
        id: "installation-a",
        organizationId: "org-a",
        githubInstallationId: 12345n
      })
    ]);

    await expect(
      testInternals.upsertPendingGithubInstallation(prisma as never, {
        githubInstallationId: "12345",
        accountLogin: "acme",
        accountType: "Organization",
        organizationId: "org-b"
      })
    ).resolves.toBeUndefined();
    await expect(
      testInternals.approveGithubInstallation(prisma as never, {
        id: "installation-a",
        organizationId: "org-b",
        actor: "admin-b"
      })
    ).resolves.toBeUndefined();
    await expect(
      testInternals.rejectGithubInstallation(prisma as never, {
        id: "installation-a",
        organizationId: "org-b",
        actor: "admin-b"
      })
    ).resolves.toBeUndefined();
  });

  it("lists only installations for the requested organization", async () => {
    const { prisma } = createPrismaMock([
      installationRow({
        id: "installation-a",
        organizationId: "org-a",
        githubInstallationId: 12345n
      }),
      installationRow({
        id: "installation-b",
        organizationId: "org-b",
        githubInstallationId: 67890n
      })
    ]);

    await expect(testInternals.listGithubInstallations(prisma as never, "org-b")).resolves.toEqual([
      expect.objectContaining({ id: "installation-b", organizationId: "org-b" })
    ]);
  });

  it("clears stale approval state when rejecting an installation", async () => {
    const { prisma, rows } = createPrismaMock([
      installationRow({
        id: "installation-a",
        organizationId: "org-a",
        githubInstallationId: 12345n,
        status: "approved",
        approvedBy: "admin-a",
        approvedAt: new Date("2026-05-24T00:00:00.000Z")
      })
    ]);

    const installation = await testInternals.rejectGithubInstallation(prisma as never, {
      id: "installation-a",
      organizationId: "org-a",
      actor: "admin-b"
    });

    expect(installation).toMatchObject({
      status: "rejected",
      rejectedBy: "admin-b"
    });
    expect(installation).not.toHaveProperty("approvedBy");
    expect(installation).not.toHaveProperty("approvedAt");
    expect(rows[0]).toMatchObject({
      status: "rejected",
      approvedBy: null,
      approvedAt: null,
      rejectedBy: "admin-b"
    });
  });
});

describe("GitHub installation webhook transitions", () => {
  it("archives installations only for installation delete or suspend webhooks", async () => {
    const { prisma, rows } = createPrismaMock([
      installationRow({
        id: "installation-a",
        organizationId: "org-a",
        githubInstallationId: 12345n,
        status: "approved"
      })
    ]);

    await testInternals.processGithubInstallationWebhook(
      { repositorySettings: new Map() } as never,
      prisma as never,
      {
        deliveryId: "delivery-1",
        event: "installation_repositories",
        action: "deleted",
        installation: installationPayload(12345),
        receivedAt: "2026-05-25T00:00:00.000Z"
      } as never
    );

    expect(rows[0]).toMatchObject({
      status: "approved",
      archivedAt: null
    });
  });

  it("clears archived state when an installation becomes active again", async () => {
    const { prisma, rows } = createPrismaMock([
      installationRow({
        id: "installation-a",
        organizationId: "org-a",
        githubInstallationId: 12345n,
        status: "archived",
        archivedAt: new Date("2026-05-24T00:00:00.000Z")
      })
    ]);

    await testInternals.processGithubInstallationWebhook(
      { repositorySettings: new Map() } as never,
      prisma as never,
      {
        deliveryId: "delivery-1",
        event: "installation",
        action: "created",
        installation: installationPayload(12345),
        receivedAt: "2026-05-25T00:00:00.000Z"
      } as never
    );

    expect(rows[0]).toMatchObject({
      status: "pending_approval",
      archivedAt: null
    });
  });
});

describe("GitHub installation repository replay", () => {
  it("continues live repository pagination beyond the first ten pages", () => {
    expect(
      testInternals.githubInstallationRepositoryPageState({
        body: { total_count: 1_250 },
        pageRepositoryCount: 100,
        repositoriesSeen: 1_000
      })
    ).toEqual({ complete: false, exceedsSafetyLimit: false });
    expect(
      testInternals.githubInstallationRepositoryPageState({
        body: { total_count: 1_250 },
        pageRepositoryCount: 50,
        repositoriesSeen: 1_250
      })
    ).toEqual({ complete: true, exceedsSafetyLimit: false });
  });

  it("fails closed before archiving stale repositories when live repository scope exceeds the safety limit", () => {
    expect(
      testInternals.githubInstallationRepositoryPageState({
        body: { total_count: 10_001 },
        pageRepositoryCount: 100,
        repositoriesSeen: 10_000
      })
    ).toEqual({ complete: false, exceedsSafetyLimit: true });
  });

  it("replays all stored installation events chronologically across pages", async () => {
    const deliveries = Array.from({ length: 251 }, (_value, index) =>
      webhookDelivery(index, 12345, [
        {
          id: index + 1,
          fullName: `acme/repo-${String(index).padStart(3, "0")}`
        }
      ])
    ).reverse();
    const { prisma, repositoryUpserts } = createPrismaMock(
      [
        installationRow({
          id: "installation-a",
          organizationId: "org-a",
          githubInstallationId: 12345n,
          status: "approved"
        })
      ],
      deliveries
    );

    await testInternals.syncRepositoriesFromStoredInstallationEvents(
      { repositorySettings: new Map() } as never,
      prisma as never,
      { organizationId: "org-a", githubInstallationId: "12345" }
    );

    expect(prisma.webhookDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          event: { in: ["installation", "installation_repositories"] },
          OR: expect.arrayContaining([
            {
              payloadJson: {
                path: ["installation", "id"],
                equals: 12345
              }
            }
          ])
        })
      })
    );
    expect(repositoryUpserts).toHaveLength(251);
    expect(repositoryUpserts[0]).toMatchObject({
      create: { fullName: "acme/repo-000" }
    });
    expect(repositoryUpserts.at(-1)).toMatchObject({
      create: { fullName: "acme/repo-250" }
    });
  });

  it("keeps existing admin-disabled repositories disabled in runtime sync state", async () => {
    const deliveries = [webhookDelivery(0, 12345, [{ id: 1, fullName: "acme/disabled" }])];
    const { prisma } = createPrismaMock(
      [
        installationRow({
          id: "installation-a",
          organizationId: "org-a",
          githubInstallationId: 12345n,
          status: "approved"
        })
      ],
      deliveries,
      [
        {
          id: "repo_disabled",
          organizationId: "org-a",
          githubRepositoryId: 1n,
          fullName: "acme/disabled",
          enabled: false,
          archivedAt: null,
          mode: null
        }
      ]
    );
    const state = { repositorySettings: new Map() };

    await testInternals.syncRepositoriesFromStoredInstallationEvents(
      state as never,
      prisma as never,
      { organizationId: "org-a", githubInstallationId: "12345" }
    );

    expect(state.repositorySettings.get("repo_disabled")).toMatchObject({
      enabled: false
    });
  });
});

describe("repository archive preservation", () => {
  it("does not silently unarchive repositories unless requested", async () => {
    const { prisma, repositoryUpserts } = createPrismaMock();
    const input = {
      organizationId: "org-a",
      repositoryId: "repo_acme_payments",
      fullName: "acme/payments",
      defaultBranch: "main"
    };

    await testInternals.ensureRepository(prisma as never, input);
    await testInternals.ensureRepository(prisma as never, input, { forceUnarchive: true });

    expect(repositoryUpserts[0]).toMatchObject({
      update: { fullName: "acme/payments", defaultBranch: "main" }
    });
    expect(repositoryUpserts[0]).not.toMatchObject({
      update: expect.objectContaining({ archivedAt: null })
    });
    expect(repositoryUpserts[1]).toMatchObject({
      update: {
        defaultBranch: "main",
        archivedAt: null,
        archiveReason: null
      }
    });
    expect(repositoryUpserts[1]).not.toMatchObject({
      update: expect.objectContaining({ enabled: true })
    });
  });

  it("preserves disabled repositories during installation sync unless they were archived", async () => {
    const repositories: RepositoryRow[] = [
      {
        id: "repo_disabled",
        organizationId: "org-a",
        githubRepositoryId: 101n,
        fullName: "acme/disabled",
        enabled: false,
        archivedAt: null,
        mode: null
      },
      {
        id: "repo_archived",
        organizationId: "org-a",
        githubRepositoryId: 102n,
        fullName: "acme/archived",
        enabled: false,
        archivedAt: new Date("2026-05-24T00:00:00.000Z"),
        mode: null
      }
    ];
    const { prisma } = createPrismaMock([], [], repositories);

    await testInternals.ensureRepository(
      prisma as never,
      {
        organizationId: "org-a",
        repositoryId: "repo_disabled",
        fullName: "acme/disabled",
        defaultBranch: "main",
        githubRepositoryId: 101n
      },
      { forceUnarchive: true }
    );
    await testInternals.ensureRepository(
      prisma as never,
      {
        organizationId: "org-a",
        repositoryId: "repo_archived",
        fullName: "acme/archived",
        defaultBranch: "main",
        githubRepositoryId: 102n
      },
      { forceUnarchive: true }
    );

    expect(repositories[0]).toMatchObject({
      enabled: false,
      archivedAt: null
    });
    expect(repositories[1]).toMatchObject({
      enabled: true,
      archivedAt: null
    });
  });

  it("keeps repository history when GitHub reports a rename for the same immutable id", async () => {
    const repositories: RepositoryRow[] = [
      {
        id: "repo_renamed",
        organizationId: "org-a",
        githubRepositoryId: 201n,
        fullName: "acme/old-name",
        enabled: true,
        archivedAt: null,
        mode: null
      }
    ];
    const { prisma } = createPrismaMock([], [], repositories);

    await testInternals.ensureRepository(
      prisma as never,
      {
        organizationId: "org-a",
        repositoryId: "repo_acme_new_name",
        fullName: "acme/new-name",
        defaultBranch: "main",
        githubRepositoryId: 201n
      },
      { forceUnarchive: true }
    );

    expect(repositories).toHaveLength(1);
    expect(repositories[0]).toMatchObject({
      id: "repo_renamed",
      fullName: "acme/new-name",
      enabled: true,
      archivedAt: null
    });
  });
});
