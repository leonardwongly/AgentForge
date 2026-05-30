import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PullRequestInput, VerifiedFact } from "@agentforge/core";
import { extractVerifiedFacts, type DetectorPolicyConfig } from "./index.js";

const config: DetectorPolicyConfig = {
  sensitivePaths: {
    billing: { paths: ["src/billing/**", "src/checkout/**", "services/payments/**"] },
    ci_and_deploy: { paths: [".github/workflows/**", "scripts/deploy/**", "infra/prod/**"] }
  },
  migrationPaths: [
    "db/migrations/**",
    "migrations/**",
    "prisma/migrations/**",
    "**/prisma/migrations/**"
  ]
};

// Labeled corpus: each fixture maps to the fact types that MUST be detected.
// This is the recall gate; a regression or evasion that drops a fact type fails.
const labeled: Array<{ fixture: string; expected: VerifiedFact["type"][] }> = [
  { fixture: "billing-path.json", expected: ["sensitive_path_changed"] },
  { fixture: "ci-workflow.json", expected: ["ci_workflow_changed"] },
  { fixture: "deleted-test.json", expected: ["test_deleted"] },
  { fixture: "skipped-test.json", expected: ["test_skipped"] },
  { fixture: "migration-added.json", expected: ["migration_added"] },
  { fixture: "secret-like-token.json", expected: ["secret_like_value_detected"] },
  { fixture: "dependency-added.json", expected: ["dependency_added"] },
  { fixture: "billing-agent.json", expected: ["agent_signal_detected", "sensitive_path_changed"] }
];

// Benign fixtures must yield no findings: the precision (no-false-positive) gate.
const benign = ["readme-only.json"];

async function fixture(name: string): Promise<PullRequestInput> {
  return JSON.parse(
    await readFile(path.resolve(process.cwd(), "fixtures", "repos", name), "utf8")
  ) as PullRequestInput;
}

describe("detector precision/recall gate", () => {
  it("recalls every labeled fact type in the corpus", async () => {
    let expectedTotal = 0;
    let detectedTotal = 0;
    for (const { fixture: name, expected } of labeled) {
      const types = new Set(extractVerifiedFacts(await fixture(name), config).map((f) => f.type));
      for (const type of expected) {
        expectedTotal += 1;
        if (types.has(type)) {
          detectedTotal += 1;
        }
      }
    }
    expect(detectedTotal).toBe(expectedTotal);
  });

  it("produces no findings on benign fixtures", async () => {
    for (const name of benign) {
      expect(extractVerifiedFacts(await fixture(name), config)).toHaveLength(0);
    }
  });
});
