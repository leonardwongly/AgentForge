import { describe, expect, it } from "vitest";
import type { AuditEventRecord, ChangeControlRecord } from "@agentforge/core";
import { createInMemoryPersistencePort } from "../src/ports.js";

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

describe("in-memory persistence port", () => {
  it("saves, gets, and lists records with tenant filtering", async () => {
    const port = createInMemoryPersistencePort();
    await port.records.save(record("r1", "org_a"));
    await port.records.save(record("r2", "org_b"));

    expect((await port.records.get("r1"))?.id).toBe("r1");
    expect(await port.records.get("missing")).toBeUndefined();
    expect(await port.records.list()).toHaveLength(2);
    expect(await port.records.list({ organizationId: "org_a" })).toHaveLength(1);
  });

  it("appends and lists audit events with tenant filtering", async () => {
    const port = createInMemoryPersistencePort();
    await port.auditEvents.append(audit("a1", "org_a"));
    await port.auditEvents.append(audit("a2", "org_b"));

    expect(await port.auditEvents.list()).toHaveLength(2);
    expect(await port.auditEvents.list({ organizationId: "org_b" })).toHaveLength(1);
  });
});
