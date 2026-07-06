/**
 * @agentforge/loom-git-bridge — git → Loom {@link State} building.
 *
 * The pure state-building logic sits behind the {@link GitReader} port so it is
 * unit-testable with a fake reader (no real repo); {@link execGitReader} is the
 * real, shell-free implementation over the `git` CLI via node:child_process.
 *
 * Identity is path-derived (see {@link nodeIdentForPath}): git has no intrinsic
 * node identity, so a stable path keeps a stable NodeIdent across refs (a
 * downstream diff then reads a content change as "modified"), while a different
 * path yields a different ident (delete+add, matching git's default).
 */
import { execFileSync } from "node:child_process";
import { sha256Hex, type Cell, type NodeIdent, type State } from "@agentforge/loom-core";
import type { GitReader, GitTreeEntry, TransformStates } from "./types.js";

/** Upper bound for captured git stdout (bytes); large enough for big blobs/trees. */
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Deterministically derive a Cell's stable identity from its path. The same
 * path always maps to the same ident (enabling "modified" detection across
 * refs); distinct paths map to distinct idents (delete+add).
 */
export function nodeIdentForPath(path: string): NodeIdent {
  return ("nid:" + sha256Hex(path).slice(0, 32)) as NodeIdent;
}

/**
 * Build a Loom {@link State} from a single git ref. Only blob entries become
 * Cells; tree entries are skipped. `mode` is intentionally omitted (optional
 * under exactOptionalPropertyTypes) to keep the v1 Cell minimal.
 */
export async function stateFromGitRef(reader: GitReader, ref: string): Promise<State> {
  const entries = await reader.lsTree(ref);
  const cells: Record<string, Cell> = {};
  for (const entry of entries) {
    if (entry.type !== "blob") {
      continue;
    }
    const text = await reader.readFile(ref, entry.path);
    cells[entry.path] = {
      facet: "text",
      ident: nodeIdentForPath(entry.path),
      text
    };
  }
  return { kind: "state", cells };
}

/** Build the {base, result} state pair the Loom ratify path consumes. */
export async function transformSetFromGit(
  reader: GitReader,
  baseRef: string,
  headRef: string
): Promise<TransformStates> {
  return {
    base: await stateFromGitRef(reader, baseRef),
    result: await stateFromGitRef(reader, headRef)
  };
}

/**
 * Real {@link GitReader} over the `git` CLI. Uses execFileSync with an argument
 * array (never a shell string), so refs/paths can never be interpreted by a
 * shell. The async signatures are honoured by wrapping synchronous output in a
 * resolved Promise.
 */
export function execGitReader(repoDir: string): GitReader {
  function runGit(args: ReadonlyArray<string>): string {
    try {
      return execFileSync("git", ["-C", repoDir, ...args], {
        encoding: "utf8",
        maxBuffer: GIT_MAX_BUFFER
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`loom-git-bridge: \`git ${args.join(" ")}\` failed: ${detail}`);
    }
  }

  return {
    lsTree(ref: string): Promise<ReadonlyArray<GitTreeEntry>> {
      const output = runGit(["ls-tree", "-r", ref]);
      const entries: GitTreeEntry[] = [];
      for (const line of output.split("\n")) {
        if (line.length === 0) {
          continue;
        }
        // Default format: "<mode> <type> <sha>\t<path>". Split once at the TAB
        // so paths that contain spaces stay intact.
        const tabIndex = line.indexOf("\t");
        if (tabIndex === -1) {
          continue;
        }
        const meta = line.slice(0, tabIndex);
        const path = line.slice(tabIndex + 1);
        const metaParts = meta.split(" ");
        const mode = metaParts[0];
        const type = metaParts[1];
        if (mode === undefined || type === undefined) {
          continue;
        }
        entries.push({ path, mode, type: type === "blob" ? "blob" : "tree" });
      }
      return Promise.resolve(entries);
    },
    readFile(ref: string, path: string): Promise<string> {
      return Promise.resolve(runGit(["show", `${ref}:${path}`]));
    }
  };
}
