import { describe, expect, it } from "vitest";
import { proposePolicyTuningActions, type PolicyTuningReport } from "./index.js";

const report: PolicyTuningReport = {
  generatedAt: "2026-05-12T00:00:00.000Z",
  recordCount: 10,
  window: {},
  metrics: {
    overrideRate: 40,
    rejectedEvidenceRate: 0,
    openEvidenceRate: 0,
    pendingReviewerRate: 0,
    observeOrWarnOpenRequirementCount: 0
  },
  insights: [
    {
      id: "override_noise",
      category: "override_noise",
      severity: "high",
      title: "High override rate",
      recommendation: "Narrow the rule scope.",
      rationale: "Overrides are frequent.",
      metric: { label: "override rate", value: "40%", detail: "4/10" },
      citations: [],
      guardrail: "Proposal only; requires platform-admin approval."
    },
    {
      id: "finding_noise",
      category: "finding_noise",
      severity: "low",
      title: "Repeated finding",
      recommendation: "Consider path scoping.",
      rationale: "Same finding recurs.",
      metric: { label: "recurrence", value: "3", detail: "3 records" },
      citations: [],
      guardrail: "Proposal only."
    }
  ]
};

describe("policy tuning proposals (human-gated)", () => {
  it("derives proposals that are never auto-applied", () => {
    const proposals = proposePolicyTuningActions(report);
    expect(proposals).toHaveLength(2);
    for (const proposal of proposals) {
      expect(proposal.applied).toBe(false);
      expect(proposal.requiresApproval).toBe(true);
      expect(proposal.status).toBe("proposed");
    }
    expect(proposals[0]?.insightId).toBe("override_noise");
  });

  it("filters by minimum severity", () => {
    const highOnly = proposePolicyTuningActions(report, { minSeverity: "high" });
    expect(highOnly.map((proposal) => proposal.severity)).toEqual(["high"]);
  });
});
