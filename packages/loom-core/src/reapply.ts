/**
 * @agentforge/loom-core — the reapply engine.
 *
 * `reapply` re-executes a pinned {@link Recipe} against a moved base to
 * *recompute* a mechanical change, instead of re-projecting an old diff (design
 * docs/loom/reapply-merge-engine.md §3). It is an optimization on top of the
 * merge floor in merge.ts and only ever wins for mechanical, deterministic
 * transforms; anything uncertain returns a {@link ReapplyOutcome} that the caller
 * degrades to text 3-way.
 *
 * Engines here are pure and hermetic: no clock, no network, no ambient state.
 * They read only the declared input Cells and the rule payload.
 */

import { cellAddress, stateAddress } from "./addressing.js";
import { isTestPath } from "./algebra.js";
import { resolveSelector } from "./identity.js";
import type {
  Cell,
  Cid,
  Effect,
  Invariant,
  NodeSelector,
  Recipe,
  ReapplyOutcome,
  State
} from "./types.js";

/** path -> recomputed cell text. */
type Writes = ReadonlyMap<string, string>;

/** A resolved input Cell the engine may read. */
interface EngineInput {
  readonly path: string;
  readonly cell: Cell;
}

/** A validated, pure engine: given input Cells it returns the writes to apply. */
interface EngineRunner {
  run(inputs: ReadonlyArray<EngineInput>): Writes;
}

type HardFailureReason = Extract<ReapplyOutcome, { readonly kind: "HardFailure" }>["reason"];

/**
 * Advance one recipe-bearing change onto `newBase` by recomputing it (§3.2).
 *
 * Outcomes:
 * - `CleanReapply`: the rule ran hermetically, stayed in `writeScope`, passed the
 *   run-twice self-check and all invariants. `changedResult` reports whether the
 *   recomputed tree differs from `originalResultState` (which invalidates prior
 *   approvals upstream, §4.2).
 * - `Divergence`: an invariant or `expectedResultDigest` was violated; never
 *   auto-landed.
 * - `HardFailure`: nondeterministic recipe, invalid rule, vanished input, a write
 *   escaping `writeScope`, or a failed determinism self-check. The caller falls
 *   back to text 3-way.
 */
export function reapply(
  recipe: Recipe,
  originalResultState: State,
  newBase: State
): ReapplyOutcome {
  if (recipe.determinismClass === "nondeterministic") {
    return hardFailure(
      "nondeterministic",
      "recipe declares a nondeterministic determinism class; never reapplied"
    );
  }

  const engine = buildEngine(recipe);
  if (engine === undefined) {
    return hardFailure("engine_error", `invalid or unknown rule for engine "${recipe.engine}"`);
  }

  // Preconditions: every declared input must still resolve in the new base.
  const inputs = resolveInputs(recipe.inputSelector, newBase);
  if (inputs === undefined) {
    return hardFailure("precondition", "an inputSelector cell no longer resolves in newBase");
  }

  // Execute the rule hermetically against newBase (not against the old diff).
  const writes = engine.run(inputs);

  // writeScope enforcement: a write outside the declared scope hard-fails.
  const scope = writeScopePaths(recipe.writeScope, newBase);
  for (const path of writes.keys()) {
    if (!scope.has(path)) {
      return hardFailure("engine_error", `write escapes writeScope: ${path}`);
    }
  }

  const candidate = applyWrites(newBase, writes);
  const candidateAddress = stateAddress(candidate);

  // Determinism self-check: re-run the engine over the SAME input (newBase) and
  // require an identical result. This tests determinism (same input -> same
  // output) WITHOUT requiring idempotence: a codemod that adds an argument
  // (foo(x) -> foo(x, ctx)) is deterministic but is NOT a fixpoint of itself and
  // must remain reapply-able (§3.3). A pure engine always passes; this guards
  // future non-pure engines (clock/network/locale).
  const writesSecondRun = engine.run(inputs);
  const candidateSecondRun = applyWrites(newBase, writesSecondRun);
  if (stateAddress(candidateSecondRun) !== candidateAddress) {
    return hardFailure(
      "nondeterministic_engine",
      "engine produced a different result on a second run over the same input"
    );
  }

  // Invariant checks turn "clean" into "trustworthy" (§3.3).
  for (const invariant of recipe.invariants ?? []) {
    const report = checkInvariant(invariant, newBase, candidate);
    if (report !== undefined) {
      return {
        kind: "Divergence",
        expected: stateAddress(originalResultState),
        actual: candidateAddress,
        report
      };
    }
  }

  // The authored output shape, when pinned, must still match.
  if (
    recipe.expectedResultDigest !== undefined &&
    recipe.expectedResultDigest !== candidateAddress
  ) {
    return {
      kind: "Divergence",
      expected: asCid(recipe.expectedResultDigest),
      actual: candidateAddress,
      report: `expectedResultDigest ${recipe.expectedResultDigest} does not match recomputed ${candidateAddress}`
    };
  }

  return {
    kind: "CleanReapply",
    resultState: candidate,
    recomputed: true,
    changedResult: candidateAddress !== stateAddress(originalResultState)
  };
}

