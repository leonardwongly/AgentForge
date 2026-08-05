import { describe, expect, it } from "vitest";
import type { PullRequestInput, PolicyResult, VerifiedFact } from "@agentforge/core";
import type { Cid } from "@agentforge/loom-core";
import type { DsseEnvelope } from "@agentforge/loom-provenance";
import type { TransformEvaluation } from "@agentforge/loom-ratify";
import { formatRatify, formatVerify } from "./format.js";
import type { CliVerifyResult, RatifyResult } from "./engine.js";

const cid = (value: string): Cid => value as Cid;

const fact: VerifiedFact = {
  id: "fact_1",
  type: "migration_added",
  source: "github_diff",
  evidence: "migration added",
  confidence: "verified",
  severity: "high"
};

const synthesizedInput: PullRequestInput = {
  repositoryFullName: "acme/loom",
  pullRequestNumber: 1,
  title: "Add migration",
  authorLogin: "alice",
  baseBranch: "main",
  headBranch: "feature",
  headSha: "sha",
  changedFiles: []
};

function policyResult(overrides: Partial<PolicyResult> = {}): PolicyResult {
  return {
    mode: "enforce",
    status: "block",
    policyVersion: "loom@1.0.0+abc",
    policyPackId: "loom",
    policyPackVersion: "1.0.0",
    findings: [fact],
    requiredEvidence: [],
    requiredReviewers: [],
    explanation: [],
    evaluatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

function evaluation(overrides: Partial<TransformEvaluation> = {}): TransformEvaluation {
  return {
    diff: [],
    facts: [fact],
    result: policyResult(),
    synthesizedInput,
    ...overrides
  };
}

function ratifyResult(overrides: Partial<RatifyResult> = {}): RatifyResult {
  return {
    evaluation: evaluation(),
    baseAddress: cid("cid:base"),
    resultAddress: cid("cid:result"),
    subjectAddress: cid("cid:subject"),
    ...overrides
  };
}

const envelope: DsseEnvelope = {
  payloadType: "application/vnd.in-toto+json",
  payload: "base64",
  signatures: [{ sig: "sig1" }]
};

describe("formatRatify", () => {
  it("renders the decision, addresses, and counts", () => {
    const out = formatRatify(ratifyResult());
    expect(out).toContain("decision: BLOCK");
    expect(out).toContain("base:       cid:base");
    expect(out).toContain("result:     cid:result");
    expect(out).toContain("transition: cid:subject");
    expect(out).toContain("changed files: 0");
    expect(out).toContain("facts:         1");
  });

  it("lists required reviewers with their approval state", () => {
    const out = formatRatify(
      ratifyResult({
        evaluation: evaluation({
          result: policyResult({
            requiredReviewers: [
              {
                id: "r1",
                reviewer: "db-owner",
                reviewerType: "team",
                tier: "required",
                approved: false,
                triggeredByFindingId: "fact_1",
                reason: "db migration"
              },
              {
                id: "r2",
                reviewer: "sec-team",
                reviewerType: "team",
                tier: "suggested",
                approved: false,
                triggeredByFindingId: "fact_1",
                reason: "security"
              }
            ]
          })
        })
      })
    );
    expect(out).toContain("required reviewers:");
    expect(out).toContain("- db-owner [pending]");
    // Suggested-tier reviewers are filtered out of the required list.
    expect(out).not.toContain("sec-team");
  });

  it("lists open (non-approved) required evidence with their status", () => {
    const out = formatRatify(
      ratifyResult({
        evaluation: evaluation({
          result: policyResult({
            requiredEvidence: [
              { id: "e1", kind: "rollback_plan", status: "missing", requiredByFindingId: "fact_1" },
              { id: "e2", kind: "security_note", status: "approved", requiredByFindingId: "fact_1" }
            ]
          })
        })
      })
    );
    expect(out).toContain("required evidence:");
    expect(out).toContain("- rollback_plan [missing]");
    expect(out).not.toContain("security_note");
  });

  it("omits the reviewers/evidence/reasons sections when there is nothing to report", () => {
    const out = formatRatify(ratifyResult());
    expect(out).not.toContain("required reviewers:");
    expect(out).not.toContain("required evidence:");
    expect(out).not.toContain("reasons:");
  });

  it("renders human-readable reasons when present", () => {
    const out = formatRatify(
      ratifyResult({
        evaluation: evaluation({
          result: policyResult({ explanation: ["Evidence is missing.", "Review required."] })
        })
      })
    );
    expect(out).toContain("reasons:");
    expect(out).toContain("- Evidence is missing.");
    expect(out).toContain("- Review required.");
  });

  it("reports the signed attestation when an envelope is present", () => {
    const out = formatRatify(ratifyResult({ envelope }));
    expect(out).toContain(
      "attestation: signed (application/vnd.in-toto+json, 1 signature)"
    );
  });

  it("omits the attestation line when no envelope is present", () => {
    expect(formatRatify(ratifyResult())).not.toContain("attestation:");
  });
});

describe("formatVerify", () => {
  const base: Omit<CliVerifyResult, "verdict"> = {
    baseAddress: cid("cid:base"),
    resultAddress: cid("cid:result"),
    subjectAddress: cid("cid:subject")
  };

  it("renders a valid verdict", () => {
    const out = formatVerify({ ...base, verdict: { ok: true } });
    expect(out).toContain("attestation: VALID");
    expect(out).toContain("base:       cid:base");
    expect(out).toContain("result:     cid:result");
    expect(out).toContain("transition: cid:subject");
  });

  it("renders an invalid verdict with its reason", () => {
    const out = formatVerify({ ...base, verdict: { ok: false, reason: "signature mismatch" } });
    expect(out).toContain("attestation: INVALID (signature mismatch)");
  });
});
