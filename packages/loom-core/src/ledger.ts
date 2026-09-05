/**
 * @agentforge/loom-core — tamper-evident admission ledger (Phase 1, spec §15).
 *
 * An append-only ledger in which every entry is cryptographically linked to the
 * previous one (a hash chain), so any modification or reordering of past
 * entries is detected by `verify()`. Entries record admission events
 * (proposal id, actor, decision). The ledger is durable and file-backed.
 */

import { createHash, createHmac } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { canonicalize } from "./addressing.js";
import { FileLock } from "./lock.js";

const GENESIS = "loom-ledger-v1|genesis";

export interface LedgerEntry {
  readonly index: number;
  readonly prevHash: string;
  readonly payload: unknown;
  readonly hash: string;
  /** Optional keyed integrity tag; present when the ledger has an integrity key. */
  readonly mac?: string | undefined;
}

export interface LedgerVerifyResult {
  readonly valid: boolean;
  readonly firstInvalid?: number | undefined;
}

type LoadedLedger = {
  readonly entries: LedgerEntry[];
  readonly corruptIndex?: number | undefined;
};

export class FileLedger {
  private readonly integrityKey: Buffer | undefined;

  constructor(file: string, integrityKey?: Uint8Array | string) {
    this.file = file;
    if (integrityKey !== undefined) {
      const key = Buffer.from(integrityKey);
      if (key.length === 0) throw new Error("ledger integrity key must not be empty");
      this.integrityKey = key;
    }
    mkdirSync(dirname(file), { recursive: true });
  }

  private readonly file: string;

  /** Append a payload as a new linked entry and return it. */
  append(payload: unknown): LedgerEntry {
    const lock = new FileLock(dirname(this.file), `ledger:${this.file}`);
    const release = lock.acquireSync();
    try {
      const entries = this.read();
      const prevHash = entries.length === 0 ? GENESIS : entries[entries.length - 1]!.hash;
      const index = entries.length;
      const hash = this.hash(prevHash, payload);
      const entry: LedgerEntry = {
        index,
        prevHash,
        payload,
        hash,
        ...(this.integrityKey === undefined ? {} : { mac: this.mac(index, prevHash, hash) })
      };
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, "utf8");
      return entry;
    } finally {
      release();
    }
  }

  /** Read all entries in order. */
  read(): LedgerEntry[] {
    return this.load().entries;
  }

  /** Return the current checkpoint digest for external anchoring. */
  checkpoint(): string {
    const entries = this.read();
    return entries.length === 0 ? GENESIS : entries[entries.length - 1]!.hash;
  }

  /** Replay the chain and verify every link, hash, optional MAC, and checkpoint. */
  verify(expectedCheckpoint?: string): LedgerVerifyResult {
    const loaded = this.load();
    if (loaded.corruptIndex !== undefined) {
      return { valid: false, firstInvalid: loaded.corruptIndex };
    }
    let prevHash = GENESIS;
    const entries = loaded.entries;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        return { valid: false, firstInvalid: i };
      }
      try {
        if (
          entry.index !== i ||
          entry.prevHash !== prevHash ||
          entry.hash !== this.hash(prevHash, entry.payload)
        ) {
          return { valid: false, firstInvalid: i };
        }
      } catch {
        return { valid: false, firstInvalid: i };
      }
      if (this.integrityKey !== undefined) {
        if (
          typeof entry.mac !== "string" ||
          entry.mac !== this.mac(entry.index, entry.prevHash, entry.hash)
        ) {
          return { valid: false, firstInvalid: i };
        }
      }
      prevHash = entry.hash;
    }
    if (expectedCheckpoint !== undefined && prevHash !== expectedCheckpoint) {
      return { valid: false, firstInvalid: entries.length };
    }
    return { valid: true };
  }

  private load(): LoadedLedger {
    if (!existsSync(this.file)) {
      return { entries: [] };
    }
    const entries: LedgerEntry[] = [];
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        entries.push(JSON.parse(line) as LedgerEntry);
      } catch {
        return { entries, corruptIndex: entries.length };
      }
    }
    return { entries };
  }

  private hash(prevHash: string, payload: unknown): string {
    return createHash("sha256")
      .update(`${prevHash}|${canonicalize(payload)}`)
      .digest("hex");
  }

  private mac(index: number, prevHash: string, hash: string): string {
    // The MAC key is supplied out-of-band; it is intentionally never written
    // to the ledger file. This prevents an attacker with file write access
    // from rewriting the entire hash chain undetected.
    return createHmac("sha256", this.integrityKey!)
      .update(`${index}|${prevHash}|${hash}`)
      .digest("hex");
  }
}