// ---- engines ---------------------------------------------------------------

function buildEngine(recipe: Recipe): EngineRunner | undefined {
  switch (recipe.engine) {
    case "regex-replace":
      return buildRegexReplace(recipe.rule);
    case "dep-bump":
      return buildDepBump(recipe.rule);
    default: {
      // Exhaustiveness guard over EngineId.
      const never: never = recipe.engine;
      void never;
      return undefined;
    }
  }
}

/**
 * `regex-replace`: apply a RegExp to each input cell's text. Rule shape is
 * `{ find: string; replace: string; flags?: string }`. A fresh RegExp is
 * compiled per application so no `lastIndex` state leaks between cells or runs.
 */
function buildRegexReplace(rule: Readonly<Record<string, unknown>>): EngineRunner | undefined {
  const find = readString(rule, "find");
  const replace = readString(rule, "replace");
  if (find === undefined || replace === undefined) {
    return undefined;
  }
  const flagsValue = rule["flags"];
  if (flagsValue !== undefined && typeof flagsValue !== "string") {
    return undefined;
  }
  const flags = typeof flagsValue === "string" ? flagsValue : undefined;

  // Reject uncompilable patterns/flags up front.
  try {
    compileRegExp(find, flags);
  } catch {
    return undefined;
  }

  return {
    run(inputs) {
      const writes = new Map<string, string>();
      for (const input of inputs) {
        const regex = compileRegExp(find, flags);
        const next = input.cell.text.replace(regex, replace);
        if (next !== input.cell.text) {
          writes.set(input.path, next);
        }
      }
      return writes;
    }
  };
}

/**
 * `dep-bump`: replace a pinned version string in manifest cells. Rule shape is
 * `{ name: string; from: string; to: string }`, matching `"name": "from"` with
 * flexible interior whitespace and rewriting only the version.
 */
function buildDepBump(rule: Readonly<Record<string, unknown>>): EngineRunner | undefined {
  const name = readString(rule, "name");
  const from = readString(rule, "from");
  const to = readString(rule, "to");
  if (name === undefined || from === undefined || to === undefined) {
    return undefined;
  }

  const source = `("${escapeRegExp(name)}"\\s*:\\s*")${escapeRegExp(from)}(")`;

  return {
    run(inputs) {
      const writes = new Map<string, string>();
      for (const input of inputs) {
        const regex = new RegExp(source, "g");
        // A replacer function avoids `$n` interpretation inside `to`.
        const next = input.cell.text.replace(
          regex,
          (_match, prefix: string, suffix: string) => `${prefix}${to}${suffix}`
        );
        if (next !== input.cell.text) {
          writes.set(input.path, next);
        }
      }
      return writes;
    }
  };
}

function compileRegExp(source: string, flags: string | undefined): RegExp {
  return flags === undefined ? new RegExp(source) : new RegExp(source, flags);
}

