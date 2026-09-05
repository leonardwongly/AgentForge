/**
 * @agentforge/loom-core — large monorepo sharding and cross-Line atomic
 * proposal semantics (Phase 0, spec §23 item 8).
 *
 * A large monorepo is sharded across multiple Lines, each covering a disjoint
 * path prefix. A proposal may span several Lines, and admission must be
 * all-or-nothing: either every target Line advances to its new head, or none
 * does. This coordinator provides a prepare/commit flow under a single global
 * lock so that validation and commit are atomic as a unit, and a `LineShard`
 * model that maps path prefixes to Lines for sharding.
 */

import type { FileLineJournal, LineAdvanceInput } from "./store.js";
import { FileLock } from "./lock.js";
import type { Cid, LineScope } from "./types.js";

/** A Line covers a disjoint path prefix (the shard it owns). */
export interface LineShard {
  readonly line: string;
  readonly scope: LineScope;
  /** The path prefix this Line owns (e.g. "src/billing/"). */
  readonly pathPrefix: string;
}

/** A single Line update within a cross-Line proposal. */
export interface ProposalUpdate {
  readonly line: string;
  readonly expectedHead: Cid;
  readonly expectedSequence: number;
  readonly newHead: Cid;
}

export interface ProposalResult {
  readonly ok: boolean;
  /** Per-line outcomes for a committed proposal. */
  readonly committed: ReadonlyArray<{
    readonly line: string;
    readonly head: Cid;
    readonly sequence: number;
  }>;
  /** The first failing line for a rejected proposal. */
  readonly failedLine?: string | undefined;
  readonly reason?: string | undefined;
}

/** Validate that shards are disjoint (no two Lines own the same path prefix). */
export function validateShards(shards: readonly LineShard[]): string | undefined {
  const normalized = shards.map((shard) => ({
    ...shard,
    pathPrefix: normalizePrefix(shard.pathPrefix)
  }));
  for (let i = 0; i < normalized.length; i += 1) {
    const shard = normalized[i]!;
    if (shard.pathPrefix === "") {
      return `shard "${shard.line}" has an empty path prefix`;
    }
    if (!isSafePath(shard.pathPrefix)) {
      return `shard "${shard.line}" has an unsafe path prefix`;
    }
    for (let j = 0; j < i; j += 1) {
      const previous = normalized[j]!;
      if (prefixesOverlap(previous.pathPrefix, shard.pathPrefix)) {
        if (previous.pathPrefix === shard.pathPrefix) {
          return `duplicate path prefix "${shard.pathPrefix}" across shards`;
        }
        return `overlapping path prefix "${shard.pathPrefix}" with "${previous.pathPrefix}" across shards`;
      }
    }
  }
  return undefined;
}

/** Resolve which Line owns a path, or undefined if no shard covers it. */
export function resolveShard(shards: readonly LineShard[], path: string): LineShard | undefined {
  return shards.find((shard) => pathWithinPrefix(path, shard.pathPrefix));
}

function normalizePrefix(prefix: string): string {
  return prefix.replace(/\/$/u, "");
}

function isSafePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  );
}

function pathWithinPrefix(path: string, prefix: string): boolean {
  const normalized = normalizePrefix(prefix);
  return (
    isSafePath(path) &&
    isSafePath(normalized) &&
    (path === normalized || path.startsWith(`${normalized}/`))
  );
}

function prefixesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * Read-only prepare: verify every update's CAS condition holds without
 * committing. Returns undefined when all updates are applicable, else an error.
 */
export function prepareProposal(
  journal: FileLineJournal,
  updates: readonly ProposalUpdate[]
): string | undefined {
  const inputError = validateProposalUpdates(updates);
  if (inputError !== undefined) {
    return inputError;
  }
  for (const update of updates) {
    const current = journal.read(update.line);
    if (current === undefined) {
      return `line "${update.line}" has no genesis; proposals cannot create Lines`;
    }
    if (current.head !== update.expectedHead) {
      return `line "${update.line}" head moved (expected ${update.expectedHead}, current ${current.head})`;
    }
    if (current.sequence !== update.expectedSequence) {
      return `line "${update.line}" sequence moved (expected ${update.expectedSequence}, current ${current.sequence})`;
    }
  }
  return undefined;
}

/**
 * Commit a cross-Line proposal atomically (all-or-nothing) under a single
 * global lock. Validation and commit happen under the lock, so no concurrent
 * writer can advance a Line in between; a rejected proposal advances nothing.
 */
export async function commitProposal(
  root: string,
  journal: FileLineJournal,
  updates: readonly ProposalUpdate[]
): Promise<ProposalResult> {
  const inputError = validateProposalUpdates(updates);
  if (inputError !== undefined) {
    return { ok: false, committed: [], reason: inputError };
  }
  const lock = new FileLock(root, "proposal-global");
  const release = await lock.acquire();
  try {
    const prepareError = prepareProposal(journal, updates);
    if (prepareError !== undefined) {
      return { ok: false, committed: [], reason: prepareError };
    }
    const outcome = await journal.advanceBatch(
      updates.map((update): LineAdvanceInput => ({
        name: update.line,
        scope: "shared",
        expectedHead: update.expectedHead,
        expectedSequence: update.expectedSequence,
        newHead: update.newHead
      }))
    );
    if (!outcome.ok) {
      return { ok: false, committed: [], failedLine: outcome.failedLine, reason: outcome.detail };
    }
    return {
      ok: true,
      committed: outcome.entries.map((entry) => ({
        line: entry.name,
        head: entry.head,
        sequence: entry.sequence
      }))
    };
  } finally {
    release();
  }
}

function validateProposalUpdates(updates: readonly ProposalUpdate[]): string | undefined {
  if (updates.length === 0) {
    return "proposal must contain at least one line update";
  }
  const seen = new Set<string>();
  for (const update of updates) {
    if (!update.line || seen.has(update.line)) {
      return `proposal contains duplicate or empty line "${update.line}"`;
    }
    seen.add(update.line);
    if (!Number.isSafeInteger(update.expectedSequence) || update.expectedSequence < 0) {
      return `line "${update.line}" has an invalid expected sequence`;
    }
    if (!update.expectedHead || !update.newHead) {
      return `line "${update.line}" must include both expectedHead and newHead`;
    }
  }
  return undefined;
}
