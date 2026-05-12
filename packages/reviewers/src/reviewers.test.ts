import { describe, expect, it } from "vitest";
import type { PolicyHit, VerifiedFact } from "@agentforge/core";
import { routeReviewers } from "./index.js";

const fact: VerifiedFact = {
  id: "fact_1",
  type: "sensitive_path_changed",
  source: "github_diff",
  evidence: "Billing path changed",
  confidence: "verified"
};

describe("reviewer router", () => {
  it("deduplicates reviewers and records approval state", () => {
    const hit: PolicyHit = {
      id: "hit_1",
      ruleId: "billing",
      finding: fact,
      action: "require_review",
      severity: "high",
      requiredEvidence: [],
      requiredReviewers: ["billing-owner", "billing-owner"],
      explanation: "Billing owner approval required."
    };
    const reviewers = routeReviewers([hit], {
      reviews: [
        {
          reviewer: "billing-owner",
          reviewerType: "team",
          state: "APPROVED",
          submittedAt: "2026-01-01"
        }
      ]
    });
    expect(reviewers).toHaveLength(1);
    expect(reviewers[0]?.approved).toBe(true);
  });
});
