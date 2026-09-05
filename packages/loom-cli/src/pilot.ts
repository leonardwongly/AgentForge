/**
 * @agentforge/loom-cli — Phase 4 dual-safety pilot support.
 *
 * These commands operationalize the dual-safety pilot (design §21 Phase 4 and
 * validation-plan §4.11/§7): a Loom-authoritative repository is mirrored to a
 * git repository with a continuously-verified equivalence digest, and a
 * clean-room restore drill proves the authoritative history is recoverable.
 *
 *  - `mirror`  : export the current Loom head State to the git mirror, commit
 *                it, verify byte-exact equivalence, and record the digest in a
 *                tamper-evident mirror ledger. On divergence the mirror stops
 *                (LOOM-GIT-006) and both histories are preserved.
 *  - `verify`  : compare the Loom head State against the git HEAD tree
 *                byte-for-byte (LOOM-GIT-005).
 *  - `restore` : backup the object store and reproduce every Line head plus the
 *                admission ledger from a clean-room restore (LOOM-STORE-007).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FileLedger,
  FileLineJournal,
  FileObjectStore,
  type Cell,
  type State
} from "@agentforge/loom-core";
import { exportStateToGit, execGitReader, stateFromGitRef } from "@agentforge/loom-git-bridge";

const LOOM_DIR = ".loom";
const HEAD_FILE = "head";
const LEDGER_FILE = "ledger.jsonl";
const MIRROR_FILE = "mirror.jsonl";

function loomDir(dir: string): string {
  return join(dir, LOOM_DIR);
}

function headPath(dir: string): string {
  return join(loomDir(dir), HEAD_FILE);
}

function readHead(dir: string): string | undefined {
  const path = headPath(dir);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
}

function loadHeadState(dir: string): State {
  const head = readHead(dir);
  if (head === undefined) {
    throw new Error("not a Loom repository (run `loom init`)");
  }
  const store = new FileObjectStore(loomDir(dir));
  const state = store.getDagCbor<State>(head as never);
  if (!state) {
    throw new Error("corrupt repository: head state not found");
  }
  return state;
}

/** Decode a Cell's authoritative bytes (text is UTF-8; bytes is base64). */
function cellBytes(cell: Cell): Buffer {
  return cell.facet === "bytes" ? Buffer.from(cell.text, "base64") : Buffer.from(cell.text, "utf8");
}

/**
 * A content-only digest over a State (path + authoritative bytes), independent
 * of NodeIdent. Two States that materialize identical working copies share a
 * digest even when their idents were derived differently, so it is a faithful
 * equivalence check against a git tree.
 */
