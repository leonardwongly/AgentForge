import { describe, expect, it } from "vitest";

import {
  EFFECT_VOCABULARY,
  effectFingerprint,
  effectFingerprintDigest,
  parseInvariantDsl,
  validateInvariant
} from "./invariant-dsl.js";

describe("effect fingerprint schema", () => {
  it("freezes a non-empty, closed effect vocabulary", () => {
    expect(EFFECT_VOCABULARY.length).toBeGreaterThan(0);
    expect(new Set(EFFECT_VOCABULARY).size).toBe(EFFECT_VOCABULARY.length); // no duplicates
  });

  it("produces a sorted, deduplicated, versioned fingerprint", () => {
    const fp = effectFingerprint(["skips_test", "edits_source", "skips_test"]);
    expect(fp.version).toBe(1);
    expect(fp.effects).toEqual(["edits_source", "skips_test"]);
  });

  it("is deterministic and domain-separated", () => {
    expect(effectFingerprintDigest(["edits_source", "deletes_test"])).toBe(
      effectFingerprintDigest(["deletes_test", "edits_source"])
    );
    expect(effectFingerprintDigest(["edits_source"])).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects unknown effects", () => {
    expect(() => effectFingerprint(["not_an_effect" as never])).toThrow(/unknown effect/);
  });
});

describe("bounded invariant DSL", () => {
  it("parses all three invariant kinds", () => {
    const invariants = parseInvariantDsl(
      "max_cells_written=5; no_new_effect=edits_source,deletes_test; path_unchanged=src/a.ts"
    );
    expect(invariants).toEqual([
      { kind: "max_cells_written", limit: 5 },
      { kind: "no_new_effect", not: ["edits_source", "deletes_test"] },
      { kind: "path_unchanged", path: "src/a.ts" }
    ]);
  });

  it("returns an empty list for blank input", () => {
    expect(parseInvariantDsl("")).toEqual([]);
    expect(parseInvariantDsl("   ")).toEqual([]);
  });

  it("rejects unknown invariant kinds", () => {
    expect(() => parseInvariantDsl("delete_everything=1")).toThrow(/unknown invariant kind/);
  });

  it("rejects malformed and out-of-range limits", () => {
    expect(() => parseInvariantDsl("max_cells_written=abc")).toThrow(/non-negative integer/);
    expect(() => parseInvariantDsl("max_cells_written=-1")).toThrow(/non-negative integer/);
    expect(() => parseInvariantDsl("max_cells_written=999999999")).toThrow(/exceeds bound/);
  });

  it("rejects unknown effects and empty effect lists", () => {
    expect(() => parseInvariantDsl("no_new_effect=made_up")).toThrow(/unknown effect/);
    expect(() => parseInvariantDsl("no_new_effect=")).toThrow(/at least one effect/);
  });

  it("rejects an empty path", () => {
    expect(() => parseInvariantDsl("path_unchanged=")).toThrow(/non-empty path/);
  });

  it("rejects a clause without '='", () => {
    expect(() => parseInvariantDsl("max_cells_written")).toThrow(/missing "="/);
  });

  it("validates decoded invariants", () => {
    expect(validateInvariant({ kind: "max_cells_written", limit: 3 })).toBeUndefined();
    expect(validateInvariant({ kind: "max_cells_written", limit: -1 })).toMatch(/non-negative/);
    expect(validateInvariant({ kind: "max_cells_written", limit: 999999999 })).toMatch(/bound/);
    expect(validateInvariant({ kind: "no_new_effect", not: [] })).toMatch(/at least one/);
    expect(validateInvariant({ kind: "no_new_effect", not: ["nope" as never] })).toMatch(
      /unknown effect/
    );
    expect(validateInvariant({ kind: "path_unchanged", path: "" })).toMatch(/non-empty/);
    expect(validateInvariant({ kind: "path_unchanged", path: "a.ts" })).toBeUndefined();
  });
});
