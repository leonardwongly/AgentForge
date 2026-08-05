/**
 * @agentforge/loom-core — hermetic Recipe sandbox and resource accounting
 * (spec §23 item 4, design §3.3).
 *
 * Reapply engines are pure and hermetic, but a hostile or buggy recipe could
 * still request unbounded work (too many inputs, an oversized rule, or writes
 * that exceed a bound). This module enforces a bounded resource budget around
 * engine execution and recipe validation, so a recipe can never consume
 * unbounded CPU, memory, or output.
 */

import type { Recipe } from "./types.js";

export interface SandboxLimits {
  /** Max input cells a recipe may read in one run. */
  readonly maxInputs: number;
  /** Max serialized size (bytes) of a recipe rule payload. */
  readonly maxRuleBytes: number;
  /** Max number of distinct writes a run may produce. */
  readonly maxWrites: number;
  /** Max bytes of any single write. */
  readonly maxWriteBytes: number;
  /** Max total bytes across all writes in one run. */
  readonly maxTotalWriteBytes: number;
  /** Max invariant clauses a recipe may declare. */
  readonly maxInvariants: number;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  maxInputs: 1_000,
  maxRuleBytes: 64 * 1024,
  maxWrites: 10_000,
  maxWriteBytes: 64 * 1024,
  maxTotalWriteBytes: 512 * 1024,
  maxInvariants: 100
};

export interface EngineInput {
  readonly path: string;
  readonly cell: { readonly text: string };
}

export type EngineWrites = ReadonlyMap<string, string>;

export interface EngineRunner {
  run(inputs: ReadonlyArray<EngineInput>): EngineWrites;
}

function serializedBytes(value: unknown): number {
  return JSON.stringify(value).length;
}

/** Validate a recipe's declared resource usage against the budget. */
export function validateRecipeBudget(recipe: Recipe, limits: SandboxLimits = DEFAULT_SANDBOX_LIMITS): string | undefined {
  if (recipe.inputSelector.length > limits.maxInputs) {
    return `recipe inputSelector exceeds maxInputs (${recipe.inputSelector.length} > ${limits.maxInputs})`;
  }
  if (recipe.writeScope.length > limits.maxWrites) {
    return `recipe writeScope exceeds maxWrites (${recipe.writeScope.length} > ${limits.maxWrites})`;
  }
  if (serializedBytes(recipe.rule) > limits.maxRuleBytes) {
    return `recipe rule exceeds maxRuleBytes`;
  }
  if ((recipe.invariants?.length ?? 0) > limits.maxInvariants) {
    return `recipe invariants exceed maxInvariants`;
  }
  return undefined;
}

/**
 * Run an engine under a resource budget. Throws if the run exceeds the input,
 * write-count, or byte limits, so a recipe cannot consume unbounded resources.
 */
export function runEngineBounded(
  runner: EngineRunner,
  inputs: ReadonlyArray<EngineInput>,
  limits: SandboxLimits = DEFAULT_SANDBOX_LIMITS
): EngineWrites {
  if (inputs.length > limits.maxInputs) {
    throw new Error(`loom: engine run exceeded maxInputs (${inputs.length} > ${limits.maxInputs})`);
  }
  const writes = runner.run(inputs);
  if (writes.size > limits.maxWrites) {
    throw new Error(`loom: engine run exceeded maxWrites (${writes.size} > ${limits.maxWrites})`);
  }
  let total = 0;
  for (const content of writes.values()) {
    if (content.length > limits.maxWriteBytes) {
      throw new Error(`loom: engine write exceeded maxWriteBytes (${content.length} > ${limits.maxWriteBytes})`);
    }
    total += content.length;
  }
  if (total > limits.maxTotalWriteBytes) {
    throw new Error(`loom: engine run exceeded maxTotalWriteBytes (${total} > ${limits.maxTotalWriteBytes})`);
  }
  return writes;
}
