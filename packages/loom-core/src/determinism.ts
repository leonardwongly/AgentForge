/**
 * @agentforge/loom-core — determinism boundary (design §9.5 / §12
 * "Determinism boundary").
 *
 * The fact-cache key binds a detector run to the exact inputs that can change
 * its output, so identical inputs reuse a cached verdict and any input change
 * invalidates it. Only `pinned` recipes are replayable, and only their facts
 * are `verified` (blockable); every other class is `attested` (advisory /
 * non-blocking).
 */
import { canonicalize, sha256Hex } from "./addressing.js";
import type { Cid, DeterminismClass, Recipe } from "./types.js";

export interface FactKeyInput {
  readonly detectorRegistryVersion: string;
  readonly baseState: Cid;
  readonly resultState: Cid;
  readonly diffViewDigest: string;
  readonly toolchainDigest: string;
  readonly policyVersionHash: string;
}

/**
 * Stable, order-insensitive cache key for a detector's verified facts. Reuses
 * the canonical encoder (recursively sorted keys) so the declaration order of
 * fields in `input` never affects the key, while any field value change does.
 */
export function factCacheKey(input: FactKeyInput): string {
  return sha256Hex(canonicalize(input));
}

/** A recipe is replayable iff its determinism class is `pinned`. */
export function isReplayableRecipe(recipe: Recipe): boolean {
  return recipe.determinismClass === "pinned";
}

/**
 * Confidence a fact derives from its recipe's determinism class: `pinned` facts
 * are reproducible and therefore `verified` (blockable); every other class is
 * `attested` (advisory, non-blocking).
 */
export function determinismConfidence(cls: DeterminismClass): "verified" | "attested" {
  return cls === "pinned" ? "verified" : "attested";
}
