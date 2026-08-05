import { describe, expect, it } from "vitest";

import { factForEffect, factsFromEffects } from "./facts.js";

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

  it("maps major and minor dependency bumps to dependency_bumped", () => {
    const facts = factsFromEffects({ effects: ["bumps_dependency_major", "bumps_dependency_minor"], paths: ["package.json"] });
    expect(facts.map((fact) => fact.type)).toEqual(["dependency_bumped", "dependency_bumped"]);
  });

  it("maps sensitive-path and secret effects", () => {
    const facts = factsFromEffects({ effects: ["touches_sensitive_path", "adds_secret_like_value"], paths: ["src/billing/x.ts"] });
    const types = facts.map((fact) => fact.type).sort();
    expect(types).toEqual(["secret_like_value_detected", "sensitive_path_changed"]);
    expect(facts.find((fact) => fact.type === "sensitive_path_changed")?.metadata).toEqual({
      ruleId: "sensitive_paths"
    });
  });

  it("returns no facts for non-policy-relevant effects", () => {
    expect(factsFromEffects({ effects: ["edits_source", "deletes_source", "moves_cell"], paths: ["a.ts"] })).toEqual([]);
  });

  it("factForEffect returns undefined for unknown effects", () => {
    expect(factForEffect("adds_generated_artifact", ["a.ts"])).toBeUndefined();
  });
});
