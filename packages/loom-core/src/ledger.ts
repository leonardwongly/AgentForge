/**
 * @agentforge/loom-core — tamper-evident admission ledger (Phase 1, spec §15).
 *
 * An append-only ledger in which every entry is cryptographically linked to the
 * previous one (a hash chain), so any modification or reordering of past
 * entries is detected by `verify()`. Entries record admission events
 * (proposal id, actor, decision). The ledger is durable and file-backed.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { canonicalize } from "./addressing.js";

const GENESIS = "loom-ledger-v1|genesis";

export interface LedgerEntry {
  readonly index: number;
  readonly prevHash: string;
  readonly payload: unknown;
  readonly hash: string;
}

export interface LedgerVerifyResult {
  readonly valid: boolean;
  readonly firstInvalid?: number | undefined;
}

export class FileLedger {
  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
  }

  /** Append a payload as a new linked entry and return it. */
  append(payload: unknown): LedgerEntry {
    const entries = this.read();
    const prevHash = entries.length === 0 ? GENESIS : entries[entries.length - 1]!.hash;
    const index = entries.length;
    const hash = this.hash(prevHash, payload);
    const entry: LedgerEntry = { index, prevHash, payload, hash };
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  }

  /** Read all entries in order. */
  read(): LedgerEntry[] {
    if (!existsSync(this.file)) {
      return [];
    }
    return readFileSync(this.file, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as LedgerEntry);
  }

  /** Replay the chain and verify every link and hash. */
  verify(): LedgerVerifyResult {
    let prevHash = GENESIS;
    const entries = this.read();
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (
        entry.index !== i ||
        entry.prevHash !== prevHash ||
        entry.hash !== this.hash(prevHash, entry.payload)
      ) {
        return { valid: false, firstInvalid: i };
      }
      prevHash = entry.hash;
    }
    return { valid: true };
  }

  private hash(prevHash: string, payload: unknown): string {
    return createHash("sha256")
      .update(`${prevHash}|${canonicalize(payload)}`)
      .digest("hex");
  }
}
