import { describe, it, expect } from "vitest";
import type { Cell, NodeIdent, State } from "@agentforge/loom-core";
import { stateAddress } from "@agentforge/loom-core";
import { parsePolicyYaml, type PolicyConfig } from "@agentforge/policy";
import { evaluateTransformSet } from "./index.js";

function state(entries: Record<string, { ident: string; text: string }>): State {
  const cells: Record<string, Cell> = {};
  for (const [path, entry] of Object.entries(entries)) {
    cells[path] = { facet: "text", ident: entry.ident as NodeIdent, text: entry.text };
  }
  return { kind: "state", cells };
}

const POLICY_YAML = `version: 1
agentforge:
  mode: enforce
  apply_to:
    - all_pull_requests
sensitive_paths:
  billing:
    paths:
      - "src/billing/**"
    required_reviewers:
      - "alice"
`;

function policyOf(yaml: string): PolicyConfig {
  const parsed = parsePolicyYaml(yaml);
  expect(parsed.errors).toEqual([]);
  return parsed.config;
}

const base = state({ "README.md": { ident: "nid:readme", text: "# hi" } });
const sensitiveResult = state({
  "README.md": { ident: "nid:readme", text: "# hi" },
  "src/billing/charge.ts": { ident: "nid:bill", text: "export const charge = () => 1;" }
});

const commonInput = {
  space: "loom/acme",
  lineRef: "line:shared:main",
  proposalId: "p-1",
  intent: { title: "touch billing" },
  author: "did:loom:agent-7"
};

