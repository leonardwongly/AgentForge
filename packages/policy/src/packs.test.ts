import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PullRequestInput } from "@agentforge/core";
import { detectorConfigFromPolicy, extractVerifiedFacts } from "@agentforge/detectors";
import { builtinPolicyPacks, getPolicyPack } from "./packs.js";
import { parsePolicyYaml } from "./parser.js";
import { evaluateMergeGuard } from "./evaluate.js";

async function loadFixturePr(name: string): Promise<PullRequestInput> {
  return JSON.parse(
    await readFile(path.resolve(process.cwd(), "fixtures", "repos", name), "utf8")
  ) as PullRequestInput;
}

async function evaluatePack(packId: string, fixture: string) {
  const pack = getPolicyPack(packId);
  if (!pack) {
    throw new Error(`Unknown policy pack: ${packId}`);
  }
  const parsed = parsePolicyYaml(pack.contentYaml);
  expect(parsed.errors).toEqual([]);
  const pr = await loadFixturePr(fixture);
  const facts = extractVerifiedFacts(pr, detectorConfigFromPolicy(parsed.config));
  return evaluateMergeGuard(pr, facts, parsed.config);
}

describe("built-in policy packs", () => {
  it("use unique ids and valid embedded YAML", () => {
    const ids = builtinPolicyPacks.map((pack) => pack.id);

    expect(new Set(ids).size).toBe(ids.length);
    for (const pack of builtinPolicyPacks) {
      const parsed = parsePolicyYaml(pack.contentYaml);

      expect(parsed.errors).toEqual([]);
      expect(parsed.config.policy_pack_id).toBe(pack.id);
      expect(parsed.config.policy_pack_version).toBe(pack.version);
      expect(parsed.config.agentforge.mode).toBe(pack.defaultMode);
    }
  });

  it("keep shipped packs metadata-only and redacted by default", () => {
    for (const pack of builtinPolicyPacks) {
      const parsed = parsePolicyYaml(pack.contentYaml);

      expect(parsed.errors).toEqual([]);
      expect(parsed.config.data_retention).toMatchObject({
        source_code_storage: false,
        full_diff_retention: "disabled",
        redact_secrets: true,
        llm_features: false
      });
    }
  });

  it("preserves enforce semantics only for enforce-ready packs", () => {
    const enforceReadyPackIds = builtinPolicyPacks
      .filter((pack) => pack.defaultMode === "enforce")
      .map((pack) => pack.id);

    expect(enforceReadyPackIds).toEqual(["enterprise-strict"]);
  });
});

describe("built-in policy pack block rules resolve under a warn-mode org default", () => {
  // Regression coverage for the mode/action mismatch bug: a rule's action: "block"
  // (or a database rule's implicit default action of "block") is inert unless the
  // resolved mode (org agentforge.mode combined with any rule-level mode override)
  // is "enforce" or "optimize". These packs default their org mode to "warn", so
  // each of these rules needed an explicit rule-level `mode: enforce` override to
  // actually block instead of silently downgrading to a non-blocking "warn" status.

  it("blocks deleted tests in startup-default despite the org's warn-mode default", async () => {
    const result = await evaluatePack("startup-default", "deleted-test.json");

    expect(result.mode).toBe("enforce");
    expect(result.status).toBe("block");
    expect(result.requiredEvidence.map((item) => item.kind)).toContain("deleted_test_explanation");
  });

  it("blocks skipped tests in startup-default despite the org's warn-mode default", async () => {
    const result = await evaluatePack("startup-default", "skipped-test.json");

    expect(result.mode).toBe("enforce");
    expect(result.status).toBe("block");
    expect(result.requiredEvidence.map((item) => item.kind)).toContain("deleted_test_explanation");
  });

  it("blocks deleted tests in platform-engineering despite the org's warn-mode default", async () => {
    const result = await evaluatePack("platform-engineering", "deleted-test.json");

    expect(result.mode).toBe("enforce");
    expect(result.status).toBe("block");
  });

  it("blocks deleted tests in fintech despite the org's warn-mode default", async () => {
    const result = await evaluatePack("fintech", "deleted-test.json");

    expect(result.mode).toBe("enforce");
    expect(result.status).toBe("block");
  });

  it("blocks database migrations in healthcare-regulated despite the org's warn-mode default", async () => {
    const result = await evaluatePack("healthcare-regulated", "migration-added.json");

    expect(result.mode).toBe("enforce");
    expect(result.status).toBe("block");
    expect(result.requiredReviewers.map((item) => item.reviewer)).toContain("database-owner");
  });

  it("blocks database migrations in startup-default despite the org's warn-mode default", async () => {
    // database.migrations here has no explicit `action`, so databaseRuleSchema's
    // default of action: "block" applies. This rule was missed in the initial fix
    // pass (only healthcare-regulated's migrations rule was covered) because it has
    // no explicit `action: block` text to grep for -- confirmed and closed alongside
    // the require_review fix pass.
    const result = await evaluatePack("startup-default", "migration-added.json");

    expect(result.mode).toBe("enforce");
    expect(result.status).toBe("block");
  });

  it("blocks database migrations in platform-engineering despite the org's warn-mode default", async () => {
    const result = await evaluatePack("platform-engineering", "migration-added.json");

    expect(result.mode).toBe("enforce");
    expect(result.status).toBe("block");
    expect(result.requiredReviewers.map((item) => item.reviewer)).toContain("database-owner");
  });

  it("blocks database migrations in fintech despite the org's warn-mode default", async () => {
    const result = await evaluatePack("fintech", "migration-added.json");

    expect(result.mode).toBe("enforce");
    expect(result.status).toBe("block");
    expect(result.requiredReviewers.map((item) => item.reviewer)).toContain("database-owner");
  });

  it("leaves healthcare-regulated's already-correct deleted_tests override unaffected", async () => {
    const result = await evaluatePack("healthcare-regulated", "deleted-test.json");

    expect(result.mode).toBe("enforce");
    expect(result.status).toBe("block");
  });

  it("does not change open-source-maintainer's intentional warn-everywhere posture", async () => {
    // deleted_tests here is action: warn (not block/require_review), so makeHit clears
    // required evidence/reviewers entirely and the rule never contributes to wouldBlock.
    // It correctly resolves to a clean pass, confirming this pack was left untouched.
    const result = await evaluatePack("open-source-maintainer", "deleted-test.json");

    expect(result.mode).toBe("warn");
    expect(result.status).toBe("pass");
    expect(result.requiredEvidence).toHaveLength(0);
    expect(result.requiredReviewers).toHaveLength(0);
  });

  it("does not change enterprise-strict's already-enforcing org-level mode", async () => {
    const result = await evaluatePack("enterprise-strict", "deleted-test.json");

    expect(result.mode).toBe("enforce");
    expect(result.status).toBe("block");
  });
});

