import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GrantRevocationRegistry } from "./revocation.js";

describe("GrantRevocationRegistry", () => {
  it("revokes a grant and reports it as revoked", () => {
    const registry = new GrantRevocationRegistry();
    expect(registry.isRevoked("g1")).toBe(false);
    registry.revoke("g1");
    expect(registry.isRevoked("g1")).toBe(true);
  });

  it("is idempotent for repeated revocations", () => {
    const registry = new GrantRevocationRegistry();
    registry.revoke("g1");
    registry.revoke("g1");
    expect(registry.isRevoked("g1")).toBe(true);
  });

  it("filters revoked grants out of a chain, preserving order", () => {
    const registry = new GrantRevocationRegistry();
    registry.revoke("g2");
    const chain = [{ id: "g1" }, { id: "g2" }, { id: "g3" }];
    expect(registry.filterActive(chain).map((g) => g.id)).toEqual(["g1", "g3"]);
  });

  it("persists across reloads when file-backed", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-revoke-"));
    const file = join(dir, "registry.json");
    try {
      const registry = new GrantRevocationRegistry(file);
      registry.revoke("g1");
      const reloaded = new GrantRevocationRegistry(file);
      expect(reloaded.isRevoked("g1")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
