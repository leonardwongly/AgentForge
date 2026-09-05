import { describe, expect, it } from "vitest";

import { reviewRequirementForEffect, reviewRequirementsForEffects } from "./review.js";

describe("native review requirements", () => {
  it("routes a migration effect to database review and evidence", () => {
    const req = reviewRequirementForEffect("adds_migration");
    expect(req?.evidence).toEqual(["rollback_plan", "migration_dry_run"]);
    expect(req?.reviewers).toEqual(["database-owner"]);
  });

  it("routes sensitive-path and secret effects to security review", () => {
    expect(reviewRequirementForEffect("touches_sensitive_path")?.reviewers).toEqual([
      "security-team"
    ]);
    expect(reviewRequirementForEffect("adds_secret_like_value")?.evidence).toEqual([
      "security_note"
    ]);
  });

  it("returns undefined for effects with no review requirement", () => {
    expect(reviewRequirementForEffect("edits_source")).toBeUndefined();
    expect(reviewRequirementForEffect("moves_cell")).toBeUndefined();
  });

  it("derives deduplicated requirements across effects", () => {
    const requirements = reviewRequirementsForEffects([
      "adds_migration",
      "adds_dependency",
      "touches_sensitive_path",
      "edits_source"
    ]);
    expect(requirements.map((req) => req.effect).sort()).toEqual([
      "adds_dependency",
      "adds_migration",
      "touches_sensitive_path"
    ]);
  });

  it("returns no requirements for an empty effect set", () => {
    expect(reviewRequirementsForEffects([])).toEqual([]);
  });
});
