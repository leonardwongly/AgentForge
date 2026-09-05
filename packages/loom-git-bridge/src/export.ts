/**
 * @agentforge/loom-git-bridge — Loom → git export and mirroring (Phase 1,
 * design §19.2, item #1).
 *
 * Export materializes the exact authoritative bytes and supported modes of a
 * Loom {@link State} into a git working copy and, optionally, commits it as a
 * git commit. The git commit is a projection — it is not the authoritative Loom
 * Transform. Every loss, omission, normalization, or unsupported object is
 * reported so a mirror can stop automatic cutover on divergence (LOOM-GIT-005).
 *
 * The pure {@link stateToGitWorkingCopy} is unit-testable without a real repo;
 * {@link exportStateToGit} layers the `git` CLI on top.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { validateMaterializePath, type State } from "@agentforge/loom-core";

/** A reported export loss, omission, or unsupported object. */
export interface ExportLoss {
  readonly path: string;
  readonly reason: string;
}

/** The result of materializing a State to a git working copy. */
export interface ExportReport {
  readonly written: number;
  readonly losses: ReadonlyArray<ExportLoss>;
}

/**
 * Materialize a Loom {@link State} into `targetDir` as a git working copy.
 * Text Cells are written as UTF-8; bytes Cells are decoded from base64; POSIX
 * mode bits are applied when present. Unsafe paths and mode failures are
 * reported as losses rather than silently dropped.
 */
export function stateToGitWorkingCopy(state: State, targetDir: string): ExportReport {
  const root = resolve(targetDir);
  const losses: ExportLoss[] = [];
  let written = 0;

  for (const [path, cell] of Object.entries(state.cells)) {
    const error = validateMaterializePath(path);
    if (error !== undefined) {
      losses.push({ path, reason: error });
      continue;
    }
    if (path === ".git" || path.startsWith(".git/")) {
      losses.push({ path, reason: "refusing to materialize Git metadata or hooks" });
      continue;
    }
    const target = resolve(join(root, path));
    if (!target.startsWith(root + sep)) {
      losses.push({ path, reason: "path escapes the working copy" });
      continue;
    }
    try {
      // Decode before opening the target. Buffer.from's permissive base64
      // behavior must not leave a newly-created empty file (or truncate an
      // existing file) when an untrusted bytes cell is malformed.
      const bytes = cell.facet === "bytes" ? decodeBase64(cell.text) : undefined;
      ensureSafeParentDirectories(root, dirname(target));
      const fd = openSync(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o600
      );
      try {
        if (bytes !== undefined) {
          writeFileSync(fd, bytes);
        } else {
          writeFileSync(fd, cell.text, "utf8");
        }
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      losses.push({ path, reason: error instanceof Error ? error.message : "unsafe target path" });
      continue;
    }
    if (cell.mode !== undefined) {
      const mode = normalizeMode(cell.mode);
      if (mode === undefined) {
        losses.push({ path, reason: `cannot set mode ${cell.mode}` });
      } else {
        try {
          chmodSync(target, mode);
        } catch {
          losses.push({ path, reason: `cannot set mode ${cell.mode}` });
        }
      }
    }
    written += 1;
  }
  return { written, losses };
}

/** Decode bytes cells without Buffer's permissive invalid-character handling. */
function decodeBase64(value: string): Buffer {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw new Error("bytes cell is not valid base64");
  }
  return Buffer.from(value, "base64");
}

/** Keep only permission bits from a regular-file POSIX mode. */
function normalizeMode(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return undefined;
  }
  // Accept regular-file type bits (e.g. Git's 100644) and permission/special
  // bits, but never silently coerce directory, symlink, or arbitrary flags.
  if ((value & ~0o107777) !== 0) {
    return undefined;
  }
  return value & 0o7777;
}

function ensureSafeParentDirectories(root: string, parent: string): void {
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("target root is a symlink or non-directory");
  }
  let current = root;
  const relativeParent = resolve(parent).slice(root.length).split(sep).filter(Boolean);
  for (const segment of relativeParent) {
    current = join(current, segment);
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`refusing to traverse symlink/non-directory ${current}`);
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        mkdirSync(current);
        continue;
      }
      throw error;
    }
  }
}

/** Options for {@link exportStateToGit}. */
export interface ExportToGitOptions {
  /** Commit message for the mirror commit. */
  readonly message: string;
  /** Optional git author (`Name <email>`); defaults to a neutral mirror identity. */
  readonly author?: string;
  /** Optional committer (`Name <email>`); defaults to `author`. */
  readonly committer?: string;
}

/** The result of exporting a State to a git repository as a commit. */
export interface ExportToGitResult {
  readonly commitOid: string;
  readonly written: number;
  readonly losses: ReadonlyArray<ExportLoss>;
}

function runGit(repoDir: string, args: ReadonlyArray<string>): Buffer {
  try {
    return execFileSync("git", ["-C", repoDir, ...args], { stdio: "pipe" });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`loom-git-bridge: \`git ${args.join(" ")}\` failed: ${detail}`);
  }
}

/**
 * Export a Loom {@link State} to a git repository as a commit: materialize the
 * working copy, stage all changes, and commit. The returned commit OID is a
 * projection of the State; the State's own address remains authoritative.
 */
export function exportStateToGit(
  state: State,
  repoDir: string,
  options: ExportToGitOptions
): ExportToGitResult {
  const report = stateToGitWorkingCopy(state, repoDir);
  runGit(repoDir, ["add", "--all"]);
  const author = options.author ?? "Loom Mirror <loom-mirror@example.invalid>";
  const committer = options.committer ?? author;
  runGit(repoDir, [
    "-c",
    `user.name=${author.split("<")[0]?.trim() ?? "Loom Mirror"}`,
    "-c",
    `user.email=${author.match(/<([^>]+)>/)?.[1] ?? "loom-mirror@example.invalid"}`,
    "-c",
    `committer.name=${committer.split("<")[0]?.trim() ?? "Loom Mirror"}`,
    "-c",
    `committer.email=${committer.match(/<([^>]+)>/)?.[1] ?? "loom-mirror@example.invalid"}`,
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "--no-gpg-sign",
    "--message",
    options.message
  ]);
  const oid = runGit(repoDir, ["rev-parse", "HEAD"]).toString().trim();
  return { commitOid: oid, written: report.written, losses: report.losses };
}
