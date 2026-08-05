/**
 * @agentforge/loom-core — bounded invariant DSL and frozen effect-fingerprint
 * schema (spec §23 item 5, design §3.2/§3.3).
 *
 * The invariant DSL is versioned and bounded: only the known invariant kinds
 * and effect vocabulary are accepted, and numeric limits are range-checked, so
 * a malformed or hostile recipe cannot express an unbounded or unknown
 * post-condition. The effect vocabulary is a frozen, versioned set; adding an
 * effect is a schema bump, not an ad-hoc extension.
 */

import { createHash } from "node:crypto";

import type { Effect, Invariant } from "./types.js";

export const INVARIANT_DSL_VERSION = 1;
export const EFFECT_FINGERPRINT_SCHEMA_VERSION = 1;

/** Upper bound on a `max_cells_written` limit (bounded DSL). */
export const MAX_CELLS_WRITTEN_LIMIT = 100_000;

/** The frozen, versioned effect vocabulary (design §3.2). */
export const EFFECT_VOCABULARY: readonly Effect[] = [
  "edits_source",
  "deletes_source",
  "moves_cell",
  "adds_dependency",
  "bumps_dependency_major",
  "bumps_dependency_minor",
  "removes_dependency",
  "adds_migration",
  "deletes_migration",
  "deletes_test",
  "skips_test",
  "changes_ci",
  "touches_sensitive_path",
  "adds_secret_like_value",
  "adds_generated_artifact"
] as const;

const EFFECT_SET: ReadonlySet<string> = new Set(EFFECT_VOCABULARY);

// ---- effect fingerprint ------------------------------------------------------

export interface EffectFingerprint {
  readonly version: number;
  /** Sorted, deduplicated effects. */
  readonly effects: readonly Effect[];
}

/** Canonical, versioned fingerprint of a set of effects (sorted + deduped). */
export function effectFingerprint(effects: Iterable<Effect>): EffectFingerprint {
  const unique = new Set<Effect>();
  for (const effect of effects) {
    if (!EFFECT_SET.has(effect)) {
      throw new Error(`loom: unknown effect "${effect}" in fingerprint`);
    }
    unique.add(effect);
  }
  return {
    version: EFFECT_FINGERPRINT_SCHEMA_VERSION,
    effects: [...unique].sort()
  };
}

/** Deterministic digest of an effect fingerprint (domain-separated). */
export function effectFingerprintDigest(effects: Iterable<Effect>): string {
  const fp = effectFingerprint(effects);
  const canonical = `${fp.version}:${fp.effects.join(",")}`;
  return createHash("sha256").update(`loom-effects-v1|${canonical}`).digest("hex");
}

// ---- bounded invariant DSL --------------------------------------------------

const KNOWN_KINDS = new Set(["max_cells_written", "no_new_effect", "path_unchanged"]);

/**
 * Parse a versioned invariant DSL string into `Invariant` objects.
 * Grammar (v1): clauses separated by `;`, each `kind=value`:
 *   max_cells_written=<positive int>
 *   no_new_effect=<effect>[,<effect>...]
 *   path_unchanged=<non-empty path>
 * Unknown kinds, unknown effects, malformed values, and out-of-range limits are
 * rejected.
 */
export function parseInvariantDsl(input: string): Invariant[] {
  if (input.trim() === "") {
    return [];
  }
  const invariants: Invariant[] = [];
  for (const rawClause of input.split(";")) {
    const clause = rawClause.trim();
    if (clause === "") {
      continue;
    }
    const eq = clause.indexOf("=");
    if (eq === -1) {
      throw new Error(`loom: invariant clause "${clause}" is missing "="`);
    }
    const kind = clause.slice(0, eq).trim();
    const value = clause.slice(eq + 1).trim();
    if (!KNOWN_KINDS.has(kind)) {
      throw new Error(`loom: unknown invariant kind "${kind}"`);
    }
    invariants.push(parseClause(kind, value));
  }
  return invariants;
}

function parseClause(kind: string, value: string): Invariant {
  if (kind === "max_cells_written") {
    if (!/^[0-9]+$/u.test(value)) {
      throw new Error(`loom: max_cells_written requires a non-negative integer, got "${value}"`);
    }
    const limit = Number(value);
    if (limit > MAX_CELLS_WRITTEN_LIMIT) {
      throw new Error(
        `loom: max_cells_written limit ${limit} exceeds bound ${MAX_CELLS_WRITTEN_LIMIT}`
      );
    }
    return { kind: "max_cells_written", limit };
  }
  if (kind === "no_new_effect") {
    const names = value === "" ? [] : value.split(",").map((name) => name.trim());
    if (names.length === 0) {
      throw new Error("loom: no_new_effect requires at least one effect");
    }
    for (const name of names) {
      if (!EFFECT_SET.has(name)) {
        throw new Error(`loom: unknown effect "${name}" in no_new_effect`);
      }
    }
    return { kind: "no_new_effect", not: [...new Set(names)] as Effect[] };
  }
  // path_unchanged
  if (value === "") {
    throw new Error("loom: path_unchanged requires a non-empty path");
  }
  return { kind: "path_unchanged", path: value };
}

/** Validate a decoded Invariant object; returns an error string or undefined. */
export function validateInvariant(invariant: Invariant): string | undefined {
  switch (invariant.kind) {
    case "max_cells_written":
      if (!Number.isInteger(invariant.limit) || invariant.limit < 0) {
        return "max_cells_written limit must be a non-negative integer";
      }
      if (invariant.limit > MAX_CELLS_WRITTEN_LIMIT) {
        return `max_cells_written limit exceeds bound ${MAX_CELLS_WRITTEN_LIMIT}`;
      }
      return undefined;
    case "no_new_effect":
      if (invariant.not.length === 0) {
        return "no_new_effect requires at least one effect";
      }
      for (const effect of invariant.not) {
        if (!EFFECT_SET.has(effect)) {
          return `unknown effect "${effect}"`;
        }
      }
      return undefined;
    case "path_unchanged":
      return invariant.path === "" ? "path_unchanged requires a non-empty path" : undefined;
  }
}
