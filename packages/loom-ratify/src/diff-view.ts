import type { ChangedFile } from "@agentforge/core";
import { deriveIdentityIndex, type NodeIdent, type State } from "@agentforge/loom-core";

/**
 * Reconstruct a git-`ChangedFile`-shaped diff view from two Loom {@link State}s.
 *
 * This is the re-homing bridge (design docs/loom/loom-detailed-design.md §5): it
 * lets the EXISTING `@agentforge/detectors` (which parse `filename`/`status`/
 * `patch`/content) run unchanged over Loom Transforms — the authoritative TEXT
 * lane, no detector rewrite. Rename detection is EXACT (by stable `NodeIdent`),
 * not heuristic, which is Loom's advantage over git's guessed renames.
 */
export function fabricDiffView(base: State, result: State): ChangedFile[] {
  const baseIndex = deriveIdentityIndex(base);
  const resultIndex = deriveIdentityIndex(result);

  const idents = new Set<NodeIdent>([...baseIndex.keys(), ...resultIndex.keys()]);
  const files: ChangedFile[] = [];

  for (const ident of idents) {
    const basePath = baseIndex.get(ident);
    const resultPath = resultIndex.get(ident);
    const baseText = basePath === undefined ? undefined : base.cells[basePath]?.text;
    const resultText = resultPath === undefined ? undefined : result.cells[resultPath]?.text;

    if (
      basePath !== undefined &&
      baseText !== undefined &&
      (resultPath === undefined || resultText === undefined)
    ) {
      // Present in base only -> removed.
      files.push({
        filename: basePath,
        status: "removed",
        deletions: lineCount(baseText),
        patch: fullPatch(basePath, baseText, "-"),
        previousContent: baseText
      });
      continue;
    }

    if (
      resultPath !== undefined &&
      resultText !== undefined &&
      (basePath === undefined || baseText === undefined)
    ) {
      // Present in result only -> added.
      files.push({
        filename: resultPath,
        status: "added",
        additions: lineCount(resultText),
        patch: fullPatch(resultPath, resultText, "+"),
        currentContent: resultText
      });
      continue;
    }

    if (
      basePath === undefined ||
      resultPath === undefined ||
      baseText === undefined ||
      resultText === undefined
    ) {
      continue; // unreachable given the guards above, but keeps the type-checker happy
    }

    const pathChanged = basePath !== resultPath;
    const contentChanged = baseText !== resultText;
    if (!pathChanged && !contentChanged) {
      continue; // unchanged
    }

    const { patch, additions, deletions } = unifiedDiff(resultPath, baseText, resultText);
    if (pathChanged) {
      files.push({
        filename: resultPath,
        status: "renamed",
        previousFilename: basePath,
        additions,
        deletions,
        patch,
        previousContent: baseText,
        currentContent: resultText
      });
    } else {
      files.push({
        filename: resultPath,
        status: "modified",
        additions,
        deletions,
        patch,
        previousContent: baseText,
        currentContent: resultText
      });
    }
  }

  files.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return files;
}

function lineCount(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

function toLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

/** A full add/remove patch (every line prefixed with `+` or `-`). */
function fullPatch(filename: string, text: string, sign: "+" | "-"): string {
  const lines = toLines(text);
  const header =
    sign === "+"
      ? `--- /dev/null\n+++ b/${filename}\n@@ -0,0 +1,${lines.length} @@`
      : `--- a/${filename}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@`;
  const body = lines.map((line) => `${sign}${line}`).join("\n");
  return `${header}\n${body}`;
}

/**
 * A minimal 2-way unified diff: trim the common prefix/suffix and emit the
 * changed middle as `-old`/`+new`. Sufficient for the detectors, which key off
 * `+`/`-` lines and the `@@` hunk header.
 */
function unifiedDiff(
  filename: string,
  oldText: string,
  newText: string
): { patch: string; additions: number; deletions: number } {
  const oldLines = toLines(oldText);
  const newLines = toLines(newText);

  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);

  const hunkOldStart = prefix + 1;
  const hunkNewStart = prefix + 1;
  const header = `--- a/${filename}\n+++ b/${filename}\n@@ -${hunkOldStart},${removed.length} +${hunkNewStart},${added.length} @@`;
  const body = [...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)].join(
    "\n"
  );

  return {
    patch: body === "" ? header : `${header}\n${body}`,
    additions: added.length,
    deletions: removed.length
  };
}
