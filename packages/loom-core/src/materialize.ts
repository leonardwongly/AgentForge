/**
 * @agentforge/loom-core — working-copy materialization and change journal
 * (Phase 1, spec §10).
 *
 * A Loom State is materialized to a filesystem working copy (each Cell's text
 * written to its path), and a working copy can be captured back into a State.
 * The change journal reports which paths were added, modified, or removed
 * relative to a base State, so a change session can be re-captured as a
 * Transform. Paths are validated to prevent traversal outside the target.
 */

import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { sha256Hex } from "./addressing.js";
import type { Cell, NodeIdent, State } from "./types.js";

/** Validate a Loom path for safe materialization; returns an error or undefined. */
export function validateMaterializePath(path: string): string | undefined {
  if (path === "") {
    return "path must not be empty";
  }
  if (path.includes("\u0000")) {
    return "path must not contain NUL";
  }
  if (path.startsWith("/") || path.includes("\\")) {
    return "path must be a relative, forward-slash path";
  }
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      return `path segment "${segment}" is not allowed`;
    }
  }
  return undefined;
}

/** Materialize a State into `targetDir`, writing each Cell's text to its path. */
export function materializeState(state: State, targetDir: string): void {
  const root = resolve(targetDir);
  for (const [path, cell] of Object.entries(state.cells)) {
    const error = validateMaterializePath(path);
    if (error !== undefined) {
      throw new Error(`loom: cannot materialize path "${path}": ${error}`);
    }
    const target = resolve(join(root, path));
    if (!target.startsWith(root + sep)) {
      throw new Error(`loom: path escapes working copy: ${path}`);
    }
    ensureSafeParentDirectories(root, dirname(target));
    const fd = openSync(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600
    );
    try {
      writeFileSync(fd, cell.text, "utf8");
    } finally {
      closeSync(fd);
    }
  }
}

/** Reject symlink components before writing into a caller-controlled tree. */
function ensureSafeParentDirectories(root: string, parent: string): void {
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`loom: refusing to use symlink/non-directory root ${root}`);
  }
  const relativeParent = relative(root, parent);
  let current = root;
  for (const segment of relativeParent.split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`loom: refusing to traverse symlink/non-directory ${current}`);
      }
    } catch (error) {
      if (isMissing(error)) {
        mkdirSync(current);
        continue;
      }
      throw error;
    }
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Capture a working copy directory into a State (each file becomes a Cell). */
export function captureState(
  targetDir: string,
  identFor: (path: string) => NodeIdent = (path) =>
    `nid:${sha256Hex(path).slice(0, 32)}` as NodeIdent,
  exclude?: ReadonlySet<string>
): State {
  const cells: Record<string, Cell> = {};
  const root = resolve(targetDir);
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      const rel = relative(root, absolute).split(sep).join("/");
      if (
        exclude &&
        [...exclude].some((prefix) => rel === prefix || rel.startsWith(prefix + "/"))
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        cells[rel] = {
          facet: "text",
          ident: identFor(rel),
          text: readFileSync(absolute, "utf8")
        };
      }
    }
  };
  walk(root);
  return { kind: "state", cells };
}

export interface ChangeJournal {
  readonly added: string[];
  readonly modified: string[];
  readonly removed: string[];
}

/** Diff a working copy against a base State to produce a change journal. */
export function diffWorkingCopy(
  targetDir: string,
  baseState: State,
  exclude?: ReadonlySet<string>
): ChangeJournal {
  const current = captureState(targetDir, undefined, exclude);
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  for (const path of Object.keys(current.cells)) {
    const base = baseState.cells[path];
    if (base === undefined) {
      added.push(path);
    } else if (base.text !== current.cells[path]!.text) {
      modified.push(path);
    }
  }
  for (const path of Object.keys(baseState.cells)) {
    if (current.cells[path] === undefined) {
      removed.push(path);
    }
  }
  return { added, modified, removed };
}
