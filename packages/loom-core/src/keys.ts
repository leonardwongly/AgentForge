/**
 * @agentforge/loom-core — persistent actor key lifecycle (Phase 1, spec §12.1).
 *
 * Tracks the public keys bound to each actor DID and their lifecycle:
 * register, rotate, and revoke. A key is identified by a content fingerprint
 * (SHA-256 of the public key bytes), so the same key always maps to the same
 * identity. Rotation requires the old key to be currently active; revocation
 * permanently disables a key. The registry is optionally file-backed for
 * persistence.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { FileLock } from "./lock.js";
import type { Did } from "./types.js";

export type KeyStatus = "active" | "revoked";

interface KeyRecord {
  readonly status: KeyStatus;
  readonly registeredAt: number;
}

type RegistryState = Record<string, Record<string, KeyRecord>>;

function fingerprint(publicKey: Uint8Array): string {
  return createHash("sha256").update(publicKey).digest("hex");
}

export class KeyRegistry {
  private state: RegistryState = Object.create(null) as RegistryState;

  constructor(private readonly file?: string) {
    this.reload();
  }

  /** Register a public key for an actor. Idempotent for an already-active key. */
  register(did: Did, publicKey: Uint8Array): void {
    this.withLockedMutation(() => {
      const key = fingerprint(publicKey);
      const actor = (this.state[did] ??= Object.create(null));
      if (actor[key]?.status === "revoked") {
        throw new Error(`loom: cannot re-register a revoked key for ${did}`);
      }
      actor[key] = { status: "active", registeredAt: Date.now() };
    });
  }

  /** Rotate from an active old key to a new key. Returns false if old is invalid. */
  rotate(did: Did, oldPublicKey: Uint8Array, newPublicKey: Uint8Array): boolean {
    return this.withLockedMutation(() => {
      const actor = this.state[did];
      const oldKey = fingerprint(oldPublicKey);
      if (!actor || actor[oldKey]?.status !== "active") return false;
      const newKey = fingerprint(newPublicKey);
      actor[oldKey] = { status: "revoked", registeredAt: actor[oldKey]!.registeredAt };
      actor[newKey] = { status: "active", registeredAt: Date.now() };
      return true;
    });
  }

  /** Revoke a key. Returns false if the key is not active. */
  revoke(did: Did, publicKey: Uint8Array): boolean {
    return this.withLockedMutation(() => {
      const actor = this.state[did];
      const key = fingerprint(publicKey);
      if (!actor || actor[key]?.status !== "active") return false;
      actor[key] = { status: "revoked", registeredAt: actor[key]!.registeredAt };
      return true;
    });
  }

  /** True if the key is currently active for the actor. */
  isValid(did: Did, publicKey: Uint8Array): boolean {
    return this.state[did]?.[fingerprint(publicKey)]?.status === "active";
  }

  /** The currently active key fingerprints for an actor. */
  activeKeys(did: Did): string[] {
    const actor = this.state[did];
    if (!actor) {
      return [];
    }
    return Object.entries(actor)
      .filter(([, record]) => record.status === "active")
      .map(([key]) => key);
  }

  private persist(): void {
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      const temp = join(
        dirname(this.file),
        `.${basename(this.file)}.${process.pid}.${randomUUID()}.tmp`
      );
      writeFileSync(temp, JSON.stringify(this.state), { encoding: "utf8", flag: "wx" });
      renameSync(temp, this.file);
    }
  }

  private reload(): void {
    if (!this.file || !existsSync(this.file)) return;
    if (statSync(this.file).size > 1_048_576) throw new Error("loom: key registry is too large");
    const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
    if (!isRecord(parsed)) throw new Error("loom: malformed key registry");
    const next = Object.create(null) as RegistryState;
    for (const [did, value] of Object.entries(parsed)) {
      if (!isRecord(value)) throw new Error("loom: malformed key registry actor");
      const actor = Object.create(null) as Record<string, KeyRecord>;
      for (const [key, record] of Object.entries(value)) {
        if (
          !isRecord(record) ||
          (record.status !== "active" && record.status !== "revoked") ||
          typeof record.registeredAt !== "number" ||
          !Number.isFinite(record.registeredAt)
        ) {
          throw new Error("loom: malformed key registry record");
        }
        actor[key] = { status: record.status, registeredAt: record.registeredAt };
      }
      next[did] = actor;
    }
    this.state = next;
  }

  private withLockedMutation<T>(mutation: () => T): T {
    if (!this.file) return mutation();
    const lock = new FileLock(dirname(this.file), `keys:${this.file}`);
    const release = lock.acquireSync();
    try {
      this.reload();
      const result = mutation();
      this.persist();
      return result;
    } finally {
      release();
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