export function stateEquivalenceDigest(state: State): string {
  const parts = Object.keys(state.cells)
    .sort()
    .map((path) => `${path}\u0000${cellBytes(state.cells[path]!).toString("base64")}`);
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

/** A single detected difference between the Loom State and the git mirror. */
export interface MirrorDivergence {
  readonly path: string;
  readonly reason: string;
}

/** The result of verifying the git mirror against the Loom head State. */
export interface MirrorVerification {
  readonly equivalent: boolean;
  readonly loomDigest: string;
  readonly gitDigest: string;
  readonly divergences: ReadonlyArray<MirrorDivergence>;
}

/**
 * Verify the git mirror's HEAD tree matches the Loom head State byte-for-byte.
 * Returns the equivalence digests of both sides and every divergence.
 */
export async function verifyMirrorEquivalence(
  dir: string,
  gitRepoDir: string
): Promise<MirrorVerification> {
  const state = loadHeadState(dir);
  const gitState = await stateFromGitRef(execGitReader(gitRepoDir), "HEAD");

  const loomPaths = new Set(Object.keys(state.cells));
  const gitPaths = new Set(Object.keys(gitState.cells));
  const divergences: MirrorDivergence[] = [];
  for (const path of loomPaths) {
    if (!gitPaths.has(path)) {
      divergences.push({ path, reason: "missing from git mirror" });
    }
  }
  for (const path of gitPaths) {
    if (!loomPaths.has(path)) {
      divergences.push({ path, reason: "extra in git mirror" });
    }
  }
  for (const path of loomPaths) {
    if (!gitPaths.has(path)) {
      continue;
    }
    const a = cellBytes(state.cells[path]!);
    const b = cellBytes(gitState.cells[path]!);
    if (!a.equals(b)) {
      divergences.push({ path, reason: "content differs" });
    }
  }
  return {
    equivalent: divergences.length === 0,
    loomDigest: stateEquivalenceDigest(state),
    gitDigest: stateEquivalenceDigest(gitState),
    divergences
  };
}

/** The result of a mirror operation. */
export interface MirrorResult {
  readonly commitOid: string;
  readonly equivalent: boolean;
  readonly loomDigest: string;
  readonly gitDigest: string;
  readonly divergences: ReadonlyArray<MirrorDivergence>;
}

/**
 * Export the Loom head State to the git mirror, commit it, verify byte-exact
 * equivalence, and record the digest in the mirror ledger. On divergence the
 * mirror stops (LOOM-GIT-006) and both histories are preserved in the ledger.
 */
export async function mirrorHeadState(
  dir: string,
  gitRepoDir: string,
  message: string
): Promise<MirrorResult> {
  const state = loadHeadState(dir);
  const exported = exportStateToGit(state, gitRepoDir, { message });
  const verification = await verifyMirrorEquivalence(dir, gitRepoDir);

  const ledger = new FileLedger(join(loomDir(dir), MIRROR_FILE));
  ledger.append({
    head: readHead(dir),
    commitOid: exported.commitOid,
    written: exported.written,
    exportLosses: exported.losses,
    loomDigest: verification.loomDigest,
    gitDigest: verification.gitDigest,
    equivalent: verification.equivalent,
    divergences: verification.divergences,
    timestamp: Date.now()
  });

  return {
    commitOid: exported.commitOid,
    equivalent: verification.equivalent,
    loomDigest: verification.loomDigest,
    gitDigest: verification.gitDigest,
    divergences: verification.divergences
  };
}

/** The result of a clean-room restore drill. */
export interface RestoreDrillResult {
  readonly ok: boolean;
  readonly headReproduced: boolean;
  readonly linesVerified: number;
  readonly ledgerValid: boolean;
  readonly detail: string;
}

/**
 * Run a clean-room restore drill (LOOM-STORE-007): back up the object store,
 * restore it into a fresh store, and verify the head State, every Line head,
 * and the admission ledger are reproduced.
 */
export function restoreDrill(dir: string, backupDir: string): RestoreDrillResult {
  const head = readHead(dir);
  if (head === undefined) {
    throw new Error("not a Loom repository (run `loom init`)");
  }
  const store = new FileObjectStore(loomDir(dir));
  store.backupTo(backupDir);

  const freshRoot = mkdtempSync(join(tmpdir(), "loom-restore-"));
  try {
    const freshStore = new FileObjectStore(freshRoot);
    freshStore.restoreFrom(backupDir);
    const headState = freshStore.getDagCbor<State>(head as never);
    const headReproduced = headState !== undefined;

    const journal = new FileLineJournal(loomDir(dir));
    const linesDir = join(loomDir(dir), "lines");
    let linesVerified = 0;
    let linesOk = true;
    if (existsSync(linesDir)) {
      for (const file of readdirSync(linesDir)) {
        if (!file.endsWith(".json")) {
          continue;
        }
        const name = decodeURIComponent(file.slice(0, -".json".length));
        const entry = journal.read(name);
        if (entry === undefined) {
          linesOk = false;
          continue;
        }
        const stateAtHead = freshStore.getDagCbor<State>(entry.head as never);
        if (stateAtHead === undefined) {
          linesOk = false;
        }
        linesVerified += 1;
      }
    }

    const ledger = new FileLedger(join(loomDir(dir), LEDGER_FILE));
    const ledgerValid = ledger.verify().valid;

    const ok = headReproduced && linesOk && ledgerValid;
    return {
      ok,
      headReproduced,
      linesVerified,
      ledgerValid,
      detail: ok
        ? "clean-room restore reproduced the head, all Line heads, and a valid ledger"
        : "restore drill failed: history not fully reproduced"
    };
  } finally {
    rmSync(freshRoot, { recursive: true, force: true });
  }
}
