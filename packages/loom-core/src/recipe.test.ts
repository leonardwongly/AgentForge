import { describe, expect, it } from "vitest";

import { createRecipe, validateRecipeRule } from "./recipe.js";

const TOOLCHAIN = { engineDigest: "e", runtimeDigest: "r" };

const base = {
  determinismClass: "pinned" as const,
  toolchain: TOOLCHAIN,
  inputSelector: [{ path: "a.ts" }],
  writeScope: [{ path: "a.ts" }]
};

describe("Recipe SDK", () => {
  it("builds a valid regex-replace recipe", () => {
    const recipe = createRecipe({ ...base, engine: "regex-replace", rule: { find: "foo", replace: "bar" } });
    expect(recipe.engine).toBe("regex-replace");
    expect(recipe.rule).toEqual({ find: "foo", replace: "bar" });
  });

  it("builds a valid dep-bump recipe", () => {
    const recipe = createRecipe({
      ...base,
      engine: "dep-bump",
      rule: { name: "left-pad", from: "1.0.0", to: "2.0.0" }
    });
    expect(recipe.engine).toBe("dep-bump");
  });

  it("rejects an invalid regex-replace rule", () => {
    expect(() => createRecipe({ ...base, engine: "regex-replace", rule: { find: "", replace: "b" } })).toThrow(
      /non-empty string 'find'/
    );
  });

  it("rejects an invalid dep-bump rule", () => {
    expect(() => createRecipe({ ...base, engine: "dep-bump", rule: { name: "x", from: "", to: "2" } })).toThrow(
      /non-empty string 'from'/
    );
  });

  it("rejects an oversized recipe against the budget", () => {
    expect(() =>
      createRecipe(
        { ...base, engine: "regex-replace", rule: { find: "a".repeat(1_000_000), replace: "b" } },
        { maxInputs: 1000, maxRuleBytes: 1024, maxWrites: 100, maxWriteBytes: 1024, maxTotalWriteBytes: 4096, maxInvariants: 10 }
      )
    ).toThrow(/maxRuleBytes/);
  });

  it("rejects an invalid invariant", () => {
    expect(() =>
      createRecipe({
        ...base,
        engine: "regex-replace",
        rule: { find: "a", replace: "b" },
        invariants: [{ kind: "max_cells_written", limit: -1 }]
      })
    ).toThrow(/invalid recipe invariant/);
  });

  it("validateRecipeRule rejects an unknown engine", () => {
    expect(validateRecipeRule({ ...base, engine: "unknown" as never, rule: {} })).toMatch(/unknown engine/);
  });
});
