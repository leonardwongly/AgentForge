/**
 * @agentforge/loom-core — effect capture (Phase 3, spec §10.2/§13.2).
 *
 * Captures the Loom effect vocabulary from a change journal (the paths an agent
 * or session actually changed), so a change session's consequences are declared
 * as versioned effects rather than re-inferred later. Path heuristics classify
 * test, CI, and sensitive-path changes; everything else is a source edit.
 */

import { isTestPath } from "./algebra.js";
import type { ChangeJournal } from "./materialize.js";
import type { Effect } from "./types.js";

const CI_PATH = /(^|\/)\.github\/workflows\/|(^|\/)\.gitlab-ci\.yml$|(^|\/)\.circleci\//iu;
const SENSITIVE_PATH = /(^|\/)(?:src\/billing|src\/payments|config\/secrets|\.env)\//iu;

/** The effect(s) implied by a single changed path. */
export function effectsForPath(path: string, kind: "added" | "modified" | "removed"): Effect[] {
  if (kind === "removed") {
    return [isTestPath(path) ? "deletes_test" : "deletes_source"];
  }
  if (isTestPath(path)) {
    return ["skips_test"];
  }
  if (CI_PATH.test(path)) {
    return ["changes_ci"];
  }
  if (SENSITIVE_PATH.test(path)) {
    return ["touches_sensitive_path"];
  }
  return ["edits_source"];
}

/** Derive the full effect set from a change journal. */
export function effectsFromChangeJournal(journal: ChangeJournal): Effect[] {
  const effects = new Set<Effect>();
  for (const path of journal.removed) {
    for (const effect of effectsForPath(path, "removed")) {
      effects.add(effect);
    }
  }
  for (const path of journal.added) {
    for (const effect of effectsForPath(path, "added")) {
      effects.add(effect);
    }
  }
  for (const path of journal.modified) {
    for (const effect of effectsForPath(path, "modified")) {
      effects.add(effect);
    }
  }
  return [...effects];
}
