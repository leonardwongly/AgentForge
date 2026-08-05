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

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
  private state: RegistryState = {};

  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      this.state = JSON.parse(readFileSync(file, "utf8")) as RegistryState;
    }
  }

  /** Register a public key for an actor. Idempotent for an already-active key. */
  register(did: Did, publicKey: Uint8Array): void {
    const key = fingerprint(publicKey);
    const actor = (this.state[did] ??= {});
    if (actor[key]?.status === "revoked") {
      throw new Error(`loom: cannot re-register a revoked key for ${did}`);
    }
    actor[key] = { status: "active", registeredAt: Date.now() };
    this.persist();
  }

  /** Rotate from an active old key to a new key. Returns false if old is invalid. */
  rotate(did: Did, oldPublicKey: Uint8Array, newPublicKey: Uint8Array): boolean {
    const actor = this.state[did];
    const oldKey = fingerprint(oldPublicKey);
    if (!actor || actor[oldKey]?.status !== "active") {
      return false;
    }
    const newKey = fingerprint(newPublicKey);
    actor[oldKey] = { status: "revoked", registeredAt: actor[oldKey]!.registeredAt };
    actor[newKey] = { status: "active", registeredAt: Date.now() };
    this.persist();
    return true;
  }

  /** Revoke a key. Returns false if the key is not active. */
  revoke(did: Did, publicKey: Uint8Array): boolean {
    const actor = this.state[did];
    const key = fingerprint(publicKey);
    if (!actor || actor[key]?.status !== "active") {
      return false;
    }
    actor[key] = { status: "revoked", registeredAt: actor[key]!.registeredAt };
    this.persist();
    return true;
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
      writeFileSync(this.file, JSON.stringify(this.state), "utf8");
    }
  }
}
