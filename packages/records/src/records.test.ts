import { describe, expect, it } from "vitest";
import type { PolicyResult, PullRequestInput } from "@agentforge/core";
import {
  applyOverride,
  createChangeControlRecord,
  exportChangeControlRecordsCsv,
  validateOverride
} from "./index.js";

const pr: PullRequestInput = {
  repositoryFullName: "acme/payments",
  pullRequestNumber: 1,
  title: "Billing",
  authorLogin: "sam",
  baseBranch: "main",
  headBranch: "feature/billing",
  headSha: "sha",
  changedFiles: []
};

const result: PolicyResult = {
  mode: "enforce",
  status: "block",
  policyVersion: "fintech@1.0.0",
  findings: [],
  requiredEvidence: [],
  requiredReviewers: [],
  explanation: [],
  evaluatedAt: "2026-05-12T00:00:00.000Z"
};

describe("records", () => {
  it("creates exportable change control records", () => {
    const record = createChangeControlRecord({
      organizationId: "org",
      repositoryId: "repo",
      pr,
      policyResult: result
    });
    expect(record.lifecycle).toBe("blocked");
    expect(exportChangeControlRecordsCsv([record])).toContain("repositoryFullName");
  });

  it("rejects unauthorized overrides", () => {
    expect(
      validateOverride(
        { actor: "sam", actorRole: "developer", reason: "needed", scope: "pr" },
        { allowedRoles: ["platform_admin"], requireReason: true, visibleInPr: true, audit: true }
      )
    ).toEqual({ ok: false, reason: "Actor role is not authorized for Merge Guard override." });
  });

  it("records authorized overrides", () => {
    const record = createChangeControlRecord({
      organizationId: "org",
      repositoryId: "repo",
      pr,
      policyResult: result
    });
    const output = applyOverride({
      record,
      pullRequestId: "pr",
      policy: {
        allowedRoles: ["platform_admin"],
        requireReason: true,
        visibleInPr: true,
        audit: true
      },
      override: {
        actor: "alex",
        actorRole: "platform_admin",
        reason: "Emergency rollback window approved.",
        scope: "pr"
      }
    });
    expect(output.record.lifecycle).toBe("overridden");
    expect(output.overrideRecord.policyVersion).toBe("fintech@1.0.0");
  });
});
