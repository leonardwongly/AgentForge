import { describe, expect, it } from "vitest";
import type { ChangeControlRecord, VerifiedFact } from "@agentforge/core";

import {
  buildAuditStreamPayload,
  buildNotificationPayload,
  deliverWebhook,
  streamAuditEvents
} from "./index.js";

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{ ok: boolean; status: number }>;

function finding(type: VerifiedFact["type"], id: string): VerifiedFact {
  return { id, type, source: "github_diff", evidence: "evidence", confidence: "verified" };
}

function record(lifecycle: ChangeControlRecord["lifecycle"]): ChangeControlRecord {
  return {
    id: "r1",
    revision: 1,
    organizationId: "org",
    repositoryId: "repo",
    repositoryFullName: "acme/repo",
    pullRequestNumber: 42,
    headSha: "abc",
    baseBranch: "main",
    mode: "enforce",
    policyVersion: "1",
    verifiedFindings: [finding("sensitive_path_changed", "f1")],
    requiredEvidence: [],
    requiredReviewers: [],
    checkStatus: "block",
    lifecycle,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("buildNotificationPayload", () => {
  it("builds a structured pr_blocked payload", () => {
    const payload = buildNotificationPayload({
      event: "pr_blocked",
      record: record("blocked"),
      detailsUrl: "https://app/records/r1"
    });
    expect(payload.event).toBe("pr_blocked");
    expect(payload.repositoryFullName).toBe("acme/repo");
    expect(payload.pullRequestNumber).toBe(42);
    expect(payload.checkStatus).toBe("block");
    expect(payload.summary).toContain("blocked acme/repo#42");
    expect(payload.findings[0]?.type).toBe("sensitive_path_changed");
    expect(payload.detailsUrl).toBe("https://app/records/r1");
  });

  it("summarizes evidence_required", () => {
    const payload = buildNotificationPayload({ event: "evidence_required", record: record("blocked") });
    expect(payload.summary).toContain("Evidence required");
  });
});

describe("deliverWebhook", () => {
  it("posts a JSON payload and reports success", async () => {
    const fetchImpl: FetchLike = async (_url, init) => {
      expect(typeof init?.body).toBe("string");
      return { ok: true, status: 200 };
    };
    const result = await deliverWebhook("https://hooks.example/x", { a: 1 }, {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it("retries and reports failure without throwing", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("network down");
    };
    const result = await deliverWebhook("https://hooks.example/x", {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retries: 1
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("network down");
  });
});

describe("audit stream", () => {
  it("builds a tamper-evident stream payload with a digest", () => {
    const events = [
      {
        id: "e1",
        schemaVersion: 1,
        organizationId: "org",
        actor: "admin",
        actorRole: "platform_admin",
        action: "override_created" as const,
        targetType: "change_control_record",
        targetId: "r1",
        source: "api" as const,
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    ];
    const payload = buildAuditStreamPayload(events, "2026-01-01T00:00:00.000Z");
    expect(payload.eventCount).toBe(1);
    expect(payload.digest).toBeTruthy();
    expect(payload.events[0]?.metadataJson?.auditChain).toBeTruthy();
  });

  it("streams via deliverWebhook", async () => {
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200 });
    const result = await streamAuditEvents("https://splunk.example/h", [], {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result.ok).toBe(true);
  });
});
