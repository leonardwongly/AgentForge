import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PullRequestInput } from "@agentforge/core";
import { detectorConfigFromPolicy, extractVerifiedFacts } from "@agentforge/detectors";
import { evaluateMergeGuard, parsePolicyYaml } from "./index.js";

async function load(name: string): Promise<PullRequestInput> {
  return JSON.parse(
    await readFile(path.resolve(process.cwd(), "fixtures", "repos", name), "utf8")
  ) as PullRequestInput;
}

async function evaluate(name: string, policyPath = "fintech.yaml") {
  const yaml = await readFile(
    path.resolve(process.cwd(), "fixtures", "policies", policyPath),
    "utf8"
  );
  const parsed = parsePolicyYaml(yaml);
  const pr = await load(name);
  const facts = extractVerifiedFacts(pr, detectorConfigFromPolicy(parsed.config));
  return evaluateMergeGuard(pr, facts, parsed.config);
}

describe("policy evaluation", () => {
  it("passes README-only PRs", async () => {
    const result = await evaluate("readme-only.json");
    expect(result.status).toBe("pass");
    expect(result.requiredEvidence).toHaveLength(0);
    expect(result.requiredReviewers).toHaveLength(0);
  });

  it("warns in warn mode for missing billing evidence and reviewer", async () => {
    const result = await evaluate("billing-path.json");
    expect(result.status).toBe("warn");
    expect(result.requiredEvidence.map((item) => item.kind)).toContain("rollback_plan");
    expect(result.requiredReviewers.map((item) => item.reviewer)).toContain("billing-owner");
  });

  it("blocks in enforce mode when required controls are missing", async () => {
    const result = await evaluate("billing-path.json", "enterprise-strict.yaml");
    expect(result.mode).toBe("enforce");
    expect(result.status).toBe("block");
  });

  it("allows an enforce-mode block rule to clear after required evidence and review are approved", async () => {
    const yaml = `
version: 1
agentforge:
  mode: enforce
  apply_to:
    - all_pull_requests
sensitive_paths:
  billing:
    paths:
      - "src/billing/**"
    action: block
    required_reviewers:
      - "billing-owner"
    required_evidence:
      - "rollback_plan"
`;
    const parsed = parsePolicyYaml(yaml);
    const pr: PullRequestInput = {
      ...(await load("billing-path.json")),
      manualEvidence: [
        {
          kind: "rollback_plan",
          content: "Rollback plan: revert the billing checkout change.",
          actor: "sam",
          approved: true,
          approvedBy: "billing-owner",
          approvedAt: "2026-05-13T00:00:00.000Z"
        }
      ],
      reviews: [
        {
          reviewer: "billing-owner",
          reviewerType: "team",
          state: "APPROVED",
          submittedAt: "2026-05-13T00:00:00.000Z"
        }
      ]
    };
    const facts = extractVerifiedFacts(pr, detectorConfigFromPolicy(parsed.config));
    const result = evaluateMergeGuard(pr, facts, parsed.config);

    expect(result.status).toBe("pass");
    expect(result.requiredEvidence[0]).toMatchObject({
      kind: "rollback_plan",
      status: "approved"
    });
    expect(result.requiredReviewers[0]).toMatchObject({
      reviewer: "billing-owner",
      approved: true
    });
  });

  it("does not let agent-assistance signals alone escalate a sensitive path rule", async () => {
    const yaml = `
version: 1
agentforge:
  mode: enforce
  apply_to:
    - all_pull_requests
agent_assisted:
  stricter_controls: true
sensitive_paths:
  billing:
    paths:
      - "src/billing/**"
    required_reviewers:
      - "billing-owner"
    block_for_agent_assisted: true
`;
    const parsed = parsePolicyYaml(yaml);
    const pr: PullRequestInput = {
      ...(await load("billing-agent.json")),
      reviews: [
        {
          reviewer: "billing-owner",
          reviewerType: "team",
          state: "APPROVED",
          submittedAt: "2026-05-13T00:00:00.000Z"
        }
      ]
    };
    const facts = extractVerifiedFacts(pr, detectorConfigFromPolicy(parsed.config));
    const result = evaluateMergeGuard(pr, facts, parsed.config);

    expect(result.findings.map((finding) => finding.type)).toContain("agent_signal_detected");
    expect(result.status).toBe("pass");
  });

  it("does not allow inferred findings to block", async () => {
    const result = await evaluate("assertion-weakening.json", "enterprise-strict.yaml");
    expect(result.findings.some((finding) => finding.confidence === "inferred")).toBe(true);
    expect(result.status).toBe("pass");
  });

  it("treats downgraded secret-like placeholders as advisory without security requirements", async () => {
    const yaml = await readFile(
      path.resolve(process.cwd(), "fixtures", "policies", "fintech.yaml"),
      "utf8"
    );
    const parsed = parsePolicyYaml(yaml);
    parsed.config.agentforge.mode = "enforce";
    const pr: PullRequestInput = {
      repositoryFullName: "acme/billing-service",
      pullRequestNumber: 99,
      title: "Document local database",
      authorLogin: "sam",
      baseBranch: "main",
      headBranch: "docs/local-db",
      headSha: "sha99",
      changedFiles: [
        {
          filename: "docs/setup.md",
          status: "modified",
          patch:
            "+Use DATABASE_URL=postgresql://agentforge:agentforge@localhost:15432/agentforge for local development."
        }
      ]
    };
    const facts = extractVerifiedFacts(pr, detectorConfigFromPolicy(parsed.config));
    const result = evaluateMergeGuard(pr, facts, parsed.config);

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "secret_like_value_detected",
          severity: "low",
          metadata: expect.objectContaining({
            secretCategory: "documentation_example",
            policyTreatment: "advisory"
          })
        })
      ])
    );
    expect(result.status).toBe("pass");
    expect(result.requiredEvidence).toHaveLength(0);
    expect(result.requiredReviewers).toHaveLength(0);
  });

  it("still blocks credential-shaped secret findings and requires security review", async () => {
    const yaml = await readFile(
      path.resolve(process.cwd(), "fixtures", "policies", "fintech.yaml"),
      "utf8"
    );
    const parsed = parsePolicyYaml(yaml);
    parsed.config.agentforge.mode = "enforce";
    const pr = await load("secret-like-token.json");
    const facts = extractVerifiedFacts(pr, detectorConfigFromPolicy(parsed.config));
    const result = evaluateMergeGuard(pr, facts, parsed.config);

    expect(result.status).toBe("block");
    expect(result.requiredEvidence.map((item) => item.kind)).toContain("security_note");
    expect(result.requiredReviewers.map((item) => item.reviewer)).toContain("security-team");
    expect(JSON.stringify(result)).not.toContain("ghp_123456");
  });

  it("preserves policy pack version in result", async () => {
    const result = await evaluate("policy-update-after-open.json");
    expect(result.policyVersion).toBe("fintech@1.0.0");
  });

  it("passes without requirements when apply_to excludes the pull request", async () => {
    const yaml = await readFile(
      path.resolve(process.cwd(), "fixtures", "policies", "fintech.yaml"),
      "utf8"
    );
    const parsed = parsePolicyYaml(yaml);
    parsed.config.agentforge.apply_to = ["repo:acme/other", "base:release/*"];
    parsed.config.agentforge.mode = "enforce";
    const pr = await load("billing-path.json");
    const facts = extractVerifiedFacts(pr, detectorConfigFromPolicy(parsed.config));
    const result = evaluateMergeGuard(pr, facts, parsed.config);

    expect(result.status).toBe("pass");
    expect(result.findings).toHaveLength(0);
    expect(result.requiredEvidence).toHaveLength(0);
    expect(result.requiredReviewers).toHaveLength(0);
    expect(result.explanation).toContain("Policy scope does not include this pull request.");
  });

  it("applies scoped policies by repository, branch, and label", async () => {
    const yaml = await readFile(
      path.resolve(process.cwd(), "fixtures", "policies", "fintech.yaml"),
      "utf8"
    );
    const parsed = parsePolicyYaml(yaml);
    parsed.config.agentforge.apply_to = [
      "repo:acme/billing-service",
      "base:main",
      "label:agent-assisted"
    ];
    const pr: PullRequestInput = {
      ...(await load("billing-path.json")),
      labels: ["agent-assisted"]
    };
    const facts = extractVerifiedFacts(pr, detectorConfigFromPolicy(parsed.config));
    const result = evaluateMergeGuard(pr, facts, parsed.config);

    expect(result.findings.map((finding) => finding.type)).toContain("sensitive_path_changed");
    expect(result.requiredEvidence.map((item) => item.kind)).toContain("rollback_plan");
  });
});
