import { describe, expect, it } from "vitest";
import type { PolicyHit, VerifiedFact } from "@agentforge/core";
import { routeReviewers } from "./index.js";

const finding: VerifiedFact = {
  id: "finding-review-state",
  type: "sensitive_path_changed",
  source: "github_diff",
  evidence: "sensitive path changed",
  confidence: "verified"
};

function hit(reviewer: string): PolicyHit {
  return {
    id: `hit-${reviewer}`,
    ruleId: "sensitive-path",
    finding,
    action: "require_review",
    severity: "high",
    requiredEvidence: [],
    requiredReviewers: [reviewer],
    explanation: "Review required."
  };
}

describe("reviewer router adversarial state handling", () => {
  it("does not retain an approval after a newer changes-requested review", () => {
    const [requirement] = routeReviewers([hit("security-team")], {
      reviews: [
        {
          reviewer: "security-team",
          reviewerType: "team",
          state: "APPROVED",
          submittedAt: "2026-09-01T00:00:00.000Z"
        },
        {
          reviewer: "security-team",
          reviewerType: "team",
          state: "CHANGES_REQUESTED",
          submittedAt: "2026-09-01T00:00:01.000Z"
        }
      ]
    });

    expect(requirement).toMatchObject({ approved: false });
    expect(requirement?.approvalSource).toBeUndefined();
  });

  it("treats a newer comment as revoking an earlier approval", () => {
    const [requirement] = routeReviewers([hit("security-team")], {
      reviews: [
        {
          reviewer: "security-team",
          reviewerType: "team",
          state: "APPROVED",
          submittedAt: "2026-09-01T00:00:00.000Z"
        },
        {
          reviewer: "security-team",
          reviewerType: "team",
          state: "COMMENTED",
          submittedAt: "2026-09-01T00:00:01.000Z"
        }
      ]
    });

    expect(requirement?.approved).toBe(false);
  });

  it("uses the last review event when timestamps tie", () => {
    const [requirement] = routeReviewers([hit("security-team")], {
      reviews: [
        {
          reviewer: "security-team",
          reviewerType: "team",
          state: "CHANGES_REQUESTED",
          submittedAt: "2026-09-01T00:00:00.000Z"
        },
        {
          reviewer: "security-team",
          reviewerType: "team",
          state: "APPROVED",
          submittedAt: "2026-09-01T00:00:00.000Z"
        }
      ]
    });

    expect(requirement).toMatchObject({ approved: true, approvalSource: "github_review" });
  });

  it("ignores an invalid reviewer cap instead of silently making reviewers conditional", () => {
    const reviewers = routeReviewers(
      [hit("billing-owner"), hit("security-team"), hit("database-owner")],
      {},
      { maxRequiredReviewersWithoutCritical: Number.NaN }
    );

    expect(reviewers).toHaveLength(3);
    expect(reviewers.every((reviewer) => reviewer.tier === "required")).toBe(true);
  });
});
