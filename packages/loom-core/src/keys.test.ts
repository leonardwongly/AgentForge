import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Did } from "./types.js";
import { KeyRegistry } from "./keys.js";

const DID = "did:loom:actor" as Did;

function key(seed: number): Uint8Array {
  return new TextEncoder().encode(`public-key-${seed}`);
}

describe("KeyRegistry (key lifecycle)", () => {
  it("registers and validates a key", () => {
    const registry = new KeyRegistry();
    registry.register(DID, key(1));
    expect(registry.isValid(DID, key(1))).toBe(true);
    expect(registry.isValid(DID, key(2))).toBe(false);
    expect(registry.activeKeys(DID)).toHaveLength(1);
  });

  it("rotates from an active key to a new one", () => {
    const registry = new KeyRegistry();
    registry.register(DID, key(1));
    expect(registry.rotate(DID, key(1), key(2))).toBe(true);
    expect(registry.isValid(DID, key(1))).toBe(false);
    expect(registry.isValid(DID, key(2))).toBe(true);
  });

  it("refuses to rotate from an invalid old key", () => {
    const registry = new KeyRegistry();
    registry.register(DID, key(1));
    expect(registry.rotate(DID, key(9), key(2))).toBe(false);
    expect(registry.isValid(DID, key(1))).toBe(true);
  });

  it("revokes a key permanently", () => {
    const registry = new KeyRegistry();
    registry.register(DID, key(1));
    expect(registry.revoke(DID, key(1))).toBe(true);
    expect(registry.isValid(DID, key(1))).toBe(false);
    // Cannot re-register a revoked key.
    expect(() => registry.register(DID, key(1))).toThrow(/revoked/);
  });

  it("refuses to revoke an inactive key", () => {
    const registry = new KeyRegistry();
    registry.register(DID, key(1));
    expect(registry.revoke(DID, key(2))).toBe(false);
  });

  it("persists across reloads when file-backed", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-keys-"));
    const file = join(dir, "registry.json");
    try {
      const registry = new KeyRegistry(file);
      registry.register(DID, key(1));
      const reloaded = new KeyRegistry(file);
      expect(reloaded.isValid(DID, key(1))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
