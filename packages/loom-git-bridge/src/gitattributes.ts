/**
 * @agentforge/loom-git-bridge — `.gitattributes` text/binary support
 * (Phase 1 Git fidelity).
 *
 * A `.gitattributes` file can mark paths as `text` (force text) or `-text`
 * (force binary). This module parses the file and lets the importer override
 * auto-detection: a path marked `-text` is always treated as a binary bytes
 * Cell, and a path marked `text` is always treated as a text Cell.
 */

export interface GitAttributes {
  readonly textPaths: string[];
  readonly binaryPaths: string[];
}

/** Parse `.gitattributes` content into text and binary path patterns. */
export function parseGitAttributes(content: string): GitAttributes {
  const textPaths: string[] = [];
  const binaryPaths: string[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    // A line is `pattern attr1 attr2 ...`. We only care about text / -text.
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
  }
  return { textPaths, binaryPaths };
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