function readString(rule: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = rule[key];
  return typeof value === "string" ? value : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- state helpers ---------------------------------------------------------

function resolveInputs(
  selectors: ReadonlyArray<NodeSelector>,
  state: State
): ReadonlyArray<EngineInput> | undefined {
  const inputs: EngineInput[] = [];
  for (const selector of selectors) {
    const found = resolveSelector(state, selector);
    if (found === undefined) {
      return undefined;
    }
    inputs.push({ path: found.path, cell: found.cell });
  }
  return inputs;
}

function writeScopePaths(
  selectors: ReadonlyArray<NodeSelector>,
  state: State
): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const selector of selectors) {
    const found = resolveSelector(state, selector);
    if (found !== undefined) {
      paths.add(found.path);
    }
  }
  return paths;
}

function applyWrites(state: State, writes: Writes): State {
  const cells: Record<string, Cell> = { ...state.cells };
  for (const [path, text] of writes) {
    const existing = cells[path];
    if (existing === undefined) {
      continue;
    }
    cells[path] =
      existing.mode === undefined
        ? { facet: existing.facet, ident: existing.ident, text }
        : { facet: existing.facet, ident: existing.ident, text, mode: existing.mode };
  }
  return { kind: "state", cells };
}

// ---- invariants ------------------------------------------------------------

function checkInvariant(invariant: Invariant, before: State, candidate: State): string | undefined {
  switch (invariant.kind) {
    case "max_cells_written": {
      const changed = countChangedCells(before, candidate);
      if (changed > invariant.limit) {
        return `max_cells_written violated: ${changed} cells written, limit ${invariant.limit}`;
      }
      return undefined;
    }
    case "no_new_effect": {
      const effects = diffEffects(before, candidate);
      const offending = invariant.not.filter((effect) => effects.has(effect));
      if (offending.length > 0) {
        return `no_new_effect violated: recompute introduced ${offending.join(", ")}`;
      }
      return undefined;
    }
    case "path_unchanged": {
      const before1 = before.cells[invariant.path];
      const after1 = candidate.cells[invariant.path];
      const unchanged =
        (before1 === undefined && after1 === undefined) ||
        (before1 !== undefined &&
          after1 !== undefined &&
          cellAddress(before1) === cellAddress(after1));
      if (!unchanged) {
        return `path_unchanged violated: ${invariant.path} changed during recompute`;
      }
      return undefined;
    }
    default: {
      const never: never = invariant;
      return `unknown invariant ${JSON.stringify(never)}`;
    }
  }
}

function countChangedCells(before: State, after: State): number {
  let count = 0;
  const afterPaths = new Set<string>();
  for (const [path, afterCell] of Object.entries(after.cells)) {
    afterPaths.add(path);
    const beforeCell = before.cells[path];
    if (beforeCell === undefined || cellAddress(afterCell) !== cellAddress(beforeCell)) {
      count++;
    }
  }
  for (const path of Object.keys(before.cells)) {
    if (!afterPaths.has(path)) {
      count++;
    }
  }
  return count;
}

function diffEffects(before: State, after: State): ReadonlySet<Effect> {
  const effects = new Set<Effect>();
  const afterPaths = new Set(Object.keys(after.cells));

  for (const [path, afterCell] of Object.entries(after.cells)) {
    const beforeCell = before.cells[path];
    if (beforeCell === undefined) {
      effects.add("edits_source");
    } else if (cellAddress(afterCell) !== cellAddress(beforeCell)) {
      effects.add("edits_source");
      if (isTestPath(path)) {
        effects.add("skips_test");
      }
    }
  }

  for (const path of Object.keys(before.cells)) {
    if (!afterPaths.has(path)) {
      effects.add("deletes_source");
      if (isTestPath(path)) {
        effects.add("deletes_test");
      }
    }
  }

  return effects;
}

// ---- small utilities -------------------------------------------------------

function hardFailure(reason: HardFailureReason, detail: string): ReapplyOutcome {
  return { kind: "HardFailure", reason, detail };
}

/** The expectedResultDigest pins a State address, so treat it as a Cid. */
function asCid(digest: string): Cid {
  return digest as Cid;
}
