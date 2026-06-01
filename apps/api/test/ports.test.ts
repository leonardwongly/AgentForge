import { describe, expect, it } from "vitest";
import type { AuditEventRecord, ChangeControlRecord, OverrideRecord } from "@agentforge/core";
import type { GithubWebhookEnvelope } from "@agentforge/github";
import { createInMemoryPersistencePort, hasCompleteWebhookReplayTarget } from "../src/ports.js";

function record(id: string, organizationId: string): ChangeControlRecord {
  return {
    id,
    organizationId,
    repositoryId: "repo",
    repositoryFullName: "acme/app",
    pullRequestNumber: 1,
    headSha: "sha",
    baseBranch: "main",
    mode: "warn",
    policyVersion: "fintech@1.0.0",
    verifiedFindings: [],
    requiredEvidence: [],
    requiredReviewers: [],
    checkStatus: "pass",
    lifecycle: "passed",
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z"
  };
}

function audit(id: string, organizationId: string): AuditEventRecord {
  return {
    id,
    schemaVersion: 1,
    organizationId,
    actor: "sam",
    actorRole: "platform_admin",
    action: "policy_changed",
    targetType: "policy",
    targetId: "t",
    source: "api",
    createdAt: "2026-05-12T00:00:00.000Z"
  };
}

function envelope(deliveryId: string): GithubWebhookEnvelope {
  return {
    deliveryId,
    event: "pull_request",
    action: "opened",
    installationId: 123,
    repository: {
      id: 456,
      fullName: "acme/app",
      owner: "acme",
      name: "app",
      defaultBranch: "main"
    },
    pullRequest: {
      id: 789,
      number: 1,
      title: "Change",
      authorLogin: "sam",
      baseBranch: "main",
      headBranch: "feature",
      headSha: "sha",
      body: "",
      state: "open",
      merged: false
    },
    receivedAt: "2026-05-12T00:00:00.000Z"
  };
}

describe("in-memory persistence port", () => {
  it("saves, gets, and lists records with tenant filtering", async () => {
    const port = createInMemoryPersistencePort();
    await port.records.save(record("r1", "org_a"));
    await port.records.save(record("r2", "org_b"));

    expect((await port.records.get("r1"))?.id).toBe("r1");
    expect(await port.records.get("missing")).toBeUndefined();
    expect(await port.records.list()).toHaveLength(2);
    expect(await port.records.list({ organizationId: "org_a" })).toHaveLength(1);

    const page = await port.records.page({
      limit: 1,
      offset: 0,
      organizationId: undefined,
      repositoryId: undefined,
      status: undefined,
      lifecycle: undefined,
      mode: undefined,
      policyVersion: undefined,
      queue: undefined,
      sort: "updated_desc"
    });
    expect(page.records).toHaveLength(1);
    expect(page.pageInfo).toMatchObject({ limit: 1, offset: 0, total: 2, hasMore: true });

    const tenantPage = await port.records.page({
      limit: 10,
      offset: 0,
      organizationId: "org_a",
      repositoryId: undefined,
      status: undefined,
      lifecycle: undefined,
      mode: undefined,
      policyVersion: undefined,
      queue: undefined,
      sort: "updated_desc"
    });
    expect(tenantPage.records.map((item) => item.id)).toEqual(["r1"]);
    expect(tenantPage.pageInfo).toMatchObject({ total: 1, hasMore: false });
  });

  it("appends and lists audit events with tenant filtering", async () => {
    const port = createInMemoryPersistencePort();
    await port.auditEvents.append({
      ...audit("a1", "org_a"),
      repositoryId: "repo",
      targetType: "change_control_record",
      targetId: "r1"
    });
    await port.auditEvents.append(audit("a2", "org_b"));

    expect(await port.auditEvents.list()).toHaveLength(2);
    expect(await port.auditEvents.list({ organizationId: "org_b" })).toHaveLength(1);
    expect(await port.auditEvents.listForRecordExport([record("r1", "org_a")])).toMatchObject([
      { id: "a1" }
    ]);
  });

  it("records webhook delivery lifecycle and finds tenant-scoped replays", async () => {
    const state = {
      records: [record("r1", "org_a")],
      auditEvents: [],
      exports: [],
      overrides: [],
      deliveries: new Set<string>(),
      queuedEvaluations: [
        {
          deliveryId: "delivery-1",
          envelope: envelope("delivery-1"),
          queuedAt: "2026-05-12T00:00:00.000Z"
        }
      ]
    };
    const port = createInMemoryPersistencePort(state);

    await expect(port.webhookDeliveries.recordReceived(envelope("delivery-1"))).resolves.toEqual({
      duplicate: false,
      status: "received"
    });
    await expect(port.webhookDeliveries.recordReceived(envelope("delivery-1"))).resolves.toEqual({
      duplicate: true,
      status: "queued"
    });
    await expect(
      port.webhookDeliveries.findReplayable({ deliveryId: "delivery-1" }, "org_a")
    ).resolves.toMatchObject({
      delivery: {
        deliveryId: "delivery-1",
        organizationId: "org_a",
        repositoryFullName: "acme/app",
        pullRequestNumber: 1
      }
    });
    await expect(
      port.webhookDeliveries.findReplayable(
        { repositoryFullName: "acme/app", pullRequestNumber: 1 },
        "org_b"
      )
    ).resolves.toBeUndefined();
    await expect(
      port.webhookDeliveries.findReplayable({ repositoryFullName: "acme/app" }, "org_a")
    ).resolves.toBeUndefined();
    expect(hasCompleteWebhookReplayTarget({ repositoryFullName: "acme/app" })).toBe(false);
    expect(
      hasCompleteWebhookReplayTarget({ repositoryFullName: "acme/app", pullRequestNumber: 1 })
    ).toBe(true);
    await expect(port.webhookDeliveries.listRecentFailures("org_a")).resolves.toEqual([]);
  });

  it("saves and gets export jobs through the port", async () => {
    const port = createInMemoryPersistencePort();
    const job = {
      id: "export-1",
      organizationId: "org_a",
      status: "completed" as const,
      format: "json" as const,
      recordCount: 2,
      totalMatchingRecords: 3,
      truncated: true,
      content: '{"records":[]}',
      createdAt: "2026-05-12T00:00:00.000Z"
    };

    await port.exportJobs.save(job, { actor: "sam", actorRole: "auditor" });

    await expect(port.exportJobs.get("export-1")).resolves.toEqual(job);
    await expect(port.exportJobs.get("missing")).resolves.toBeUndefined();
  });

  it("saves overrides through the port", async () => {
    const state = {
      records: [],
      auditEvents: [],
      exports: [],
      overrides: [],
      deliveries: new Set<string>(),
      queuedEvaluations: []
    };
    const port = createInMemoryPersistencePort(state);
    const override: OverrideRecord = {
      id: "override-1",
      pullRequestId: "r1",
      actor: "sam",
      actorRole: "platform_admin",
      reason: "False positive after review.",
      scope: "pr",
      visibleInPr: true,
      policyVersion: "fintech@1.0.0",
      createdAt: "2026-05-12T00:00:00.000Z"
    };

    await port.overrides.save(override);

    expect(state.overrides).toEqual([override]);
  });
});
