import { describe, expect, it } from "vitest";

import type { Effect } from "@agentforge/loom-core";

import { factForEffect, factsFromEffects } from "./facts.js";

/** Every effect the native lane maps to a governance fact. */
const MAPPED_EFFECTS: ReadonlyArray<{ readonly effect: Effect; readonly type: string }> = [
  { effect: "adds_dependency", type: "dependency_added" },
  { effect: "bumps_dependency_major", type: "dependency_bumped" },
  { effect: "bumps_dependency_minor", type: "dependency_bumped" },
  { effect: "adds_migration", type: "migration_added" },
  { effect: "deletes_test", type: "test_deleted" },
  { effect: "skips_test", type: "test_skipped" },
  { effect: "changes_ci", type: "ci_workflow_changed" },
  { effect: "touches_sensitive_path", type: "sensitive_path_changed" },
  { effect: "adds_secret_like_value", type: "secret_like_value_detected" }
];

/** Every effect the native lane deliberately leaves unmapped. */
const UNMAPPED_EFFECTS: readonly Effect[] = [
  "edits_source",
  "deletes_source",
  "moves_cell",
  "removes_dependency",
  "deletes_migration",
  "adds_generated_artifact"
];

describe("factsFromEffects (native policy facts)", () => {
  it("maps policy-relevant effects to verified facts", () => {
    const facts = factsFromEffects({
      effects: ["adds_dependency", "adds_migration", "deletes_test", "changes_ci"],
      paths: ["package.json", "db/migration.sql", "src/x.test.ts", ".github/workflows/ci.yml"]
    });
    const types = facts.map((fact) => fact.type).sort();
    expect(types).toEqual(["ci_workflow_changed", "dependency_added", "migration_added", "test_deleted"]);
    for (const fact of facts) {
      expect(fact.confidence).toBe("verified");
      expect(fact.source).toBe("loom_effects");
    }
  });

  it("maps every mapped effect to a stable, effect-derived fact id and type", () => {
    for (const { effect, type } of MAPPED_EFFECTS) {
      const fact = factForEffect(effect, ["a.ts"]);
      expect(fact, effect).toBeDefined();
      expect(fact?.id, effect).toBe(`fact:effect:${effect}`);
      expect(fact?.type, effect).toBe(type);
      expect(fact?.evidence, effect).toContain(effect);
      expect(fact?.confidence, effect).toBe("verified");
      expect(fact?.path, effect).toBe("a.ts");
    }
    // Two effects mapping to the same fact TYPE still keep distinct ids.
    const ids = MAPPED_EFFECTS.map(({ effect }) => factForEffect(effect, ["a.ts"])?.id);
    expect(new Set(ids).size).toBe(MAPPED_EFFECTS.length);
    // The sensitive-path fact additionally carries the rule it maps to.
    expect(factForEffect("touches_sensitive_path", ["a.ts"])?.metadata).toEqual({
      ruleId: "sensitive_paths"
    });
  });

  it("returns undefined for every non-policy-relevant effect", () => {
    for (const effect of UNMAPPED_EFFECTS) {
      expect(factForEffect(effect, ["a.ts"]), effect).toBeUndefined();
    }
    expect(factsFromEffects({ effects: UNMAPPED_EFFECTS, paths: ["a.ts"] })).toEqual([]);
  });

  it("returns no facts for an empty declaration", () => {
    expect(factsFromEffects({ effects: [], paths: ["a.ts"] })).toEqual([]);
  });

  it("leaves fact.path undefined rather than crashing when no paths are supplied", () => {
    const fact = factForEffect("changes_ci", []);
    expect(fact?.type).toBe("ci_workflow_changed");
    expect(fact?.path).toBeUndefined();
    expect(factsFromEffects({ effects: ["changes_ci"], paths: [] })[0]?.type).toBe(
      "ci_workflow_changed"
    );
  });

  it("treats a '__proto__' path string as an ordinary path value", () => {
    const fact = factForEffect("touches_sensitive_path", ["__proto__"]);
    expect(fact?.path).toBe("__proto__");
  });

  it("passes through duplicate declared effects verbatim (dedupe is the evaluator's job)", () => {
    const facts = factsFromEffects({ effects: ["adds_migration", "adds_migration"], paths: ["m.sql"] });
    expect(facts).toHaveLength(2);
    expect(facts[0]?.id).toBe("fact:effect:adds_migration");
    expect(facts[1]?.id).toBe("fact:effect:adds_migration");
  });
});
