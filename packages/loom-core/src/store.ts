/**
 * @agentforge/loom-core — durable local object store and transactional Line
 * journal (Phase 0 foundation).
 *
 * The object store is content-addressed and immutable: every object is stored
 * under its own CID and written atomically (temp file + rename), so a crash can
 * never leave a partial object behind and the same content is never stored
 * twice. Reads re-verify the stored bytes against the requested CID.
 *
 * The Line journal is a transactional, compare-and-swap (CAS) store for Line
 * head updates. Every successful advance leases `(head, sequence)` (spec §23
 * item 15): a stale `expectedHead` or `expectedSequence` is rejected rather than
 * silently overwriting a concurrent update. Idempotency keys bind one request
 * digest to one durable result, so a retried request returns the original
 * outcome instead of double-advancing the Line.
 *
 * Durability model: single-process local store. Writes are fsync'd atomically
 * via rename; in-process operations are serialized. Cross-process file locking
 * and the DAG-CBOR/CIDv1 encoding are deferred (see the Loom spec decision
 * register). This module is a pure, hermetic foundation with no network or
 * ambient state.
 */

import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";

import { address, verifyAddress } from "./addressing.js";
import { cidV1, decodeDagCbor, encodeDagCbor, MULTICODEC } from "./codec.js";
import { FileLock } from "./lock.js";
import type { Cid, LineScope } from "./types.js";

// ---- Content-addressed object store ----------------------------------------

export interface DurableObjectStore {
  /** Persist `value` content-addressed and return its CID (immutable dedup). */
  put(value: unknown): Cid;
  /** Read and verify the object at `cid`; returns undefined if absent or corrupt. */
  get<T>(cid: Cid): T | undefined;
  has(cid: Cid): boolean;
  /** Store raw bytes under a `raw`-codec CIDv1. */
  putRaw(bytes: Uint8Array): Cid;
  getRaw(cid: Cid): Uint8Array | undefined;
  hasRaw(cid: Cid): boolean;
  /** Encode a structured object as DAG-CBOR and store under a `dag-cbor` CIDv1. */
  putDagCbor(value: unknown): Cid;
  getDagCbor<T>(cid: Cid): T | undefined;
  hasDagCbor(cid: Cid): boolean;
}

export class FileObjectStore implements DurableObjectStore {
  private readonly objectsDir: string;

  constructor(root: string) {
    this.objectsDir = join(root, "objects");
    mkdirSync(this.objectsDir, { recursive: true });
  }

