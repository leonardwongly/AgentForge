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

  it("does not allow inferred findings to block", async () => {
    const result = await evaluate("assertion-weakening.json", "enterprise-strict.yaml");
    expect(result.findings.some((finding) => finding.confidence === "inferred")).toBe(true);
    expect(result.status).toBe("pass");
  });

  it("preserves policy pack version in result", async () => {
    const result = await evaluate("policy-update-after-open.json");
    expect(result.policyVersion).toBe("fintech@1.0.0");
  });
});
