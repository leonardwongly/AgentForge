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
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
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
    const target = resolve(join(root, path));
    if (!target.startsWith(root + sep)) {
      losses.push({ path, reason: "path escapes the working copy" });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    if (cell.facet === "bytes") {
      writeFileSync(target, Buffer.from(cell.text, "base64"));
    } else {
      writeFileSync(target, cell.text, "utf8");
    }
    if (cell.mode !== undefined) {
      try {
        chmodSync(target, cell.mode);
      } catch {
        losses.push({ path, reason: `cannot set mode ${cell.mode}` });
      }
    }
    written += 1;
  }
  return { written, losses };
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
    "commit",
    "--quiet",
    "--no-gpg-sign",
    "--message",
    options.message
  ]);
  const oid = runGit(repoDir, ["rev-parse", "HEAD"]).toString().trim();
  return { commitOid: oid, written: report.written, losses: report.losses };
}
