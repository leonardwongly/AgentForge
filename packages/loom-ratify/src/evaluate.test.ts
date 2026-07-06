import { describe, it, expect } from "vitest";
import type { Cell, NodeIdent, State } from "@agentforge/loom-core";
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
});