describe("evaluateTransformSet — governance engine re-homed onto Loom", () => {
  it("BLOCKS a sensitive-path Transform with no required reviewer (enforce)", () => {
    const ev = evaluateTransformSet({
      ...commonInput,
      base,
      result: sensitiveResult,
      policy: policyOf(POLICY_YAML)
    });
    expect(ev.result.status).toBe("block");
    expect(ev.result.findings.some((f) => f.type === "sensitive_path_changed")).toBe(true);
    expect(ev.result.requiredReviewers.some((r) => r.reviewer === "alice" && !r.approved)).toBe(
      true
    );
    // The synthesized input carried the exact changed path from the Transform.
    expect(ev.diff.some((f) => f.filename === "src/billing/charge.ts")).toBe(true);
  });

  it("PASSES once the required reviewer approves", () => {
    const ev = evaluateTransformSet({
      ...commonInput,
      base,
      result: sensitiveResult,
      policy: policyOf(POLICY_YAML),
      reviews: [
        {
          reviewer: "alice",
          reviewerType: "user",
          state: "APPROVED",
          submittedAt: "2026-07-06T00:00:00.000Z"
        }
      ]
    });
    expect(ev.result.requiredReviewers.some((r) => r.reviewer === "alice" && r.approved)).toBe(
      true
    );
    expect(ev.result.status).toBe("pass");
  });

  it("records the finding but never blocks in observe mode", () => {
    const ev = evaluateTransformSet({
      ...commonInput,
      base,
      result: sensitiveResult,
      policy: policyOf(POLICY_YAML.replace("mode: enforce", "mode: observe"))
    });
    expect(ev.result.status).toBe("pass");
    expect(ev.result.findings.some((f) => f.type === "sensitive_path_changed")).toBe(true);
  });

  it("cannot suppress structural security facts with an empty declaration", () => {
    const ev = evaluateTransformSet({
      ...commonInput,
      base,
      result: sensitiveResult,
      policy: policyOf(POLICY_YAML),
      effects: []
    });
    expect(ev.result.status).toBe("block");
    expect(ev.result.findings.some((f) => f.type === "sensitive_path_changed")).toBe(true);
    expect(ev.facts.some((fact) => fact.type === "sensitive_path_changed")).toBe(true);
  });

  it("does not over-fire on a non-sensitive change", () => {
    const cleanResult = state({ "README.md": { ident: "nid:readme", text: "# hi there" } });
    const ev = evaluateTransformSet({
      ...commonInput,
      base,
      result: cleanResult,
      policy: policyOf(POLICY_YAML)
    });
    expect(ev.result.status).toBe("pass");
    expect(ev.result.findings.some((f) => f.type === "sensitive_path_changed")).toBe(false);
  });

  it("evaluates an empty transform to a clean pass with a synthesized input", () => {
    const ev = evaluateTransformSet({
      ...commonInput,
      base: state({}),
      result: state({}),
      policy: policyOf(POLICY_YAML)
    });
    expect(ev.diff).toEqual([]);
    expect(ev.facts).toEqual([]);
    expect(ev.result.status).toBe("pass");
    expect(ev.result.findings).toEqual([]);
    expect(ev.synthesizedInput.changedFiles).toEqual([]);
    expect(ev.synthesizedInput.headSha).toBe(stateAddress(state({})));
    expect(ev.synthesizedInput.pullRequestNumber).toBeGreaterThanOrEqual(0);
    expect(Number.isSafeInteger(ev.synthesizedInput.pullRequestNumber)).toBe(true);
  });

  it("derives a stable correlation number bound to the result State address", () => {
    const first = evaluateTransformSet({
      ...commonInput,
      base,
      result: sensitiveResult,
      policy: policyOf(POLICY_YAML)
    });
    const second = evaluateTransformSet({
      ...commonInput,
      base,
      result: sensitiveResult,
      policy: policyOf(POLICY_YAML)
    });
    const other = evaluateTransformSet({
      ...commonInput,
      base: sensitiveResult,
      result: state({}),
      policy: policyOf(POLICY_YAML)
    });
    expect(first.synthesizedInput.pullRequestNumber).toBe(second.synthesizedInput.pullRequestNumber);
    expect(first.synthesizedInput.headSha).toBe(stateAddress(sensitiveResult));
    expect(other.synthesizedInput.headSha).not.toBe(first.synthesizedInput.headSha);
    expect(other.synthesizedInput.pullRequestNumber).toBeGreaterThanOrEqual(0);
  });

  it("BLOCKS a rename INTO a sensitive path (renames feed the effect inference)", () => {
    const ev = evaluateTransformSet({
      ...commonInput,
      base: state({ "util.ts": { ident: "nid:util", text: "code" } }),
      result: state({ "src/billing/charge.ts": { ident: "nid:util", text: "code" } }),
      policy: policyOf(POLICY_YAML)
    });
    expect(ev.synthesizedInput.changedFiles[0]?.status).toBe("renamed");
    expect(ev.result.status).toBe("block");
    expect(ev.facts.some((f) => f.type === "sensitive_path_changed" && f.source === "loom_effects")).toBe(
      true
    );
    expect(ev.result.findings.some((f) => f.type === "sensitive_path_changed")).toBe(true);
  });

  it("declared semantic effects ADD facts invisible to the diff and gate on default rules", () => {
    const cleanResult = state({ "README.md": { ident: "nid:readme", text: "# hi there" } });
    const ev = evaluateTransformSet({
      ...commonInput,
      base,
      result: cleanResult,
      policy: policyOf(POLICY_YAML),
      effects: ["adds_migration", "deletes_test"]
    });
    const declared = ev.facts.filter((f) => f.source === "loom_effects");
    expect(declared.map((f) => f.type).sort()).toEqual(["migration_added", "test_deleted"]);
    // The README-only diff shows no test deletion, yet the DECLARED effect still trips
    // the engine's default deleted-tests rule (block + explanation evidence).
    expect(ev.result.status).toBe("block");
    expect(
      ev.result.requiredEvidence.some(
        (e) => e.kind === "deleted_test_explanation" && e.requiredByFindingId === "fact:effect:deletes_test"
      )
    ).toBe(true);
  });

  it("deduplicates repeated declared effects to a single fact id", () => {
    const cleanResult = state({ "README.md": { ident: "nid:readme", text: "# hi there" } });
    const ev = evaluateTransformSet({
      ...commonInput,
      base,
      result: cleanResult,
      policy: policyOf(POLICY_YAML),
      effects: ["adds_migration", "adds_migration", "adds_migration"]
    });
    const facts = ev.facts.filter((f) => f.id === "fact:effect:adds_migration");
    expect(facts).toHaveLength(1);
    expect(facts[0]?.type).toBe("migration_added");
  });

  it("under a rule-free policy, inferred facts surface as findings but gate nothing", () => {
    const ev = evaluateTransformSet({
      ...commonInput,
      base,
      result: sensitiveResult,
      policy: policyOf("version: 1\nagentforge:\n  mode: enforce\n")
    });
    // The sensitive path is still inferred from the diff (declared lane)...
    expect(ev.facts.map((f) => f.type)).toEqual(["sensitive_path_changed"]);
    // ...but with no policy rules there are no gates: pass with empty requirements.
    expect(ev.result.status).toBe("pass");
    expect(ev.result.requiredReviewers).toEqual([]);
    expect(ev.result.requiredEvidence).toEqual([]);
  });

  it("does not let a CHANGES_REQUESTED review satisfy the required reviewer gate", () => {
    const ev = evaluateTransformSet({
      ...commonInput,
      base,
      result: sensitiveResult,
      policy: policyOf(POLICY_YAML),
      reviews: [
        {
          reviewer: "alice",
          reviewerType: "user",
          state: "CHANGES_REQUESTED",
          submittedAt: "2026-07-06T00:00:00.000Z"
        }
      ]
    });
    expect(ev.result.status).toBe("block");
    expect(ev.result.requiredReviewers.some((r) => r.reviewer === "alice" && !r.approved)).toBe(true);
  });

  it("copies caller reviews into the synthesized input without aliasing", () => {
    const reviews = [
      {
        reviewer: "alice",
        reviewerType: "user" as const,
        state: "APPROVED" as const,
        submittedAt: "2026-07-06T00:00:00.000Z"
      }
    ];
    const ev = evaluateTransformSet({
      ...commonInput,
      base,
      result: sensitiveResult,
      policy: policyOf(POLICY_YAML),
      reviews
    });
    expect(ev.synthesizedInput.reviews).toEqual(reviews);
    expect(ev.synthesizedInput.reviews).not.toBe(reviews);
  });
});
