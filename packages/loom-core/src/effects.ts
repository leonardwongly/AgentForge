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

/**
 * Sensitive paths are matched by normalized path components, not a permissive
 * substring regex. The previous expression required a trailing slash after
 * `.env`, so a directly modified `.env` file was classified as ordinary source
 * and could bypass the security-review effect.
 */
function isSensitivePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  const segments = normalized.split("/").filter(Boolean);
  return (
    segments.includes(".env") ||
    segments.some(
      (segment, index) =>
        (segment === "src" &&
          (segments[index + 1] === "billing" || segments[index + 1] === "payments")) ||
        (segment === "config" && segments[index + 1]?.startsWith("secrets"))
    )
  );
}

/** The effect(s) implied by a single changed path. */
export function effectsForPath(path: string, kind: "added" | "modified" | "removed"): Effect[] {
  const normalizedPath = path.replaceAll("\\", "/");
  if (kind === "removed") {
    return [isTestPath(normalizedPath) ? "deletes_test" : "deletes_source"];
  }
  if (isTestPath(normalizedPath)) {
    return ["skips_test"];
  }
  if (CI_PATH.test(normalizedPath)) {
    return ["changes_ci"];
  }
  if (isSensitivePath(normalizedPath)) {
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
