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

function createPrismaMock(rows: InstallationRow[] = []) {
  const repositoryUpserts: unknown[] = [];
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
      )
    },
    repository: {
      upsert: vi.fn(async (input: unknown) => {
        repositoryUpserts.push(input);
        return { id: "repo_acme_payments", mode: null };
      })
    }
  };
  return { prisma, repositoryUpserts, rows };
}

describe("GitHub installation tenancy", () => {
  it("claims pending installation verification for the actor organization", async () => {
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
      update: { defaultBranch: "main" }
    });
    expect(repositoryUpserts[0]).not.toMatchObject({
      update: expect.objectContaining({ archivedAt: null })
    });
    expect(repositoryUpserts[1]).toMatchObject({
      update: {
        defaultBranch: "main",
        enabled: true,
        archivedAt: null,
        archiveReason: null
      }
    });
  });
});
