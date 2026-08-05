import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { storeBlob, loadBlob } from "./blob.js";
import { collectGarbage } from "./gc.js";
import { FileObjectStore } from "./store.js";
import type { Cid } from "./types.js";

function withStore(run: (store: FileObjectStore) => void): void {
  const root = mkdtempSync(join(tmpdir(), "loom-gc-"));
  try {
    run(new FileObjectStore(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("collectGarbage", () => {
  it("retains roots and their transitive references, collecting the rest", () => {
    withStore((store) => {
      const bytes = new TextEncoder().encode("some blob content");
      const manifestCid = storeBlob(store, bytes, { version: 1, algorithm: "fixed", chunkSize: 64 });
      const manifest = store.getDagCbor<{ chunks: Array<{ cid: string }> }>(manifestCid)!;
      const chunkCid = manifest.chunks[0]!.cid as Cid;

      // An unreachable object.
      const orphan = store.putRaw(new TextEncoder().encode("orphan"));

      // references() maps the manifest to its chunk.
      const references = (cid: Cid): readonly Cid[] => (cid === manifestCid ? [chunkCid] : []);
      const result = collectGarbage(store, [manifestCid], references);

      expect(result.collectedCids).toContain(orphan);
      expect(store.hasRaw(orphan)).toBe(false);
      // Manifest and its chunk are retained; the blob still loads.
      expect(store.hasDagCbor(manifestCid)).toBe(true);
      expect(store.hasRaw(chunkCid)).toBe(true);
      expect(loadBlob(store, manifestCid)).toEqual(bytes);
    });
  });

  it("collects everything when there are no roots", () => {
    withStore((store) => {
      store.putRaw(new TextEncoder().encode("a"));
      store.putRaw(new TextEncoder().encode("b"));
      const result = collectGarbage(store, [], () => []);
      expect(result.collected).toBe(2);
      expect(store.listCids()).toHaveLength(0);
    });
  });

  it("is idempotent: running again collects nothing new", () => {
    withStore((store) => {
      const cid = store.putRaw(new TextEncoder().encode("keep"));
      collectGarbage(store, [cid], () => []);
      const second = collectGarbage(store, [cid], () => []);
      expect(second.collected).toBe(0);
      expect(store.hasRaw(cid)).toBe(true);
    });
  });

  it("handles reference cycles without infinite loops", () => {
    withStore((store) => {
      const a = store.putRaw(new TextEncoder().encode("a"));
      const b = store.putRaw(new TextEncoder().encode("b"));
      // a references b, b references a (cycle).
      const references = (cid: Cid): readonly Cid[] =>
        cid === a ? [b] : cid === b ? [a] : [];
      const result = collectGarbage(store, [a], references);
      expect(store.hasRaw(a)).toBe(true);
      expect(store.hasRaw(b)).toBe(true);
      expect(result.collected).toBe(0);
    });
  });
});
