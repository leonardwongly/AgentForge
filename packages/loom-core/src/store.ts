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

import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { address, verifyAddress } from "./addressing.js";
import { cidV1, decodeDagCbor, encodeDagCbor, MULTICODEC, parseCid } from "./codec.js";
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
    if (this.get(cid) !== undefined) {
      // Content-addressed objects are immutable: a present object is already correct.
      return cid;
    }
    const tmp = join(this.objectsDir, `.${cid}.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(tmp, JSON.stringify(value), { encoding: "utf8", flag: "wx" });
    renameSync(tmp, target); // atomic: readers never observe a partial object
    return cid;
  }

  get<T>(cid: Cid): T | undefined {
    const target = this.objectPath(cid, "json");
    if (!target) return undefined;
    if (!isRegularFile(target)) {
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
    const target = this.objectPath(cid, "json");
    return target !== undefined && isRegularFile(target);
  }

  /** Store raw bytes under a `raw`-codec CIDv1 (immutable dedup). */
  putRaw(bytes: Uint8Array): Cid {
    const cid = cidV1(MULTICODEC.raw, bytes);
    const target = join(this.objectsDir, `${cid}.bin`);
    if (this.getRaw(cid) !== undefined) {
      return cid;
    }
    const tmp = join(this.objectsDir, `.${cid}.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(tmp, bytes, { flag: "wx" });
    renameSync(tmp, target);
    return cid;
  }

  /** Read raw bytes and verify they hash to the requested CID; undefined if absent/corrupt. */
  getRaw(cid: Cid): Uint8Array | undefined {
    const target = this.objectPath(cid, "bin");
    if (!target) return undefined;
    if (!isRegularFile(target)) {
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
    const target = this.objectPath(cid, "bin");
    return target !== undefined && isRegularFile(target);
  }

  /** Encode a structured object as DAG-CBOR, store under a `dag-cbor` CIDv1. */
  putDagCbor(value: unknown): Cid {
    const bytes = encodeDagCbor(value);
    const cid = cidV1(MULTICODEC.dagCbor, bytes);
    const target = join(this.objectsDir, `${cid}.cbor`);
    if (this.getDagCbor(cid) !== undefined) {
      return cid;
    }
    const tmp = join(this.objectsDir, `.${cid}.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(tmp, bytes, { flag: "wx" });
    renameSync(tmp, target);
    return cid;
  }

  /** Read and decode a DAG-CBOR object, verifying its CID; undefined if absent/corrupt. */
  getDagCbor<T>(cid: Cid): T | undefined {
    const target = this.objectPath(cid, "cbor");
    if (!target) return undefined;
    if (!isRegularFile(target)) {
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
    const target = this.objectPath(cid, "cbor");
    return target !== undefined && isRegularFile(target);
  }

  /** List every stored object CID (across all codecs). */
  listCids(): Cid[] {
    const cids = new Set<Cid>();
    for (const file of readdirSync(this.objectsDir)) {
      if (!isRegularFile(join(this.objectsDir, file))) continue;
      // Legacy canonical-JSON address (loom:sha256:<hex>) or CIDv1 base32.
      const legacy = /^(loom:sha256:[0-9a-f]{64})\.json$/u.exec(file);
      if (legacy) {
        cids.add(legacy[1] as Cid);
        continue;
      }
      const cidv1 = /^([a-z2-7]{20,})\.(bin|cbor)$/u.exec(file);
      if (cidv1) {
        const candidate = cidv1[1] as Cid;
        if (parseCid(candidate) !== undefined) cids.add(candidate);
      }
    }
    return [...cids];
  }

  /** Delete a stored object (no-op if absent). */
  delete(cid: Cid): void {
    if (!isSafeCid(cid)) return;
    for (const ext of ["json", "bin", "cbor"]) {
      rmSync(this.objectPath(cid, ext)!, { force: true });
    }
  }

  /** Snapshot every object file into `backupDir` (for backup/restore). */
  backupTo(backupDir: string): void {
    mkdirSync(backupDir, { recursive: true });
    for (const file of readdirSync(this.objectsDir)) {
      if (!lstatSync(join(this.objectsDir, file)).isFile()) continue;
      const target = join(backupDir, file);
      ensureRegularOrMissing(target);
      copyFileAtomically(join(this.objectsDir, file), target);
    }
  }

  /** Restore every object file from `backupDir`. */
  restoreFrom(backupDir: string): void {
    mkdirSync(this.objectsDir, { recursive: true });
    const pending: Array<{ source: string; target: string }> = [];
    for (const file of readdirSync(backupDir)) {
      if (!/^(?:loom:sha256:[0-9a-f]{64}|[a-z2-7]{20,})\.(?:json|bin|cbor)$/u.test(file)) {
        continue;
      }
      if (!lstatSync(join(backupDir, file)).isFile()) continue;
      const source = join(backupDir, file);
      if (!backupObjectMatchesCid(file, readFileSync(source))) {
        throw new Error(`loom: backup object ${file} does not match its CID`);
      }
      pending.push({ source, target: join(this.objectsDir, file) });
    }
    for (const { source, target } of pending) {
      ensureRegularOrMissing(target);
    }
    for (const { source, target } of pending) {
      copyFileAtomically(source, target);
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

  private objectPath(cid: Cid, extension: string): string | undefined {
    if (!isSafeCid(cid)) return undefined;
    return join(this.objectsDir, `${cid}.${extension}`);
  }
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function ensureRegularOrMissing(path: string): void {
  try {
    if (!lstatSync(path).isFile()) {
      throw new Error(`loom: refusing to overwrite symlink/non-regular object ${path}`);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

function copyFileAtomically(source: string, target: string): void {
  const temporary = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    copyFileSync(source, temporary);
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function isSafeCid(cid: string): boolean {
  if (/^loom:sha256:[0-9a-f]{64}$/u.test(cid)) return true;
  if (!/^[a-z2-7]{20,}$/u.test(cid)) return false;
  const parsed = parseCid(cid);
  return parsed?.version === 1 && parsed.digest.length === 32;
}

function backupObjectMatchesCid(filename: string, bytes: Buffer): boolean {
  const separator = filename.lastIndexOf(".");
  const cid = filename.slice(0, separator) as Cid;
  const extension = filename.slice(separator + 1);
  if (extension === "bin") {
    return cidV1(MULTICODEC.raw, bytes) === cid;
  }
  if (extension === "cbor") {
    return cidV1(MULTICODEC.dagCbor, bytes) === cid;
  }
  try {
    return verifyAddress(cid, JSON.parse(bytes.toString("utf8")));
  } catch {
    return false;
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

type IdempotencyRecord = {
  readonly digest: string;
  readonly entry: LineJournalEntry;
};

type LineReadResult =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly detail: string }
  | { readonly kind: "present"; readonly entry: LineJournalEntry };

/** Result of a multi-Line CAS commit. Writes are rolled back on failure. */
export type BatchAdvanceOutcome =
  | { readonly ok: true; readonly entries: ReadonlyArray<LineJournalEntry> }
  | {
      readonly ok: false;
      readonly failedLine: string;
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
    const result = this.readLineState(name);
    return result.kind === "present" ? result.entry : undefined;
  }

  /**
   * Transactionally advance a Line head under CAS on `(head, sequence)`.
   * Serialized in-process; each successful advance is committed atomically.
   */
  advance(input: LineAdvanceInput): Promise<AdvanceOutcome> {
    // Serialize in-process via the promise chain AND take a cross-process file
    // lock so the CAS read-modify-write is safe across multiple processes.
    const run = this.chain.then(async () => {
      const validation = validateLineAdvanceInput(input);
      if (validation !== undefined) {
        throw new Error(`loom: invalid line advance: ${validation}`);
      }
      const lockNames = [`line:${input.name}`];
      if (input.idempotencyKey !== undefined) {
        lockNames.push(`idempotency:${input.idempotencyKey}`);
      }
      lockNames.sort();
      const releases: Array<() => void> = [];
      try {
        for (const name of lockNames) {
          releases.push(await new FileLock(this.root, name).acquire());
        }
        return this.advanceSync(input);
      } finally {
        for (const release of releases.reverse()) release();
      }
    });
    // Keep the chain alive even if a caller never awaits the result.
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Atomically apply a set of CAS updates spanning multiple Lines. Per-Line
   * locks are acquired in a stable order, so ordinary `advance` calls cannot
   * interleave. If a filesystem write fails after an earlier write, all
   * already-written entries are restored from their snapshots before the
   * error is propagated to the caller.
   */
  advanceBatch(inputs: readonly LineAdvanceInput[]): Promise<BatchAdvanceOutcome> {
    const run = this.chain.then(async () => {
      const seenNames = new Set<string>();
      let duplicateName: string | undefined;
      for (const input of inputs) {
        if (seenNames.has(input.name)) {
          duplicateName = input.name;
          break;
        }
        seenNames.add(input.name);
      }
      if (duplicateName !== undefined) {
        return {
          ok: false as const,
          failedLine: duplicateName,
          reason: "conflict" as const,
          detail: `line "${duplicateName}" appears more than once in one batch`
        };
      }
      for (const input of inputs) {
        const validation = validateLineAdvanceInput(input);
        if (validation !== undefined) {
          throw new Error(`loom: invalid line advance: ${validation}`);
        }
      }
      const names = [...new Set(inputs.map((input) => input.name))].sort();
      const releases: Array<() => void> = [];
      const snapshots = new Map<string, LineJournalEntry | undefined>();
      try {
        for (const name of names) {
          releases.push(await new FileLock(this.root, `line:${name}`).acquire());
        }
        for (const name of names) {
          const current = this.readLineState(name);
          if (current.kind === "invalid") {
            throw new Error(`loom: line "${name}" is corrupt: ${current.detail}`);
          }
          snapshots.set(name, current.kind === "present" ? current.entry : undefined);
        }

        const nextEntries: LineJournalEntry[] = [];
        for (const input of inputs) {
          const current = snapshots.get(input.name);
          if (current === undefined) {
            return {
              ok: false as const,
              failedLine: input.name,
              reason: "missing_line" as const,
              detail: `line "${input.name}" has no genesis`
            };
          }
          if (current.head !== input.expectedHead) {
            return {
              ok: false as const,
              failedLine: input.name,
              reason: "stale" as const,
              detail: `line "${input.name}" head moved (expected ${input.expectedHead}, current ${current.head})`
            };
          }
          if (current.sequence !== input.expectedSequence) {
            return {
              ok: false as const,
              failedLine: input.name,
              reason: "conflict" as const,
              detail: `line "${input.name}" sequence moved (expected ${input.expectedSequence}, current ${current.sequence})`
            };
          }
          nextEntries.push({
            name: input.name,
            scope: current.scope,
            head: input.newHead,
            sequence: current.sequence + 1
          });
        }

        const written: LineJournalEntry[] = [];
        try {
          for (const entry of nextEntries) {
            this.writeLine(entry);
            written.push(entry);
          }
        } catch (error) {
          // Best-effort rollback keeps the batch all-or-nothing for ordinary
          // I/O failures. A process crash still requires startup recovery.
          for (const entry of written.reverse()) {
            const previous = snapshots.get(entry.name);
            if (previous === undefined) {
              rmSync(this.linePath(entry.name), { force: true });
            } else {
              this.writeLine(previous);
            }
          }
          throw error;
        }
        return { ok: true as const, entries: nextEntries };
      } finally {
        for (const release of releases.reverse()) release();
      }
    });
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
    const requestDigest = this.idempotencyDigest(input);
    if (input.idempotencyKey !== undefined) {
      const prior = this.readIdempotency(input.idempotencyKey);
      if (prior !== undefined) {
        if (prior.digest !== requestDigest) {
          return {
            ok: false,
            reason: "conflict",
            detail: "idempotency key was already used for a different request"
          };
        }
        if (!isMatchingIdempotencyRecord(prior, input)) {
          throw new Error(`loom: idempotency record for "${input.idempotencyKey}" is invalid`);
        }
        return { ok: true, entry: prior.entry, applied: false };
      }
    }

    const lineState = this.readLineState(input.name);
    if (lineState.kind === "invalid") {
      throw new Error(`loom: line "${input.name}" is corrupt: ${lineState.detail}`);
    }
    const current = lineState.kind === "present" ? lineState.entry : undefined;
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
      this.writeIdempotency(input.idempotencyKey, { digest: requestDigest, entry: next });
    }
    return { ok: true, entry: next, applied: true };
  }

  private linePath(name: string): string {
    return join(this.linesDir, `${encodeURIComponent(name)}.json`);
  }

  private readLineState(name: string): LineReadResult {
    const target = this.linePath(name);
    try {
      lstatSync(target);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { kind: "missing" };
      }
      return { kind: "invalid", detail: "line record cannot be inspected" };
    }
    if (!isRegularFile(target)) {
      return { kind: "invalid", detail: "line record is not a regular file" };
    }
    try {
      const parsed = JSON.parse(readFileSync(target, "utf8")) as unknown;
      if (!isValidLineEntry(parsed, name)) {
        return { kind: "invalid", detail: "line record has an invalid shape" };
      }
      return { kind: "present", entry: parsed };
    } catch {
      return { kind: "invalid", detail: "line record is not valid JSON" };
    }
  }

  private writeLine(entry: LineJournalEntry): void {
    const target = this.linePath(entry.name);
    const tmp = join(
      this.linesDir,
      `.${encodeURIComponent(entry.name)}.${process.pid}.${randomUUID()}.tmp`
    );
    writeFileSync(tmp, JSON.stringify(entry), { encoding: "utf8", flag: "wx" });
    renameSync(tmp, target);
  }

  private idempotencyDigest(input: LineAdvanceInput): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          name: input.name,
          scope: input.scope,
          expectedHead: input.expectedHead,
          expectedSequence: input.expectedSequence,
          newHead: input.newHead
        })
      )
      .digest("hex");
  }

  private readIdempotency(key: string): IdempotencyRecord | undefined {
    const target = join(this.idemDir, `${encodeURIComponent(key)}.json`);
    if (!existsSync(target)) {
      return undefined;
    }
    if (!isRegularFile(target)) {
      throw new Error(`loom: idempotency record for "${key}" is not a regular file`);
    }
    try {
      const parsed = JSON.parse(readFileSync(target, "utf8")) as Partial<IdempotencyRecord>;
      if (
        typeof parsed.digest !== "string" ||
        !/^[0-9a-f]{64}$/u.test(parsed.digest) ||
        !isValidLineEntry(parsed.entry, parsed.entry?.name)
      ) {
        throw new Error(`loom: idempotency record for "${key}" is invalid`);
      }
      return parsed as IdempotencyRecord;
    } catch {
      throw new Error(`loom: idempotency record for "${key}" is invalid`);
    }
  }

  private writeIdempotency(key: string, record: IdempotencyRecord): void {
    const target = join(this.idemDir, `${encodeURIComponent(key)}.json`);
    const tmp = join(
      this.idemDir,
      `.${encodeURIComponent(key)}.${process.pid}.${randomUUID()}.tmp`
    );
    writeFileSync(tmp, JSON.stringify(record), { encoding: "utf8", flag: "wx" });
    renameSync(tmp, target);
  }
}

function validateLineAdvanceInput(input: LineAdvanceInput): string | undefined {
  if (
    typeof input.name !== "string" ||
    input.name.length === 0 ||
    input.name.length > 256 ||
    input.name.includes("\u0000")
  ) {
    return "name must be a non-empty string of at most 256 characters";
  }
  if (input.scope !== "local" && input.scope !== "shared") {
    return "scope must be local or shared";
  }
  if (
    typeof input.expectedHead !== "string" ||
    input.expectedHead.length === 0 ||
    input.expectedHead.length > 256 ||
    typeof input.newHead !== "string" ||
    input.newHead.length === 0 ||
    input.newHead.length > 256
  ) {
    return "expectedHead and newHead must be non-empty strings of at most 256 characters";
  }
  if (
    !Number.isSafeInteger(input.expectedSequence) ||
    input.expectedSequence < 0 ||
    input.expectedSequence >= Number.MAX_SAFE_INTEGER
  ) {
    return "expectedSequence must be a non-negative safe integer";
  }
  if (
    input.idempotencyKey !== undefined &&
    (typeof input.idempotencyKey !== "string" ||
      input.idempotencyKey.length === 0 ||
      input.idempotencyKey.length > 256 ||
      input.idempotencyKey.includes("\u0000"))
  ) {
    return "idempotencyKey must be a non-empty string of at most 256 characters";
  }
  return undefined;
}

function isValidLineEntry(
  value: unknown,
  expectedName: string | undefined
): value is LineJournalEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.name === "string" &&
    (expectedName === undefined || entry.name === expectedName) &&
    (entry.scope === "local" || entry.scope === "shared") &&
    typeof entry.head === "string" &&
    entry.head.length > 0 &&
    entry.head.length <= 256 &&
    Number.isSafeInteger(entry.sequence) &&
    (entry.sequence as number) >= 0
  );
}

function isMatchingIdempotencyRecord(record: IdempotencyRecord, input: LineAdvanceInput): boolean {
  return (
    record.entry.name === input.name &&
    record.entry.head === input.newHead &&
    (record.entry.sequence === 0 || record.entry.sequence === input.expectedSequence + 1)
  );
}
