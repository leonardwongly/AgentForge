/**
 * @agentforge/loom-core — Recipe SDK (Phase 3, spec §7.7).
 *
 * Helpers to construct and validate Recipes (the executable, pinned
 * transformations that make a change reapply-eligible). Construction validates
 * the rule shape per engine and the resource budget; validation is a structural
 * check an implementation MUST run before executing an untrusted recipe.
 */

import { validateRecipeBudget, type SandboxLimits } from "./sandbox.js";
import { validateInvariant } from "./invariant-dsl.js";
import type {
  DeterminismClass,
  EngineId,
  Invariant,
  NodeSelector,
  Recipe,
  ToolchainLock
} from "./types.js";

export interface CreateRecipeInput {
  readonly engine: EngineId;
  readonly determinismClass: DeterminismClass;
  readonly toolchain: ToolchainLock;
  readonly rule: Readonly<Record<string, unknown>>;
  readonly inputSelector: ReadonlyArray<NodeSelector>;
  readonly writeScope: ReadonlyArray<NodeSelector>;
  readonly invariants?: ReadonlyArray<Invariant> | undefined;
  readonly expectedResultDigest?: string | undefined;
}

/** Validate a recipe's rule shape for its engine; returns an error or undefined. */
export function validateRecipeRule(recipe: Recipe): string | undefined {
  if (recipe.engine === "regex-replace") {
    const find = recipe.rule["find"];
    const replace = recipe.rule["replace"];
    if (typeof find !== "string" || find === "") {
      return "regex-replace rule requires a non-empty string 'find'";
    }
    if (typeof replace !== "string") {
      return "regex-replace rule requires a string 'replace'";
    }
    return undefined;
  }
  if (recipe.engine === "dep-bump") {
    const name = recipe.rule["name"];
    const from = recipe.rule["from"];
    const to = recipe.rule["to"];
    if (typeof name !== "string" || name === "") {
      return "dep-bump rule requires a non-empty string 'name'";
    }
    if (typeof from !== "string" || from === "") {
      return "dep-bump rule requires a non-empty string 'from'";
    }
    if (typeof to !== "string" || to === "") {
      return "dep-bump rule requires a non-empty string 'to'";
    }
    return undefined;
  }
  return `unknown engine ${recipe.engine}`;
}

/** Build a Recipe, validating its rule and resource budget. */
export function createRecipe(input: CreateRecipeInput, limits?: SandboxLimits): Recipe {
  const recipe: Recipe = {
    engine: input.engine,
    determinismClass: input.determinismClass,
    toolchain: input.toolchain,
    rule: input.rule,
    inputSelector: input.inputSelector,
    writeScope: input.writeScope,
    ...(input.invariants ? { invariants: input.invariants } : {}),
    ...(input.expectedResultDigest !== undefined
      ? { expectedResultDigest: input.expectedResultDigest }
      : {})
  };
  const ruleError = validateRecipeRule(recipe);
  if (ruleError !== undefined) {
    throw new Error(`loom: invalid recipe: ${ruleError}`);
  }
  const budgetError = validateRecipeBudget(recipe, limits);
  if (budgetError !== undefined) {
    throw new Error(`loom: invalid recipe: ${budgetError}`);
  }
  for (const invariant of recipe.invariants ?? []) {
    const invariantError = validateInvariant(invariant);
    if (invariantError !== undefined) {
      throw new Error(`loom: invalid recipe invariant: ${invariantError}`);
    }
  }
  return recipe;
}
