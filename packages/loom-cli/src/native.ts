/**
 * @agentforge/loom-cli — native Loom commands (Phase 1, spec §10/§13/§15).
 *
 * `init`, `status`, `propose`, and `log` operate on a repository directory
 * with a `.loom/` store: a working copy is captured into a State, changes are
 * committed through a cross-Line proposal, and every admission is recorded in a
 * tamper-evident ledger. The commands build on @agentforge/loom-core.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  address,
  captureState,
  diffWorkingCopy,
  FileLedger,
  FileLineJournal,
  FileObjectStore,
  type State
} from "@agentforge/loom-core";

const LOOM_DIR = ".loom";
const HEAD_FILE = "head";
const LEDGER_FILE = "ledger.jsonl";

const EXCLUDE = new Set([LOOM_DIR]);

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

function genesisHead(): string {
  return address({ kind: "line", name: "main", scope: "shared", head: "genesis" });
}

/** Initialize a Loom repository: create the store, base State, Line, and ledger. */
export function initRepo(dir: string): string {
  if (readHead(dir) !== undefined) {
    return "already initialized";
  }
  mkdirSync(loomDir(dir), { recursive: true });
  const store = new FileObjectStore(loomDir(dir));
  const base = captureState(dir, undefined, EXCLUDE);
  const head = store.putDagCbor(base);
  writeFileSync(headPath(dir), head, "utf8");

  const journal = new FileLineJournal(loomDir(dir));
  void journal.advance({
    name: "main",
    scope: "shared",
    expectedHead: genesisHead() as never,
    expectedSequence: 0,
    newHead: head as never
  });
  return `initialized: head ${head}`;
}

/** Show the change journal of the working copy relative to the current head. */
export function statusRepo(dir: string): string {
  const head = readHead(dir);
  if (head === undefined) {
    return "not a Loom repository (run `loom init`)";
  }
  const store = new FileObjectStore(loomDir(dir));
  const base = store.getDagCbor<State>(head as never);
  if (!base) {
    return "corrupt repository: head state not found";
  }
  const journal = diffWorkingCopy(dir, base, EXCLUDE);
  const lines: string[] = [];
  for (const path of journal.added) {
    lines.push(`A ${path}`);
  }
  for (const path of journal.modified) {
    lines.push(`M ${path}`);
  }
  for (const path of journal.removed) {
    lines.push(`D ${path}`);
  }
  if (lines.length === 0) {
    return "working copy clean";
  }
  return lines.join("\n");
}

/** Capture the working copy, commit it through a proposal, and record the ledger. */
export async function proposeRepo(dir: string, title: string): Promise<string> {
  const head = readHead(dir);
  if (head === undefined) {
    return "not a Loom repository (run `loom init`)";
  }
  const store = new FileObjectStore(loomDir(dir));
  const base = store.getDagCbor<State>(head as never);
  if (!base) {
    return "corrupt repository: head state not found";
  }
  const journal = diffWorkingCopy(dir, base, EXCLUDE);
  if (journal.added.length === 0 && journal.modified.length === 0 && journal.removed.length === 0) {
    return "no changes to propose";
  }

  const next = captureState(dir, undefined, EXCLUDE);
  const nextHead = store.putDagCbor(next);
  const lineJournal = new FileLineJournal(loomDir(dir));
  const current = lineJournal.read("main");
  const outcome = await lineJournal.advance({
    name: "main",
    scope: "shared",
    expectedHead: (current?.head ?? head) as never,
    expectedSequence: current?.sequence ?? 0,
    newHead: nextHead as never
  });
  if (!outcome.ok) {
    return "proposal rejected: Line head moved (concurrent change)";
  }

  const ledger = new FileLedger(join(loomDir(dir), LEDGER_FILE));
  ledger.append({
    title,
    from: head,
    to: nextHead,
    added: journal.added.length,
    modified: journal.modified.length,
    removed: journal.removed.length
  });
  writeFileSync(headPath(dir), nextHead, "utf8");
  return `committed ${nextHead} (${title})`;
}

/** Print the tamper-evident admission ledger. */
export function logRepo(dir: string): string {
  const ledger = new FileLedger(join(loomDir(dir), LEDGER_FILE));
  const entries = ledger.read();
  if (entries.length === 0) {
    return "no ledger entries";
  }
  const verify = ledger.verify();
  const lines = entries.map((entry) => `#${entry.index} ${JSON.stringify(entry.payload)}`);
  lines.push(`ledger ${verify.valid ? "valid" : "TAMPERED"}`);
  return lines.join("\n");
}


