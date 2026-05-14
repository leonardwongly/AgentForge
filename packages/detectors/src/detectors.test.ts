import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
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
    migrationPaths: [
      "db/migrations/**",
      "migrations/**",
      "prisma/migrations/**",
      "**/prisma/migrations/**"
    ]
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

  it("detects renamed sensitive paths and nested Prisma migration edits", () => {
    const facts = extractVerifiedFacts(
      {
        repositoryFullName: "acme/payments",
        pullRequestNumber: 14,
        title: "Move auth and edit migration",
        authorLogin: "sam",
        baseBranch: "main",
        headBranch: "feature/move-auth",
        headSha: "sha14",
        changedFiles: [
          {
            filename: "src/session.ts",
            previousFilename: "src/auth/session.ts",
            status: "renamed"
          },
          {
            filename: "packages/db/prisma/migrations/20260513000000_init/migration.sql",
            status: "modified",
            patch: "+ALTER TABLE users ADD COLUMN risk_score INTEGER;"
          }
        ]
      },
      fintechConfig()
    );

    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "sensitive_path_changed",
          path: "src/auth/session.ts"
        }),
        expect.objectContaining({
          type: "migration_added",
          path: "packages/db/prisma/migrations/20260513000000_init/migration.sql",
          metadata: expect.objectContaining({ status: "modified" })
        })
      ])
    );
  });

  it("flags dependency changes from patches when manifest contents are unavailable", () => {
    const facts = extractVerifiedFacts(
      {
        repositoryFullName: "acme/payments",
        pullRequestNumber: 15,
        title: "Add dependency without content fetch",
        authorLogin: "sam",
        baseBranch: "main",
        headBranch: "feature/deps",
        headSha: "sha15",
        changedFiles: [
          {
            filename: "package.json",
            status: "modified",
            patch: '@@\n+    "left-pad": "2.0.0"'
          }
        ]
      },
      fintechConfig()
    );

    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "dependency_added",
          confidence: "observed",
          metadata: expect.objectContaining({ patchOnly: true })
        })
      ])
    );
  });

  it("handles a 500-file PR without unbounded detector work", () => {
    const pr: PullRequestInput = {
      repositoryFullName: "acme/large-pr",
      pullRequestNumber: 500,
      title: "Large generated fixture",
      authorLogin: "developer",
      baseBranch: "main",
      headBranch: "feature/large-pr",
      headSha: "abc500",
      body: "Large metadata-only evaluation.",
      labels: [],
      commits: [],
      changedFiles: Array.from({ length: 500 }, (_, index) => ({
        filename: `docs/generated-${index}.md`,
        status: "modified",
        patch: `+line ${index}`
      }))
    };

    const started = performance.now();
    const facts = extractVerifiedFacts(pr, fintechConfig());
    const durationMs = performance.now() - started;

    expect(facts).toHaveLength(0);
    expect(durationMs).toBeLessThan(2000);
  });
});
