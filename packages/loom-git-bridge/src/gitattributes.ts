
/**
 * @agentforge/loom-git-bridge — `.gitattributes` text/binary/filter support
 * (Phase 1 Git fidelity, item #5).
 *
 * A `.gitattributes` file can mark paths as `text` (force text), `-text`
 * (force binary), or `filter=<name>` (route through a clean/smudge filter).
 * This module parses the file and lets the importer override auto-detection:
 * a path marked `-text` is always treated as a binary bytes Cell, a path
 * marked `text` is always treated as a text Cell, and a path marked with a
 * `filter` is reported as unsupported (Loom cannot run arbitrary git
 * clean/smudge commands, so it preserves the raw bytes and flags the filter).
 */

export interface GitAttributes {
  readonly textPaths: string[];
  readonly binaryPaths: string[];
  /** Patterns that declare a `filter=<name>` attribute (pattern -> filter). */
  readonly filterPaths: ReadonlyArray<{ readonly pattern: string; readonly filter: string }>;
}

/** Parse `.gitattributes` content into text, binary, and filter patterns. */
export function parseGitAttributes(content: string): GitAttributes {
  const textPaths: string[] = [];
  const binaryPaths: string[] = [];
  const filterPaths: Array<{ pattern: string; filter: string }> = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    // A line is `pattern attr1 attr2 ...`. We care about text, -text, and filter.
    const parts = line.split(/\s+/);
    const pattern = parts[0];
    if (pattern === undefined) {
      continue;
    }
    const attributes = parts.slice(1);
    if (attributes.includes("text")) {
      textPaths.push(pattern);
    } else if (attributes.includes("-text")) {
      binaryPaths.push(pattern);
    }
    for (const attr of attributes) {
      if (attr.startsWith("filter=")) {
        filterPaths.push({ pattern, filter: attr.slice("filter=".length) });
      } else if (attr === "filter") {
        // Bare `filter` (empty value) still marks the path as filtered.
        filterPaths.push({ pattern, filter: "" });
      }
    }
  }
  return { textPaths, binaryPaths, filterPaths };
}

/** The filter name declared for a path, or undefined if none. */
export function filterForPath(attributes: GitAttributes, path: string): string | undefined {
  for (const { pattern, filter } of attributes.filterPaths) {
    if (matchesGitAttributePattern(pattern, path)) {
      return filter;
    }
  }
  return undefined;
}

/** Match a path against a gitignore-style pattern (simplified glob). */
export function matchesGitAttributePattern(pattern: string, path: string): boolean {
  if (pattern.endsWith("/")) {
    // Directory prefix pattern (e.g. "docs/" matches anything under docs).
    return path.startsWith(pattern);
  }
  if (pattern.includes("*")) {
    const regex = new RegExp(
      `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`
    );
    return regex.test(path);
  }
  return path === pattern || path.startsWith(pattern + "/");
}

/** Decide the facet for a path given parsed attributes; undefined = auto-detect. */
export function facetFromAttributes(
  attributes: GitAttributes,
  path: string
): "text" | "bytes" | undefined {
  const isText = attributes.textPaths.some((pattern) => matchesGitAttributePattern(pattern, path));
  if (isText) {
    return "text";
  }
  const isBinary = attributes.binaryPaths.some((pattern) => matchesGitAttributePattern(pattern, path));
  if (isBinary) {
    return "bytes";
  }
  return undefined;
}
