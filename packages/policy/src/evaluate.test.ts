import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PullRequestInput, VerifiedFact } from "@agentforge/core";
import { detectorConfigFromPolicy, extractVerifiedFacts } from "@agentforge/detectors";
import {
  applyPolicyRules,
  buildPolicyVersion,
  effectivePolicyContentHash,
  evaluateMergeGuard,
  parsePolicyYaml,
  policyContentHashFromVersion
} from "./index.js";

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

  it("preserves the policy pack version and binds the effective content revision", async () => {
    const result = await evaluate("policy-update-after-open.json");
    expect(result.policyVersion).toMatch(/^fintech@1\.0\.0\+[0-9a-f]{64}$/u);
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

  it("only blocks under blocking modes for the same unresolved blocking rule", async () => {
    const policyFor = (mode: string) => `
version: 1
agentforge:
  mode: ${mode}
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
    const pr = await load("billing-path.json");
    const statusByMode: Record<string, string> = {
      observe: "pass",
      warn: "warn",
      enforce: "block",
      optimize: "block"
    };
    for (const [mode, expectedStatus] of Object.entries(statusByMode)) {
      const parsed = parsePolicyYaml(policyFor(mode));
      const facts = extractVerifiedFacts(pr, detectorConfigFromPolicy(parsed.config));
      const result = evaluateMergeGuard(pr, facts, parsed.config);
      expect(result.status).toBe(expectedStatus);
    }
  });

  it("resolves a detection_coverage_truncated fact to a non-blocking, informational hit in every mode", async () => {
    const yaml = await readFile(
      path.resolve(process.cwd(), "fixtures", "policies", "enterprise-strict.yaml"),
      "utf8"
    );
    const parsed = parsePolicyYaml(yaml);
    parsed.config.agentforge.mode = "enforce";
    const pr = await load("readme-only.json");
    const truncationFact: VerifiedFact = {
      id: "fact_truncation_test",
      type: "detection_coverage_truncated",
      source: "policy_config",
      evidence:
        "Pull request has 1500 changed files; only the first 1000 were scanned for policy facts.",
      confidence: "verified",
      metadata: { limitType: "file_count", totalFiles: 1500, scannedFiles: 1000 }
    };

    const hits = applyPolicyRules([truncationFact], parsed.config);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      ruleId: "detection.coverage_truncated",
      action: "suggest",
      requiredEvidence: [],
      requiredReviewers: []
    });

    const result = evaluateMergeGuard(pr, [truncationFact], parsed.config);
    expect(result.status).toBe("pass");
    expect(result.requiredEvidence).toHaveLength(0);
    expect(result.requiredReviewers).toHaveLength(0);
    expect(
      result.explanation.some((line) => line.includes("Detector coverage was truncated"))
    ).toBe(true);
  });
});

describe("prior requirement state", () => {
  const policyYaml = (input?: {
    packVersion?: string;
    evidence?: string[];
    reviewers?: string[];
  }) => `
version: 1
policy_pack_id: requirement-state
policy_pack_version: ${input?.packVersion ?? "1.0.0"}
agentforge:
  mode: enforce
  apply_to:
    - all_pull_requests
sensitive_paths:
  billing:
    paths:
      - "src/billing/**"
    action: block
    required_evidence:
${(input?.evidence ?? ["rollback_plan"]).map((kind) => `      - "${kind}"`).join("\n") || "      []"}
    required_reviewers:
${(input?.reviewers ?? ["billing-owner"]).map((reviewer) => `      - "${reviewer}"`).join("\n") || "      []"}
`;

  const pr = (overrides: Partial<PullRequestInput> = {}): PullRequestInput => ({
    repositoryFullName: "acme/billing-service",
    pullRequestNumber: 101,
    title: "Change billing",
    authorLogin: "sam",
    baseBranch: "main",
    headBranch: "billing-change",
    headSha: "head-1",
    changedFiles: [],
    ...overrides
  });

  const fact = (id: string): VerifiedFact => ({
    id,
    type: "sensitive_path_changed",
    source: "github_diff",
    path: "src/billing/checkout.ts",
    evidence: "Billing path changed",
    confidence: "verified",
    metadata: { ruleId: "billing" }
  });

  const manualPrior = (inputPr: PullRequestInput, result: ReturnType<typeof evaluateMergeGuard>) =>
    ({
      headSha: inputPr.headSha,
      policyVersion: result.policyVersion,
      requiredEvidence: result.requiredEvidence.map((requirement) => ({
        ...requirement,
        status: "approved" as const,
        source: "manual_attestation" as const,
        providedBy: "dashboard-actor",
        providedAt: "2026-07-15T00:00:00.000Z",
        approvedBy: "governance-admin",
        approvedAt: "2026-07-15T00:01:00.000Z"
      })),
      requiredReviewers: result.requiredReviewers.map((requirement) => ({
        ...requirement,
        approved: true,
        approvalSource: "manual" as const,
        approvedBy: "governance-admin",
        approvedAt: "2026-07-15T00:01:00.000Z"
      }))
    }) satisfies NonNullable<Parameters<typeof evaluateMergeGuard>[3]>;

  it("carries same-id manual evidence and reviewer approvals on the identical head and policy", () => {
    const parsed = parsePolicyYaml(policyYaml());
    const inputPr = pr();
    const facts = [fact("fact_billing")];
    const initial = evaluateMergeGuard(inputPr, facts, parsed.config);
    const result = evaluateMergeGuard(inputPr, facts, parsed.config, manualPrior(inputPr, initial));

    expect(result.status).toBe("pass");
    expect(result.requiredEvidence[0]).toMatchObject({
      id: initial.requiredEvidence[0]?.id,
      status: "approved",
      source: "manual_attestation",
      approvedBy: "governance-admin"
    });
    expect(result.requiredReviewers[0]).toMatchObject({
      id: initial.requiredReviewers[0]?.id,
      approved: true,
      approvalSource: "manual",
      approvedBy: "governance-admin"
    });
    expect(
      result.explanation.some(
        (line) =>
          line.includes("evidence is missing") || line.includes("Reviewer approval required")
      )
    ).toBe(false);
  });

  it("does not transfer manual state to changed IDs or resurrect removed requirements", () => {
    const parsed = parsePolicyYaml(policyYaml());
    const inputPr = pr();
    const initial = evaluateMergeGuard(inputPr, [fact("fact_old")], parsed.config);
    const prior = manualPrior(inputPr, initial);

    const changed = evaluateMergeGuard(inputPr, [fact("fact_new")], parsed.config, prior);
    expect(changed.status).toBe("block");
    expect(changed.requiredEvidence[0]).toMatchObject({ status: "missing" });
    expect(changed.requiredReviewers[0]).toMatchObject({ approved: false });
    expect(changed.requiredEvidence[0]?.id).not.toBe(initial.requiredEvidence[0]?.id);
    expect(changed.requiredReviewers[0]?.id).not.toBe(initial.requiredReviewers[0]?.id);

    const removed = evaluateMergeGuard(inputPr, [], parsed.config, prior);
    expect(removed.status).toBe("pass");
    expect(removed.requiredEvidence).toEqual([]);
    expect(removed.requiredReviewers).toEqual([]);
  });

  it("fails closed instead of carrying manual state across a changed head or policy", () => {
    const originalPolicy = parsePolicyYaml(policyYaml());
    const inputPr = pr();
    const facts = [fact("fact_billing")];
    const initial = evaluateMergeGuard(inputPr, facts, originalPolicy.config);
    const prior = manualPrior(inputPr, initial);

    const changedHead = evaluateMergeGuard(
      pr({ headSha: "head-2" }),
      facts,
      originalPolicy.config,
      prior
    );
    expect(changedHead.status).toBe("block");
    expect(changedHead.requiredEvidence[0]).toMatchObject({ status: "missing" });
    expect(changedHead.requiredReviewers[0]).toMatchObject({ approved: false });

    const changedPolicy = parsePolicyYaml(policyYaml({ packVersion: "2.0.0" }));
    const changedPolicyResult = evaluateMergeGuard(inputPr, facts, changedPolicy.config, prior);
    expect(changedPolicyResult.status).toBe("block");
    expect(changedPolicyResult.requiredEvidence[0]).toMatchObject({ status: "missing" });
    expect(changedPolicyResult.requiredReviewers[0]).toMatchObject({ approved: false });
  });

  it("does not carry a GitHub review approval after the review is dismissed", () => {
    const parsed = parsePolicyYaml(policyYaml({ evidence: [] }));
    const approvedPr = pr({
      reviews: [
        {
          reviewer: "billing-owner",
          reviewerType: "team",
          state: "APPROVED",
          submittedAt: "2026-07-15T00:00:00.000Z"
        }
      ]
    });
    const facts = [fact("fact_billing")];
    const approved = evaluateMergeGuard(approvedPr, facts, parsed.config);
    expect(approved.status).toBe("pass");
    expect(approved.requiredReviewers[0]).toMatchObject({
      approved: true,
      approvalSource: "github_review"
    });

    const dismissedPr = pr({
      reviews: [
        {
          reviewer: "billing-owner",
          reviewerType: "team",
          state: "COMMENTED",
          submittedAt: "2026-07-15T01:00:00.000Z"
        }
      ]
    });
    const prior = {
      headSha: approvedPr.headSha,
      policyVersion: approved.policyVersion,
      requiredEvidence: approved.requiredEvidence,
      requiredReviewers: approved.requiredReviewers
    } satisfies NonNullable<Parameters<typeof evaluateMergeGuard>[3]>;
    const result = evaluateMergeGuard(dismissedPr, facts, parsed.config, prior);

    expect(result.status).toBe("block");
    expect(result.requiredReviewers[0]).toMatchObject({ approved: false });
    expect(result.requiredReviewers[0]?.approvalSource).toBeUndefined();
  });

  it("does not overgrant one manual evidence item across duplicate evidence kinds", () => {
    const parsed = parsePolicyYaml(policyYaml({ reviewers: [] }));
    const inputPr = pr();
    const facts = [fact("fact_first"), fact("fact_second")];
    const initial = evaluateMergeGuard(inputPr, facts, parsed.config);
    expect(initial.requiredEvidence).toHaveLength(2);

    const firstId = initial.requiredEvidence[0]!.id;
    const prior = {
      headSha: inputPr.headSha,
      policyVersion: initial.policyVersion,
      requiredEvidence: initial.requiredEvidence.map((requirement) =>
        requirement.id === firstId
          ? {
              ...requirement,
              status: "approved" as const,
              source: "linked_artifact" as const,
              providedBy: "dashboard-actor",
              providedAt: "2026-07-15T00:00:00.000Z",
              approvedBy: "governance-admin",
              approvedAt: "2026-07-15T00:01:00.000Z"
            }
          : requirement
      ),
      requiredReviewers: []
    } satisfies NonNullable<Parameters<typeof evaluateMergeGuard>[3]>;
    const result = evaluateMergeGuard(inputPr, facts, parsed.config, prior);

    expect(result.status).toBe("block");
    expect(result.requiredEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: firstId, status: "approved", source: "linked_artifact" }),
        expect.objectContaining({
          id: initial.requiredEvidence[1]!.id,
          kind: "rollback_plan",
          status: "missing"
        })
      ])
    );
  });

  it("does not carry PR-body evidence even when a prior snapshot marks it approved", () => {
    const parsed = parsePolicyYaml(policyYaml({ reviewers: [] }));
    const inputPr = pr();
    const facts = [fact("fact_billing")];
    const initial = evaluateMergeGuard(inputPr, facts, parsed.config);
    const prior = {
      headSha: inputPr.headSha,
      policyVersion: initial.policyVersion,
      requiredEvidence: initial.requiredEvidence.map((requirement) => ({
        ...requirement,
        status: "approved" as const,
        source: "pr_body" as const,
        providedBy: "sam",
        providedAt: "2026-07-15T00:00:00.000Z",
        approvedBy: "governance-admin",
        approvedAt: "2026-07-15T00:01:00.000Z"
      })),
      requiredReviewers: []
    } satisfies NonNullable<Parameters<typeof evaluateMergeGuard>[3]>;
    const result = evaluateMergeGuard(inputPr, facts, parsed.config, prior);

    expect(result.status).toBe("block");
    expect(result.requiredEvidence[0]).toMatchObject({ status: "missing" });
    expect(result.requiredEvidence[0]?.source).toBeUndefined();
  });
});

describe("policy scope matching and version helpers", () => {
  const scopePr = (overrides: Partial<PullRequestInput> = {}): PullRequestInput => ({
    repositoryFullName: "acme/billing-service",
    pullRequestNumber: 7,
    title: "Change",
    authorLogin: "sam",
    baseBranch: "main",
    headBranch: "feature/x",
    headSha: "sha",
    changedFiles: [],
    labels: ["agent-assisted"],
    ...overrides
  });

  const scopePolicy = (applyTo: string[]) =>
    ({
      version: 1,
      policy_pack_id: "scope-test",
      policy_pack_version: "1.0.0",
      agentforge: { mode: "enforce" as const, apply_to: applyTo },
      tests: {},
      dependencies: {},
      database: {},
      sensitive_paths: {}
    }) as unknown as Parameters<typeof evaluateMergeGuard>[2];

  it("matches an unprefixed scope against repository or base branch (fallback branch)", () => {
    const byRepo = evaluateMergeGuard(
      scopePr({ repositoryFullName: "acme/billing-service" }),
      [],
      scopePolicy(["acme/billing-service"])
    );
    expect(byRepo.status).toBe("pass");
    expect(byRepo.explanation).not.toContain("Policy scope does not include");

    const byBase = evaluateMergeGuard(
      scopePr({ baseBranch: "release/2026" }),
      [],
      scopePolicy(["release/*"])
    );
    expect(byBase.explanation).not.toContain("Policy scope does not include");
  });

  it("matches head-branch and label scopes case-insensitively", () => {
    const byHead = evaluateMergeGuard(
      scopePr({ headBranch: "feature/x" }),
      [],
      scopePolicy(["head:feature/*"])
    );
    expect(byHead.explanation).not.toContain("Policy scope does not include");

    const byLabel = evaluateMergeGuard(scopePr(), [], scopePolicy(["label:AGENT-ASSISTED"]));
    expect(byLabel.explanation).not.toContain("Policy scope does not include");
  });

  it("excludes a pull request when no scope matches or the pattern is empty", () => {
    const noMatch = evaluateMergeGuard(scopePr(), [], scopePolicy(["repo:other/org"]));
    expect(noMatch.explanation).toContain("Policy scope does not include this pull request.");

    const emptyPattern = evaluateMergeGuard(scopePr(), [], scopePolicy(["repo:"]));
    expect(emptyPattern.explanation).toContain("Policy scope does not include this pull request.");
  });

  it("builds a policy version that binds the effective content hash", () => {
    const policy = scopePolicy(["all_pull_requests"]);
    const version = buildPolicyVersion(policy);
    expect(version).toMatch(/^scope-test@1\.0\.0\+[0-9a-f]{64}$/u);
    expect(policyContentHashFromVersion(version)).toBe(effectivePolicyContentHash(policy));
  });

  it("changes the effective hash when sourceContentHash is supplied", () => {
    const policy = scopePolicy(["all_pull_requests"]);
    const without = effectivePolicyContentHash(policy);
    const withHash = effectivePolicyContentHash(policy, {
      sourceContentHash: "abc123"
    });
    expect(withHash).not.toBe(without);
    expect(buildPolicyVersion(policy, { sourceContentHash: "abc123" })).not.toBe(
      buildPolicyVersion(policy)
    );
  });

  it("extracts the content hash only from well-formed versions", () => {
    expect(policyContentHashFromVersion("fintech@1.0.0+" + "a".repeat(64))).toBe("a".repeat(64));
    expect(policyContentHashFromVersion("fintech@1.0.0")).toBeUndefined();
    expect(policyContentHashFromVersion("fintech@1.0.0+short")).toBeUndefined();
    expect(policyContentHashFromVersion("")).toBeUndefined();
  });

  it("canonicalizes policy content deterministically regardless of key order", () => {
    const policyA = scopePolicy(["all_pull_requests"]);
    const policyB = {
      ...policyA,
      agentforge: { apply_to: ["all_pull_requests"], mode: "enforce" as const }
    };
    // Same effective content, different key insertion order -> identical hash.
    expect(effectivePolicyContentHash(policyA)).toBe(effectivePolicyContentHash(policyB));
  });
});
