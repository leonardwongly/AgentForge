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
    expect(secret.find((fact) => fact.type === "secret_like_value_detected")).toMatchObject({
      severity: "critical",
      metadata: expect.objectContaining({
        secretCategory: "credential_like",
        secretRisk: "high",
        policyTreatment: "blocking"
      })
    });
    expect(JSON.stringify(secret)).not.toContain("ghp_123456");
  });

  it("downgrades local placeholders and documentation examples without weakening redaction", () => {
    const facts = extractVerifiedFacts(
      {
        repositoryFullName: "acme/payments",
        pullRequestNumber: 16,
        title: "Document local setup",
        authorLogin: "sam",
        baseBranch: "main",
        headBranch: "docs/local-env",
        headSha: "sha16",
        changedFiles: [
          {
            filename: "config/local.env",
            status: "modified",
            patch:
              "+DATABASE_URL=postgresql://agentforge:agentforge@localhost:15432/agentforge\n+API_KEY=placeholder-local-only-token"
          },
          {
            filename: "docs/setup.md",
            status: "modified",
            patch: "+Use DATABASE_URL=postgresql://agentforge:agentforge@localhost:15432/agentforge"
          }
        ]
      },
      fintechConfig()
    ).filter((fact) => fact.type === "secret_like_value_detected");

    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "low",
          metadata: expect.objectContaining({
            secretCategory: "local_placeholder",
            secretRisk: "low",
            policyTreatment: "advisory"
          })
        }),
        expect.objectContaining({
          severity: "low",
          metadata: expect.objectContaining({
            secretCategory: "documentation_example",
            secretRisk: "low",
            policyTreatment: "advisory"
          })
        })
      ])
    );
    expect(JSON.stringify(facts)).not.toContain("agentforge:agentforge");
    expect(JSON.stringify(facts)).not.toContain("placeholder-local-only-token");
  });

  it("keeps credential-shaped quoted env values and long base64-like values critical", () => {
    const stripeLikeToken = "sk_live_" + "abcdefghijklmnopqrstuvwx1234567890";
    const facts = extractVerifiedFacts(
      {
        repositoryFullName: "acme/payments",
        pullRequestNumber: 17,
        title: "Add unsafe secret",
        authorLogin: "sam",
        baseBranch: "main",
        headBranch: "config/secret",
        headSha: "sha17",
        changedFiles: [
          {
            filename: "config/prod.env",
            status: "modified",
            patch:
              "+SESSION_SECRET='rL8PZ1hGx7sQw9Nf4Mb2Vc6Xd8Yt3Ka5Le0Ru9Pi2Zo='\n" +
              `+UNICODE_TOKEN = ${stripeLikeToken}\n` +
              "+DATABASE_URL=postgresql://service:prodSecret123456789@localhost:15432/app"
          },
          {
            filename: "docs/setup.md",
            status: "modified",
            patch: "+DATABASE_URL=postgresql://service:prodSecret123456789@localhost:15432/app"
          }
        ]
      },
      fintechConfig()
    ).filter((fact) => fact.type === "secret_like_value_detected");

    expect(facts.length).toBeGreaterThanOrEqual(1);
    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "critical",
          metadata: expect.objectContaining({
            secretCategory: "credential_like",
            secretRisk: "high",
            policyTreatment: "blocking"
          })
        })
      ])
    );
    expect(JSON.stringify(facts)).not.toContain("rL8PZ1hGx7sQ");
    expect(JSON.stringify(facts)).not.toContain(stripeLikeToken.slice(0, 20));
    expect(JSON.stringify(facts)).not.toContain("prodSecret");
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

  it("treats env-var reads, pinned action SHAs, and template expressions as advisory, not critical", () => {
    const facts = extractVerifiedFacts(
      {
        repositoryFullName: "acme/app",
        pullRequestNumber: 18,
        title: "Wire CI token",
        authorLogin: "sam",
        baseBranch: "main",
        headBranch: "ci/token",
        headSha: "sha18",
        changedFiles: [
          {
            filename: "scripts/ci.ts",
            status: "modified",
            patch: "+const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;"
          },
          {
            filename: ".github/workflows/build.yml",
            status: "modified",
            patch:
              "+      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3\n" +
              "+        env:\n+          GITHUB_TOKEN: ${{ github.token }}"
          }
        ]
      },
      fintechConfig()
    ).filter((fact) => fact.type === "secret_like_value_detected");

    // Env-var reads, pinned SHAs, and ${{ }} expressions are not credentials: never critical.
    expect(facts.every((fact) => fact.severity === "low")).toBe(true);
    expect(
      facts.some(
        (fact) =>
          fact.severity === "critical" || fact.metadata?.secretCategory === "credential_like"
      )
    ).toBe(false);
  });

  it("ignores package.json scripts entries but still flags real dependency additions from patches", () => {
    const facts = extractVerifiedFacts(
      {
        repositoryFullName: "acme/app",
        pullRequestNumber: 19,
        title: "Add a script and a dependency",
        authorLogin: "sam",
        baseBranch: "main",
        headBranch: "chore/scripts",
        headSha: "sha19",
        changedFiles: [
          {
            filename: "package.json",
            status: "modified",
            patch:
              '@@\n   "scripts": {\n+    "merge-guard": "tsx scripts/merge-guard-ci.ts",\n     "build": "tsc"\n   },\n' +
              '   "dependencies": {\n+    "left-pad": "2.0.0",\n     "zod": "4.4.3"\n   }'
          }
        ]
      },
      fintechConfig()
    );
    const addedPackages = facts
      .filter((fact) => fact.type === "dependency_added")
      .map((fact) => fact.metadata?.package);

    expect(addedPackages).toContain("left-pad");
    expect(addedPackages).not.toContain("merge-guard");
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