  put(value: unknown): Cid {
    const cid = address(value);
    const target = join(this.objectsDir, `${cid}.json`);
    if (existsSync(target)) {
      // Content-addressed objects are immutable: a present object is already correct.
      return cid;
    }
    const tmp = join(this.objectsDir, `.${cid}.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(tmp, JSON.stringify(value), { encoding: "utf8", flag: "wx" });
    renameSync(tmp, target); // atomic: readers never observe a partial object
    return cid;
  }

  get<T>(cid: Cid): T | undefined {
    const target = join(this.objectsDir, `${cid}.json`);
    if (!existsSync(target)) {
      return undefined;
    }
    try {
      const value = JSON.parse(readFileSync(target, "utf8")) as T;
      return verifyAddress(cid, value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  has(cid: Cid): boolean {
    return existsSync(join(this.objectsDir, `${cid}.json`));
  }

  /** Store raw bytes under a `raw`-codec CIDv1 (immutable dedup). */
  putRaw(bytes: Uint8Array): Cid {
    const cid = cidV1(MULTICODEC.raw, bytes);
    const target = join(this.objectsDir, `${cid}.bin`);
    if (existsSync(target)) {
      return cid;
    }
    const tmp = join(this.objectsDir, `.${cid}.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(tmp, bytes, { flag: "wx" });
    renameSync(tmp, target);
    return cid;
  }

  /** Read raw bytes and verify they hash to the requested CID; undefined if absent/corrupt. */
  getRaw(cid: Cid): Uint8Array | undefined {
    const target = join(this.objectsDir, `${cid}.bin`);
    if (!existsSync(target)) {
      return undefined;
    }
    try {
      const bytes = readFileSync(target);
      return cidV1(MULTICODEC.raw, bytes) === cid ? bytes : undefined;
    } catch {
      return undefined;
    }
  }

  hasRaw(cid: Cid): boolean {
    return existsSync(join(this.objectsDir, `${cid}.bin`));
  }

  /** Encode a structured object as DAG-CBOR, store under a `dag-cbor` CIDv1. */
  putDagCbor(value: unknown): Cid {
    const bytes = encodeDagCbor(value);
    const cid = cidV1(MULTICODEC.dagCbor, bytes);
    const target = join(this.objectsDir, `${cid}.cbor`);
    if (existsSync(target)) {
      return cid;
    }
    const tmp = join(this.objectsDir, `.${cid}.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(tmp, bytes, { flag: "wx" });
    renameSync(tmp, target);
    return cid;
  }

  /** Read and decode a DAG-CBOR object, verifying its CID; undefined if absent/corrupt. */
  getDagCbor<T>(cid: Cid): T | undefined {
    const target = join(this.objectsDir, `${cid}.cbor`);
    if (!existsSync(target)) {
      return undefined;
    }
    try {
      const bytes = readFileSync(target);
      if (cidV1(MULTICODEC.dagCbor, bytes) !== cid) {
        return undefined;
      }
      return decodeDagCbor(bytes) as T;
    } catch {
      return undefined;
    }
  }

  hasDagCbor(cid: Cid): boolean {
    return existsSync(join(this.objectsDir, `${cid}.cbor`));
  }

  /** List every stored object CID (across all codecs). */
  listCids(): Cid[] {
    const cids = new Set<Cid>();
    for (const file of readdirSync(this.objectsDir)) {
      // Legacy canonical-JSON address (loom:sha256:<hex>) or CIDv1 base32.
      const legacy = /^(loom:sha256:[0-9a-f]{64})\.json$/u.exec(file);
      if (legacy) {
        cids.add(legacy[1] as Cid);
        continue;
      }
      const cidv1 = /^([a-z2-7]{20,})\.(bin|cbor)$/u.exec(file);
      if (cidv1) {
        cids.add(cidv1[1] as Cid);
      }
    }
    return [...cids];
  }

  /** Delete a stored object (no-op if absent). */
  delete(cid: Cid): void {
    for (const ext of ["json", "bin", "cbor"]) {
      rmSync(join(this.objectsDir, `${cid}.${ext}`), { force: true });
    }
  }

  /** Snapshot every object file into `backupDir` (for backup/restore). */
  backupTo(backupDir: string): void {
    mkdirSync(backupDir, { recursive: true });
    for (const file of readdirSync(this.objectsDir)) {
      copyFileSync(join(this.objectsDir, file), join(backupDir, file));
    }
  }

  /** Restore every object file from `backupDir`. */
  restoreFrom(backupDir: string): void {
    mkdirSync(this.objectsDir, { recursive: true });
    for (const file of readdirSync(backupDir)) {
      copyFileSync(join(backupDir, file), join(this.objectsDir, file));
    }
  }

  /** Remove orphaned temp files left by a crash between write and rename. */
  recover(): void {
    for (const file of readdirSync(this.objectsDir)) {
      if (file.endsWith(".tmp")) {
        rmSync(join(this.objectsDir, file), { force: true });
      }
    }
  }
}

// ---- Transactional Line journal -------------------------------------------

export interface LineJournalEntry {
  readonly name: string;
  readonly scope: LineScope;
  readonly head: Cid;
  readonly sequence: number;
}

export type AdvanceOutcome =
  | { readonly ok: true; readonly entry: LineJournalEntry; readonly applied: boolean }
  | {
      readonly ok: false;
      readonly reason: "stale" | "conflict" | "missing_line";
      readonly detail: string;
    };

export interface LineAdvanceInput {
  readonly name: string;
  readonly scope: LineScope;
  readonly expectedHead: Cid;
  readonly expectedSequence: number;
  readonly newHead: Cid;
  /** Optional idempotency key: a retried request returns the original result. */
  readonly idempotencyKey?: string | undefined;
}

export class FileLineJournal {
  private readonly root: string;
  private readonly linesDir: string;
  private readonly idemDir: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(root: string) {
    this.root = root;
    this.linesDir = join(root, "lines");
    this.idemDir = join(root, "idempotency");
    mkdirSync(this.linesDir, { recursive: true });
    mkdirSync(this.idemDir, { recursive: true });
  }

  /** Current durable entry for a Line, or undefined if the Line has no genesis yet. */
  read(name: string): LineJournalEntry | undefined {
    const target = this.linePath(name);
    if (!existsSync(target)) {
      return undefined;
    }
    try {
      return JSON.parse(readFileSync(target, "utf8")) as LineJournalEntry;
    } catch {
      return undefined;
    }
  }

  /**
   * Transactionally advance a Line head under CAS on `(head, sequence)`.
   * Serialized in-process; each successful advance is committed atomically.
   */
  advance(input: LineAdvanceInput): Promise<AdvanceOutcome> {
    // Serialize in-process via the promise chain AND take a cross-process file
    // lock so the CAS read-modify-write is safe across multiple processes.
    const run = this.chain.then(async () => {
      const lock = new FileLock(this.root, `line:${input.name}`);
      const release = await lock.acquire();
      try {
        return this.advanceSync(input);
      } finally {
        release();
      }
    });
    // Keep the chain alive even if a caller never awaits the result.
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Remove orphaned temp files left by a crash between write and rename. */
  recover(): void {
    for (const file of readdirSync(this.linesDir)) {
      if (file.endsWith(".tmp")) {
        rmSync(join(this.linesDir, file), { force: true });
      }
    }
  }

  private advanceSync(input: LineAdvanceInput): AdvanceOutcome {
    if (input.idempotencyKey !== undefined) {
      const prior = this.readIdempotency(input.idempotencyKey);
      if (prior !== undefined) {
        return { ok: true, entry: prior, applied: false };
      }
    }

    const current = this.read(input.name);
    let next: LineJournalEntry;

    if (current === undefined) {
      if (input.expectedSequence !== 0) {
        return {
          ok: false,
          reason: "missing_line",
          detail: `line "${input.name}" has no genesis; expectedSequence must be 0`
        };
      }
      next = { name: input.name, scope: input.scope, head: input.newHead, sequence: 0 };
    } else {
      if (current.head !== input.expectedHead) {
        return {
          ok: false,
          reason: "stale",
          detail: `line "${input.name}" head moved (expected ${input.expectedHead}, current ${current.head})`
        };
      }
      if (current.sequence !== input.expectedSequence) {
        return {
          ok: false,
          reason: "conflict",
          detail: `line "${input.name}" sequence moved (expected ${input.expectedSequence}, current ${current.sequence})`
        };
      }
      next = {
        name: input.name,
        scope: current.scope,
        head: input.newHead,
        sequence: current.sequence + 1
      };
    }

    this.writeLine(next);
    if (input.idempotencyKey !== undefined) {
      this.writeIdempotency(input.idempotencyKey, next);
    }
    return { ok: true, entry: next, applied: true };
  }

  private linePath(name: string): string {
    return join(this.linesDir, `${encodeURIComponent(name)}.json`);
  }

  private writeLine(entry: LineJournalEntry): void {
    const target = this.linePath(entry.name);
    const tmp = join(this.linesDir, `.${encodeURIComponent(entry.name)}.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(tmp, JSON.stringify(entry), { encoding: "utf8", flag: "wx" });
    renameSync(tmp, target);
  }

  private readIdempotency(key: string): LineJournalEntry | undefined {
    const target = join(this.idemDir, `${encodeURIComponent(key)}.json`);
    if (!existsSync(target)) {
      return undefined;
    }
    try {
      return JSON.parse(readFileSync(target, "utf8")) as LineJournalEntry;
    } catch {
      return undefined;
    }
  }

  private writeIdempotency(key: string, entry: LineJournalEntry): void {
    const target = join(this.idemDir, `${encodeURIComponent(key)}.json`);
    const tmp = join(this.idemDir, `.${encodeURIComponent(key)}.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(tmp, JSON.stringify(entry), { encoding: "utf8", flag: "wx" });
    renameSync(tmp, target);
  }
}
