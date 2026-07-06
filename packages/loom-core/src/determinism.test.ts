import { describe, expect, it } from "vitest";

import {
  determinismConfidence,
  factCacheKey,
  isReplayableRecipe,
  type FactKeyInput
} from "./determinism.js";
import type { Cid, DeterminismClass, Recipe, ToolchainLock } from "./types.js";

const cid = (value: string): Cid => value as Cid;

const baseInput: FactKeyInput = {
  detectorRegistryVersion: "detector-registry@1",
  baseState: cid("loom:sha256:base"),
  resultState: cid("loom:sha256:result"),
  diffViewDigest: "diff-view-digest",
  toolchainDigest: "toolchain-digest",
  policyVersionHash: "policy-version-hash"
};

describe("factCacheKey", () => {
  it("is stable for identical inputs and is a 64-char sha256 hex string", () => {
    const key = factCacheKey(baseInput);
    expect(factCacheKey(baseInput)).toBe(key);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is insensitive to field declaration order", () => {
    // Same values, keys declared in the opposite order.
    const reordered: FactKeyInput = {
      policyVersionHash: "policy-version-hash",
      toolchainDigest: "toolchain-digest",
      diffViewDigest: "diff-view-digest",
      resultState: cid("loom:sha256:result"),
      baseState: cid("loom:sha256:base"),
      detectorRegistryVersion: "detector-registry@1"
    };
    expect(factCacheKey(reordered)).toBe(factCacheKey(baseInput));
  });

  it("changes when any single field changes", () => {
    const key = factCacheKey(baseInput);
    const variants: ReadonlyArray<FactKeyInput> = [
      { ...baseInput, detectorRegistryVersion: "detector-registry@2" },
      { ...baseInput, baseState: cid("loom:sha256:base-changed") },
      { ...baseInput, resultState: cid("loom:sha256:result-changed") },
      { ...baseInput, diffViewDigest: "diff-view-digest-changed" },
      { ...baseInput, toolchainDigest: "toolchain-digest-changed" },
      { ...baseInput, policyVersionHash: "policy-version-hash-changed" }
    ];

    for (const variant of variants) {
      expect(factCacheKey(variant)).not.toBe(key);
    }

    // Every key (base + all variants) must be distinct.
    const keys = new Set<string>([key, ...variants.map((variant) => factCacheKey(variant))]);
    expect(keys.size).toBe(1 + variants.length);
  });
});

describe("recipe determinism classification", () => {
  const toolchain: ToolchainLock = {
    engineDigest: "engine@1",
    runtimeDigest: "runtime@1"
  };

  const makeRecipe = (determinismClass: DeterminismClass): Recipe => ({
    engine: "regex-replace",
    determinismClass,
    toolchain,
    rule: { find: "foo", replace: "bar" },
    inputSelector: [{ path: "src/a.ts" }],
    writeScope: [{ path: "src/a.ts" }]
  });

  it("marks only pinned recipes replayable", () => {
    expect(isReplayableRecipe(makeRecipe("pinned"))).toBe(true);
    expect(isReplayableRecipe(makeRecipe("environment-sensitive"))).toBe(false);
    expect(isReplayableRecipe(makeRecipe("nondeterministic"))).toBe(false);
  });

  it("maps a pinned class to verified (blockable) and every other class to attested", () => {
    const expectations: ReadonlyArray<readonly [DeterminismClass, "verified" | "attested"]> = [
      ["pinned", "verified"],
      ["environment-sensitive", "attested"],
      ["nondeterministic", "attested"]
    ];
    for (const [cls, expected] of expectations) {
      expect(determinismConfidence(cls)).toBe(expected);
    }
  });
});
