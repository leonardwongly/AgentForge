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

  it("supports suggested reviewers", () => {
    const reviewers = routeReviewers(
      [
        {
          id: "hit_suggest",
          ruleId: "docs",
          finding: fact,
          action: "suggest",
          severity: "low",
          requiredEvidence: [],
          requiredReviewers: ["maintainer"],
          reviewerTier: "suggested",
          explanation: "Maintainer review suggested."
        }
      ],
      {}
    );

    expect(reviewers).toHaveLength(1);
    expect(reviewers[0]).toMatchObject({
      reviewer: "maintainer",
      reviewerType: "user",
      tier: "suggested",
      reason: "Maintainer review suggested."
    });
  });

  it("accepts an approved user review when GitHub verified the reviewer belongs to the required team", () => {
    const reviewers = routeReviewers(
      [
        {
          id: "hit_team",
          ruleId: "security",
          finding: fact,
          action: "require_review",
          severity: "high",
          requiredEvidence: [],
          requiredReviewers: ["security-team"],
          explanation: "Security team approval required."
        }
      ],
      {
        reviews: [
          {
            reviewer: "alice",
            reviewerType: "user",
            teamSlugs: ["security-team", "platform-team"],
            state: "APPROVED",
            submittedAt: "2026-05-14T00:00:00.000Z"
          }
        ]
      }
    );

    expect(reviewers).toHaveLength(1);
    expect(reviewers[0]).toMatchObject({
      reviewer: "security-team",
      reviewerType: "team",
      approved: true,
      approvedBy: "alice"
    });
  });

  it("does not approve team requirements from unrelated user approvals", () => {
    const reviewers = routeReviewers(
      [
        {
          id: "hit_team",
          ruleId: "security",
          finding: fact,
          action: "require_review",
          severity: "high",
          requiredEvidence: [],
          requiredReviewers: ["security-team"],
          explanation: "Security team approval required."
        }
      ],
      {
        reviews: [
          {
            reviewer: "alice",
            reviewerType: "user",
            teamSlugs: ["platform-team"],
            state: "APPROVED",
            submittedAt: "2026-05-14T00:00:00.000Z"
          }
        ]
      }
    );

    expect(reviewers).toHaveLength(1);
    expect(reviewers[0]).toMatchObject({
      reviewer: "security-team",
      reviewerType: "team",
      approved: false
    });
  });

  it("caps non-critical required reviewer groups as conditional reviewers", () => {
    const hits: PolicyHit[] = ["billing-owner", "security-team", "database-owner"].map(
      (reviewer, index) => ({
        id: `hit_${index}`,
        ruleId: `rule_${index}`,
        finding: { ...fact, id: `fact_${index}` },
        action: "require_review",
        severity: "high",
        requiredEvidence: [],
        requiredReviewers: [reviewer],
        explanation: `${reviewer} approval required.`
      })
    );

    const reviewers = routeReviewers(hits, {}, { maxRequiredReviewersWithoutCritical: 1 });

    expect(reviewers[0]?.tier).toBe("required");
    expect(reviewers.slice(1).every((reviewer) => reviewer.tier === "conditional")).toBe(true);
    expect(reviewers.slice(1).every((reviewer) => reviewer.reason.includes("capped"))).toBe(true);
  });
});