describe("built-in policy pack require_review rules resolve under a warn-mode org default", () => {
  // Same mode/action mismatch bug, for the require_review action instead of block.
  // hitForSensitivePathFact falls back to action: "require_review" when a
  // sensitive_paths rule has no explicit `action` (schema.ts's pathRuleSchema.action
  // has no default), and every dependencies.* rule below is an explicit
  // action: require_review. Per evaluateMergeGuard, an unapproved required reviewer
  // only produces status: "block" when the resolved mode is "enforce"/"optimize" -- a
  // rule-level `mode: enforce` override was added to each of these rules so their
  // required-reviewer gates actually block instead of silently downgrading to a
  // non-blocking "warn" status, matching how the block-action rules were already
  // fixed above.

  it("blocks an unreviewed CI/deploy change in startup-default despite the org's warn-mode default", async () => {
    const result = await evaluatePack("startup-default", "ci-workflow.json");

    expect(result.mode).toBe("enforce");
    expect(result.status).toBe("block");
    expect(result.requiredReviewers.map((item) => item.reviewer)).toContain("platform-team");
  });

  it("blocks an unreviewed new dependency in startup-default despite the org's warn-mode default", async () => {
    const result = await evaluatePack("startup-default", "dependency-added.json");

    expect(result.mode).toBe("enforce");
    expect(result.status).toBe("block");
  });

  it("blocks an unreviewed CI/deploy change in platform-engineering despite the org's warn-mode default", async () => {
    const result = await evaluatePack("platform-engineering", "ci-workflow.json");

    expect(result.mode).toBe("enforce");
    expect(result.status).toBe("block");
    expect(result.requiredReviewers.map((item) => item.reviewer)).toContain("platform-team");
  });

  it("blocks an unreviewed new dependency in platform-engineering despite the org's warn-mode default", async () => {
    const result = await evaluatePack("platform-engineering", "dependency-added.json");

    expect(result.mode).toBe("enforce");
    expect(result.status).toBe("block");
    expect(result.requiredReviewers.map((item) => item.reviewer)).toContain("security-team");
  });

  it("blocks an unreviewed billing-path change in fintech despite the org's warn-mode default", async () => {
    const result = await evaluatePack("fintech", "billing-path.json");

    expect(result.mode).toBe("enforce");
    expect(result.status).toBe("block");
    expect(result.requiredReviewers.map((item) => item.reviewer)).toContain("billing-owner");
  });

  it("blocks an unreviewed new dependency in fintech despite the org's warn-mode default", async () => {
    const result = await evaluatePack("fintech", "dependency-added.json");

    expect(result.mode).toBe("enforce");
    expect(result.status).toBe("block");
    expect(result.requiredReviewers.map((item) => item.reviewer)).toContain("security-team");
  });

  it("blocks an unreviewed major dependency bump in fintech despite the org's warn-mode default", async () => {
    const result = await evaluatePack("fintech", "dependency-bump.json");

    expect(result.mode).toBe("enforce");
    expect(result.status).toBe("block");
    expect(result.requiredReviewers.map((item) => item.reviewer)).toContain("security-team");
  });

  it("blocks an unreviewed new dependency in healthcare-regulated despite the org's warn-mode default", async () => {
    const result = await evaluatePack("healthcare-regulated", "dependency-added.json");

    expect(result.mode).toBe("enforce");
    expect(result.status).toBe("block");
    expect(result.requiredReviewers.map((item) => item.reviewer)).toContain("security-team");
  });

  it("does not change open-source-maintainer's intentional warn-everywhere posture for dependencies", async () => {
    // dependencies.new_package here is action: warn, not require_review, so it never
    // contributes a reviewer requirement to wouldBlock regardless of mode resolution.
    const result = await evaluatePack("open-source-maintainer", "dependency-added.json");

    expect(result.mode).toBe("warn");
    expect(result.status).toBe("pass");
    expect(result.requiredReviewers).toHaveLength(0);
  });

  it("does not change enterprise-strict's already-enforcing org-level mode for dependencies", async () => {
    const result = await evaluatePack("enterprise-strict", "dependency-added.json");

    expect(result.mode).toBe("enforce");
    expect(result.status).toBe("block");
  });
});
