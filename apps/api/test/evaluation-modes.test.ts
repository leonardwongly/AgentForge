import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PolicyMode, PullRequestInput } from "@agentforge/core";
import { evaluateFixturePr } from "../src/evaluation.js";

async function loadPr(name: string): Promise<PullRequestInput> {
  return JSON.parse(
    await readFile(path.resolve(process.cwd(), "fixtures", "repos", name), "utf8")
  ) as PullRequestInput;
}

function policy(mode: PolicyMode): string {
  return `
version: 1
policy_pack_id: integration-test
policy_pack_version: 1.0.0
agentforge:
  mode: ${mode}
  apply_to:
    - all_pull_requests
sensitive_paths:
  billing:
    paths:
      - "src/billing/**"
    required_reviewers:
      - "billing-owner"
    required_evidence:
      - "rollback_plan"
tests:
  deleted_tests:
    action: block
    required_evidence:
      - "deleted_test_explanation"
dependencies:
  new_package:
    action: require_review
database:
  migrations:
    action: block
`;
}

describe("deterministic evaluation pipeline modes", () => {
  it.each([
    ["observe" as const, "pass" as const, "success" as const],
    ["warn" as const, "warn" as const, "neutral" as const],
    ["enforce" as const, "block" as const, "failure" as const]
  ])(
    "maps %s mode without changing deterministic requirements",
    async (mode, status, conclusion) => {
      const output = evaluateFixturePr({
        pr: await loadPr("billing-path.json"),
        policyYaml: policy(mode)
      });

      expect(output.result.mode).toBe(mode);
      expect(output.result.status).toBe(status);
      expect(output.checkRun.conclusion).toBe(conclusion);
      expect(output.record.repositoryFullName).toBe("acme/payments");
      expect(output.record.pullRequestNumber).toBe(2);
      expect(output.record.requiredEvidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "rollback_plan", status: "missing" })
        ])
      );
      expect(output.record.requiredReviewers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reviewer: "billing-owner",
            tier: "required",
            reason: expect.stringContaining("Sensitive path changed")
          })
        ])
      );
      expect(output.result.explanation).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Required policy evidence is missing: rollback plan"),
          expect.stringContaining("Reviewer approval required: billing-owner")
        ])
      );
    }
  );

  it("keeps agent signals from bypassing human-authored high-risk controls", async () => {
    const humanPr = await loadPr("billing-path.json");
    const agentPr = await loadPr("billing-agent.json");
    const human = evaluateFixturePr({ pr: humanPr, policyYaml: policy("enforce") });
    const agent = evaluateFixturePr({ pr: agentPr, policyYaml: policy("enforce") });

    expect(human.result.findings.map((finding) => finding.type)).not.toContain(
      "agent_signal_detected"
    );
    expect(agent.result.findings.map((finding) => finding.type)).toContain("agent_signal_detected");
    expect(human.result.status).toBe("block");
    expect(agent.result.status).toBe("block");
    expect(human.record.id).toBeTruthy();
    expect(agent.record.id).toBeTruthy();
  });
});
