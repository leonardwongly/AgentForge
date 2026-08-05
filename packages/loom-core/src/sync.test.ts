import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { storeBlob, loadBlob } from "./blob.js";
import { FileObjectStore } from "./store.js";
import { replicate } from "./sync.js";

function withStores(run: (source: FileObjectStore, target: FileObjectStore) => void): void {
  const a = mkdtempSync(join(tmpdir(), "loom-sync-a-"));
  const b = mkdtempSync(join(tmpdir(), "loom-sync-b-"));
  try {
    run(new FileObjectStore(a), new FileObjectStore(b));
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
}

describe("replicate", () => {
  it("copies all object types to an empty target", () => {
    withStores((source, target) => {
      const rawCid = source.putRaw(new TextEncoder().encode("raw"));
      const dagCid = source.putDagCbor({ kind: "loom.state", schema: 1, x: 1 });
      const legacyCid = source.put({ a: 1 });

      const copied = replicate(source, target);
      expect(copied).toBe(3);
      expect(new Uint8Array(target.getRaw(rawCid)!)).toEqual(new TextEncoder().encode("raw"));
      expect(target.getDagCbor(dagCid)).toEqual({ kind: "loom.state", schema: 1, x: 1 });
      expect(target.get(legacyCid)).toEqual({ a: 1 });
    });
  });

  it("replicates a chunked blob so it loads at the target", () => {
    withStores((source, target) => {
      const bytes = new TextEncoder().encode("a blob spanning multiple chunks for replication");
      const manifestCid = storeBlob(source, bytes, { version: 1, algorithm: "fixed", chunkSize: 8 });
      replicate(source, target);
      expect(loadBlob(target, manifestCid)).toEqual(bytes);
    });
  });

  it("is idempotent: a second replicate copies nothing", () => {
    withStores((source, target) => {
      source.putRaw(new TextEncoder().encode("x"));
      const first = replicate(source, target);
      const second = replicate(source, target);
      expect(first).toBe(1);
      expect(second).toBe(0);
    });
  });

  it("only copies missing objects when the target already has some", () => {
    withStores((source, target) => {
      const sharedCid = source.putRaw(new TextEncoder().encode("shared"));
      target.putRaw(new TextEncoder().encode("shared")); // same content -> same CID
      source.putRaw(new TextEncoder().encode("only-in-source"));

      const copied = replicate(source, target);
      // The shared object is not copied again; only the new one is.
      expect(copied).toBe(1);
      expect(target.hasRaw(sharedCid)).toBe(true);
    });
  });
});
