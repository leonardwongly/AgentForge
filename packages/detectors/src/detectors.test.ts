import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PullRequestInput } from "@agentforge/core";
import { extractVerifiedFacts, type DetectorPolicyConfig } from "./index.js";

async function fixture(name: string): Promise<PullRequestInput> {
  return JSON.parse(
    await readFile(path.resolve(process.cwd(), "fixtures", "repos", name), "utf8")
  ) as PullRequestInput;
}

function fintechConfig(): DetectorPolicyConfig {
  return {
    sensitivePaths: {
      billing: {
        paths: ["src/billing/**", "src/checkout/**", "services/payments/**"]
      },
      auth: {
        paths: ["src/auth/**", "services/identity/**"]
      },
      ci_and_deploy: {
        paths: [".github/workflows/**", "scripts/deploy/**", "infra/prod/**"]
      }
    },
    migrationPaths: ["db/migrations/**", "migrations/**", "prisma/migrations/**"]
  };
}

describe("deterministic detectors", () => {
  it("does not emit findings for README-only PRs", async () => {
    const facts = extractVerifiedFacts(await fixture("readme-only.json"), fintechConfig());
    expect(facts).toHaveLength(0);
  });

  it("detects sensitive billing paths", async () => {
    const facts = extractVerifiedFacts(await fixture("billing-path.json"), fintechConfig());
    expect(facts.map((fact) => fact.type)).toContain("sensitive_path_changed");
  });

  it("records agent signals without replacing high-risk governance", async () => {
    const facts = extractVerifiedFacts(await fixture("billing-agent.json"), fintechConfig());
    expect(facts.map((fact) => fact.type)).toContain("agent_signal_detected");
    expect(facts.map((fact) => fact.type)).toContain("sensitive_path_changed");
  });

  it("detects CI workflow changes", async () => {
    const facts = extractVerifiedFacts(await fixture("ci-workflow.json"), fintechConfig());
    expect(facts.map((fact) => fact.type)).toContain("ci_workflow_changed");
  });

  it("detects deleted and skipped tests", async () => {
    const deleted = extractVerifiedFacts(await fixture("deleted-test.json"), fintechConfig());
    const skipped = extractVerifiedFacts(await fixture("skipped-test.json"), fintechConfig());
    expect(deleted.map((fact) => fact.type)).toContain("test_deleted");
    expect(skipped.map((fact) => fact.type)).toContain("test_skipped");
  });

  it("keeps assertion weakening inferred", async () => {
    const facts = extractVerifiedFacts(await fixture("assertion-weakening.json"), fintechConfig());
    const finding = facts.find((fact) => fact.type === "suspicious_test_change");
    expect(finding?.confidence).toBe("inferred");
  });

  it("detects dependency additions and major bumps", async () => {
    const added = extractVerifiedFacts(await fixture("dependency-added.json"), fintechConfig());
    const bumped = extractVerifiedFacts(await fixture("dependency-bump.json"), fintechConfig());
    expect(added.map((fact) => fact.type)).toContain("dependency_added");
    expect(
      bumped.find((fact) => fact.type === "dependency_bumped")?.metadata?.majorVersionBump
    ).toBe(true);
  });

  it("detects migrations and redacts secret-like values", async () => {
    const migration = extractVerifiedFacts(await fixture("migration-added.json"), fintechConfig());
    const secret = extractVerifiedFacts(await fixture("secret-like-token.json"), fintechConfig());
    expect(migration.map((fact) => fact.type)).toContain("migration_added");
    expect(secret.map((fact) => fact.type)).toContain("secret_like_value_detected");
    expect(JSON.stringify(secret)).not.toContain("ghp_123456");
  });
});
