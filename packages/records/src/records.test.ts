import { describe, expect, it } from "vitest";
import type { PolicyResult, PullRequestInput } from "@agentforge/core";
import {
  applyOverride,
  createAuditEvent,
  createChangeControlRecord,
  exportChangeControlRecordsCsv,
  exportChangeControlRecordsJson,
  explainChangeControlRecord,
  updateRecordFromPolicyResult,
  validateOverride
} from "./index.js";

const fakeGithubToken = ["ghp", "x".repeat(36)].join("_");

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
  findings: [
    {
      id: "fact_secret",
      type: "secret_like_value_detected",
      source: "github_diff",
      path: "src/billing/checkout.ts",
      evidence: `Secret-like token detected: token=${fakeGithubToken}`,
      confidence: "observed",
      severity: "critical",
      metadata: {
        patch: `+ token=${fakeGithubToken}`,
        currentContent: `export const token = '${fakeGithubToken}';`
      }
    }
  ],
  requiredEvidence: [
    {
      id: "evidence_1",
      kind: "security_note",
      status: "missing",
      requiredByFindingId: "fact_secret"
    }
  ],
  requiredReviewers: [
    {
      id: "reviewer_1",
      reviewer: "security-team",
      reviewerType: "team",
      tier: "required",
      reason: "Secret-like value detected and redacted in changed content.",
      triggeredByFindingId: "fact_secret",
      approved: false
    }
  ],
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

  it("stores metadata only and redacts secret-like content by default", () => {
    const record = createChangeControlRecord({
      organizationId: "org",
      repositoryId: "repo",
      pr,
      policyResult: result
    });
    const serialized = JSON.stringify(record);

    expect(serialized).not.toContain(fakeGithubToken);
    expect(serialized).not.toContain("export const token");
    expect(serialized).not.toContain("patch");
    expect(record.verifiedFindings[0]?.metadata).toEqual({});
  });

  it("updates change control records after re-evaluation", () => {
    const record = createChangeControlRecord({
      organizationId: "org",
      repositoryId: "repo",
      pr,
      policyResult: result
    });
    const updated = updateRecordFromPolicyResult(
      record,
      {
        ...result,
        status: "pass",
        requiredEvidence: [],
        requiredReviewers: [],
        evaluatedAt: "2026-05-12T01:00:00.000Z"
      },
      "2026-05-12T01:00:01.000Z"
    );

    expect(updated.checkStatus).toBe("pass");
    expect(updated.lifecycle).toBe("passed");
    expect(updated.decision?.status).toBe("passed");
    expect(updated.updatedAt).toBe("2026-05-12T01:00:01.000Z");
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
    expect(output.overrideRecord).toMatchObject({
      actor: "alex",
      actorRole: "platform_admin",
      reason: "Emergency rollback window approved.",
      scope: "pr",
      policyVersion: "fintech@1.0.0"
    });
    expect(output.auditEvent).toMatchObject({
      action: "override_created",
      actor: "alex",
      metadataJson: expect.objectContaining({
        actorRole: "platform_admin",
        policyVersion: "fintech@1.0.0"
      })
    });
  });

  it("exports JSON and CSV without source code or raw secrets", () => {
    const record = createChangeControlRecord({
      organizationId: "org",
      repositoryId: "repo",
      pr,
      policyResult: result
    });
    const json = exportChangeControlRecordsJson([record]);
    const csv = exportChangeControlRecordsCsv([record]);

    expect(json).toContain("security_note");
    expect(csv).toContain("findingsJson");
    expect(csv).toContain("openEvidenceCount");
    for (const artifact of [json, csv]) {
      expect(artifact).not.toContain(fakeGithubToken);
      expect(artifact).not.toContain("export const token");
      expect(artifact).not.toContain("currentContent");
      expect(artifact).not.toContain("patch");
    }
  });

  it("includes applicable repository lifecycle events in record exports", () => {
    const record = createChangeControlRecord({
      organizationId: "org",
      repositoryId: "repo",
      pr,
      policyResult: result,
      now: "2026-05-12T01:00:00.000Z"
    });
    const settingEvent = createAuditEvent({
      organizationId: "org",
      repositoryId: "repo",
      actor: "alex",
      actorRole: "platform_admin",
      action: "repository_settings_changed",
      targetType: "repository",
      targetId: "repo",
      metadataJson: {
        enabled: true,
        mode: "enforce"
      },
      createdAt: "2026-05-12T00:30:00.000Z"
    });
    const futureEvent = createAuditEvent({
      organizationId: "org",
      repositoryId: "repo",
      actor: "alex",
      actorRole: "platform_admin",
      action: "repository_settings_changed",
      targetType: "repository",
      targetId: "repo",
      metadataJson: {
        enabled: true,
        mode: "observe"
      },
      createdAt: "2026-05-12T02:00:00.000Z"
    });

    const json = exportChangeControlRecordsJson([record], undefined, [settingEvent, futureEvent]);

    expect(json).toContain('"action": "repository_settings_changed"');
    expect(json).toContain('"mode": "enforce"');
    expect(json).not.toContain('"mode": "observe"');
  });

  it("links export lifecycle events to each exported record", () => {
    const record = createChangeControlRecord({
      organizationId: "org",
      repositoryId: "repo",
      pr,
      policyResult: result,
      now: "2026-05-12T01:00:00.000Z"
    });
    const event = createAuditEvent({
      organizationId: "org",
      actor: "alex",
      actorRole: "auditor",
      action: "record_exported",
      targetType: "change_control_records_export",
      targetId: "export-1",
      metadataJson: {
        format: "json",
        recordCount: 1,
        recordIds: [record.id]
      },
      createdAt: "2026-05-12T01:05:00.000Z"
    });

    const json = exportChangeControlRecordsJson([record], undefined, [event]);
    const csv = exportChangeControlRecordsCsv([record], undefined, [event]);

    expect(json).toContain('"action": "record_exported"');
    expect(csv).toContain("record_exported");
  });

  it("creates redacted audit events for governance actions", () => {
    const event = createAuditEvent({
      organizationId: "org",
      repositoryId: "repo",
      pullRequestId: "pr",
      actor: "alex",
      actorRole: "auditor",
      action: "record_exported",
      targetType: "change_control_record",
      targetId: "record",
      metadataJson: {
        format: "json",
        recordCount: 1,
        token: fakeGithubToken,
        patch: "+ raw source"
      },
      createdAt: "2026-05-12T00:00:00.000Z"
    });

    expect(event).toMatchObject({
      schemaVersion: 1,
      actorRole: "auditor",
      source: "api"
    });
    expect(event.metadataJson).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        actorRole: "auditor",
        source: "api",
        recordId: "record",
        format: "json",
        recordCount: 1,
        token: "[REDACTED]"
      })
    );
    expect(event.metadataJson).not.toHaveProperty("patch");
  });

  it("explains blocked and overridden decisions with explicit missing requirements", () => {
    const blocked = createChangeControlRecord({
      organizationId: "org",
      repositoryId: "repo",
      pr,
      policyResult: result
    });
    expect(explainChangeControlRecord(blocked)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Merge Guard blocked merge"),
        "Required evidence missing: security note.",
        "Reviewer approval required: security-team."
      ])
    );

    const overridden = applyOverride({
      record: blocked,
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
    }).record;

    expect(explainChangeControlRecord(overridden)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Authorized override recorded by alex"),
        "Override reason: Emergency rollback window approved."
      ])
    );
  });

  it("counts provided but unapproved evidence as open in CSV exports", () => {
    const record = createChangeControlRecord({
      organizationId: "org",
      repositoryId: "repo",
      pr,
      policyResult: {
        ...result,
        requiredEvidence: [
          {
            id: "evidence_1",
            kind: "security_note",
            status: "provided",
            requiredByFindingId: "fact_secret",
            providedBy: "sam",
            providedAt: "2026-05-12T00:00:00.000Z"
          }
        ]
      }
    });
    const csv = exportChangeControlRecordsCsv([record]);

    expect(csv.split("\n")[0]).toContain("openEvidenceCount");
    expect(csv.split("\n")[1]).toContain(",1,");
    expect(explainChangeControlRecord(record)).toContain(
      "Required evidence awaiting approval: security note."
    );
  });
});
