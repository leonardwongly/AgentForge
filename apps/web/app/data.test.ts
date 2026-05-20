import { afterEach, describe, expect, it, vi } from "vitest";
import {
  governanceDisposition,
  governanceDecisionLabel,
  hasOpenRequirements,
  isObservePassWithOpenRequirements,
  loadDashboardData,
  loadSettings,
  openRequirementCounts,
  summarizeEvidenceRequirements,
  summarizeFindings,
  loadRecord,
  summarizeReviewerRequirements
} from "./data";
import type { ChangeControlRecord } from "@agentforge/core";

describe("dashboard API data loaders", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats an empty dashboard API response as an actionable empty state", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.cache).toBe("no-store");
      expect(init?.headers).toEqual({ accept: "application/json" });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse({ records: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const data = await loadDashboardData();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4000/api/dashboard/records?limit=50&offset=0&sort=updated_desc",
      expect.objectContaining({ cache: "no-store" })
    );
    expect(data).toMatchObject({
      records: [],
      source: "empty"
    });
    expect(data.message).toContain("No evaluated PRs");
  });

  it("returns an unavailable dashboard state when the API responds with an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503, statusText: "Unavailable" }))
    );

    const data = await loadDashboardData();

    expect(data).toMatchObject({
      records: [],
      source: "unavailable"
    });
    expect(data.message).toContain("503 Unavailable");
  });

  it("returns unavailable settings without throwing when the API cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:4000");
      })
    );

    const data = await loadSettings();

    expect(data).toMatchObject({
      settings: undefined,
      source: "unavailable"
    });
    expect(data.message).toContain("Settings API unavailable");
  });

  it("treats missing record lookups as empty instead of API unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404, statusText: "Not Found" }))
    );

    const data = await loadRecord("missing-record");

    expect(data).toMatchObject({
      records: [],
      item: undefined,
      source: "empty",
      message: "No matching Change Control Record was found."
    });
  });

  it("summarizes repeated findings and requirements for dense tables", () => {
    expect(
      summarizeFindings([
        fact("1", "sensitive_path_changed"),
        fact("2", "sensitive_path_changed"),
        fact("3", "agent_signal_detected"),
        fact("4", "migration_added"),
        fact("5", "dependency_added"),
        fact("6", "test_deleted")
      ])
    ).toBe("sensitive path changed x2, dependency added, migration added +1 more");

    expect(
      summarizeEvidenceRequirements([
        evidence("1", "rollback_plan"),
        evidence("2", "rollback_plan"),
        evidence("3", "security_note"),
        evidence("4", "migration_dry_run")
      ])
    ).toBe("rollback plan x2, migration dry run, security note");

    expect(
      summarizeReviewerRequirements([
        reviewer("1", "security-team"),
        reviewer("2", "security-team"),
        reviewer("3", "platform-team")
      ])
    ).toBe("security-team x2, platform-team");
  });

  it("distinguishes observe-mode passing checks from completed governance", () => {
    const record = recordWithOpenRequirements();

    expect(openRequirementCounts(record)).toEqual({ evidence: 1, reviewers: 1, total: 2 });
    expect(hasOpenRequirements(record)).toBe(true);
    expect(isObservePassWithOpenRequirements(record)).toBe(true);
    expect(governanceDisposition(record)).toEqual({
      status: "warn",
      label: "observe pass; requirements open",
      detail:
        "1 evidence requirement and 1 reviewer requirement remain open and would block in enforce or optimize mode."
    });
  });

  it("omits zero-count requirement groups from observe-mode detail text", () => {
    const evidenceOnly = recordWithOpenRequirements({ reviewers: 0 });
    const reviewersOnly = recordWithOpenRequirements({ evidence: 0 });

    expect(governanceDisposition(evidenceOnly).detail).toBe(
      "1 evidence requirement remains open and would block in enforce or optimize mode."
    );
    expect(governanceDisposition(reviewersOnly).detail).toBe(
      "1 reviewer requirement remains open and would block in enforce or optimize mode."
    );
  });

  it("does not present open-requirement governance as a final passed decision", () => {
    expect(governanceDecisionLabel(recordWithOpenRequirements())).toBe(
      "observing; requirements open"
    );
    expect(governanceDecisionLabel({ ...recordWithOpenRequirements(), mode: "warn" })).toBe(
      "warning; requirements open"
    );
    expect(
      governanceDecisionLabel({
        ...recordWithOpenRequirements({ evidence: 0, reviewers: 0 }),
        decision: { status: "passed" }
      })
    ).toBe("passed");
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json"
    }
  });
}

function fact(
  id: string,
  type: Parameters<typeof summarizeFindings>[0][number]["type"]
): Parameters<typeof summarizeFindings>[0][number] {
  return {
    id,
    type,
    source: "github_diff",
    evidence: "test",
    confidence: "verified",
    severity: "medium"
  };
}

function evidence(
  id: string,
  kind: Parameters<typeof summarizeEvidenceRequirements>[0][number]["kind"]
): Parameters<typeof summarizeEvidenceRequirements>[0][number] {
  return {
    id,
    kind,
    status: "missing",
    requiredByFindingId: "finding-1"
  };
}

function reviewer(
  id: string,
  name: string
): Parameters<typeof summarizeReviewerRequirements>[0][number] {
  return {
    id,
    reviewer: name,
    reviewerType: "team",
    tier: "required",
    reason: "required",
    triggeredByFindingId: "finding-1",
    approved: false
  };
}

function recordWithOpenRequirements({
  evidence: evidenceCount = 1,
  reviewers: reviewerCount = 1
}: {
  evidence?: number;
  reviewers?: number;
} = {}): ChangeControlRecord {
  return {
    id: "record-1",
    organizationId: "org-1",
    repositoryId: "repo-1",
    repositoryFullName: "acme/payments",
    pullRequestNumber: 42,
    headSha: "sha",
    baseBranch: "main",
    mode: "observe",
    policyVersion: "fintech@1.0.0",
    verifiedFindings: [fact("finding-1", "sensitive_path_changed")],
    requiredEvidence:
      evidenceCount === 0
        ? []
        : Array.from({ length: evidenceCount }, (_, index) =>
            evidence(`evidence-${index + 1}`, "rollback_plan")
          ),
    requiredReviewers:
      reviewerCount === 0
        ? []
        : Array.from({ length: reviewerCount }, (_, index) =>
            reviewer(`reviewer-${index + 1}`, "security-team")
          ),
    checkStatus: "pass",
    lifecycle: "passed",
    decision: { status: "passed" },
    createdAt: "2026-05-18T00:00:00.000Z",
    updatedAt: "2026-05-18T00:00:00.000Z"
  };
}
