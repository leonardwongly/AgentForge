import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { chunkBytes, DEFAULT_CHUNKING, loadBlob, storeBlob } from "./blob.js";
import { parseCid } from "./codec.js";
import { FileObjectStore } from "./store.js";

function withStore(run: (store: FileObjectStore) => void): void {
  const root = mkdtempSync(join(tmpdir(), "loom-blob-"));
  try {
    run(new FileObjectStore(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function randomBytes(length: number, seed = 1): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    bytes[i] = state & 0xff;
  }
  return bytes;
}

const FIXED = { version: 1, algorithm: "fixed", chunkSize: 64 } as const;
const CDC = { version: 1, algorithm: "cdc", chunkSize: 64 } as const;

describe("chunkBytes", () => {
  it("returns no chunks for empty input", () => {
    expect(chunkBytes(new Uint8Array(0), FIXED)).toEqual([]);
  });

  it("splits fixed-size input into equal chunks with a smaller tail", () => {
    const chunks = chunkBytes(randomBytes(150), FIXED);
    expect(chunks.length).toBe(3);
    expect(chunks[0]!.length).toBe(64);
    expect(chunks[1]!.length).toBe(64);
    expect(chunks[2]!.length).toBe(22);
  });

  it("concatenating chunks reproduces the original bytes", () => {
    const bytes = randomBytes(5000);
    for (const params of [FIXED, CDC]) {
      const chunks = chunkBytes(bytes, params);
      const rebuilt = new Uint8Array(bytes.length);
      let offset = 0;
      for (const chunk of chunks) {
        rebuilt.set(chunk, offset);
        offset += chunk.length;
      }
      expect(rebuilt).toEqual(bytes);
    }
  });

  it("rejects unsupported params version and non-positive chunk size", () => {
    expect(() => chunkBytes(new Uint8Array(10), { version: 2, algorithm: "fixed", chunkSize: 8 } as never)).toThrow(
      /unsupported chunking params/
    );
    expect(() => chunkBytes(new Uint8Array(10), { version: 1, algorithm: "fixed", chunkSize: 0 })).toThrow(
      /chunkSize/
    );
  });
});

describe("storeBlob / loadBlob", () => {
  it("round-trips small and large content for both algorithms", () => {
    withStore((store) => {
      for (const size of [0, 1, 63, 64, 65, 1000, 10_000]) {
        for (const params of [FIXED, CDC]) {
          const bytes = randomBytes(size, size + 1);
          const cid = storeBlob(store, bytes, params);
          expect(loadBlob(store, cid)).toEqual(bytes);
        }
      }
    });
  });

  it("is deterministic: identical bytes and params yield the same manifest CID", () => {
    withStore((store) => {
      const bytes = randomBytes(3000);
      const a = storeBlob(store, bytes, CDC);
      const b = storeBlob(store, bytes, CDC);
      expect(a).toBe(b);
    });
  });

  it("stores each chunk as a raw-codec object and the manifest as dag-cbor", () => {
    withStore((store) => {
      const bytes = randomBytes(300);
      const cid = storeBlob(store, bytes, FIXED);
      const parsed = parseCid(cid);
      expect(parsed?.codec).toBe(0x71); // dag-cbor
      expect(store.hasDagCbor(cid)).toBe(true);
      const manifest = store.getDagCbor<{ chunks: Array<{ cid: string }> }>(cid);
      for (const chunk of manifest?.chunks ?? []) {
        expect(parseCid(chunk.cid)?.codec).toBe(0x55); // raw
        expect(store.hasRaw(chunk.cid as never)).toBe(true);
      }
    });
  });

  it("fails when a chunk is missing", () => {
    withStore((store) => {
      const bytes = randomBytes(300);
      const cid = storeBlob(store, bytes, FIXED);
      const manifest = store.getDagCbor<{ chunks: Array<{ cid: string }> }>(cid)!;
      // Delete the first chunk.
      const firstChunk = manifest.chunks[0]!.cid;
      store.getRaw(firstChunk as never); // touch
      // Simulate a missing chunk by storing a manifest that references an absent one.
      const badManifest = { kind: "loom.blob", schema: 1, size: bytes.length, params: FIXED, chunks: [{ cid: "loom:sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as never, size: 64 }] };
      const badCid = store.putDagCbor(badManifest);
      expect(() => loadBlob(store, badCid)).toThrow(/missing blob chunk/);
    });
  });

  it("fails on a chunk size mismatch", () => {
    withStore((store) => {
      const bytes = randomBytes(300);
      const cid = storeBlob(store, bytes, FIXED);
      const manifest = store.getDagCbor<{ chunks: Array<{ cid: string; size: number }> }>(cid)!;
      const tampered = {
        ...manifest,
        chunks: manifest.chunks.map((c, i) => (i === 0 ? { ...c, size: c.size + 1 } : c))
      };
      const badCid = store.putDagCbor(tampered);
      expect(() => loadBlob(store, badCid)).toThrow(/size mismatch/);
    });
  });

  it("fails on a total size mismatch", () => {
    withStore((store) => {
      const bytes = randomBytes(300);
      const cid = storeBlob(store, bytes, FIXED);
      const manifest = store.getDagCbor<{ size: number }>(cid)!;
      const tampered = store.putDagCbor({ ...manifest, size: manifest.size + 1 });
      expect(() => loadBlob(store, tampered)).toThrow(/total size mismatch/);
    });
  });

  it("fails when the manifest CID does not reference a blob", () => {
    withStore((store) => {
      const cid = store.putDagCbor({ kind: "loom.state", schema: 1, space: "s", root: "r", identityIndex: "i" });
      expect(() => loadBlob(store, cid)).toThrow(/not a valid blob manifest/);
    });
  });

  it("keeps earlier chunk CIDs stable across an edit far from a boundary (CDC property)", () => {
    withStore((store) => {
      const bytes = randomBytes(10_000);
      const original = storeBlob(store, bytes, CDC);
      const originalManifest = store.getDagCbor<{ chunks: Array<{ cid: string }> }>(original)!;

      // Edit a byte near the end; the first chunk boundary should be unchanged.
      const edited = bytes.slice();
      edited[edited.length - 1] = (edited[edited.length - 1]! + 1) & 0xff;
      const editedCid = storeBlob(store, edited, CDC);
      const editedManifest = store.getDagCbor<{ chunks: Array<{ cid: string }> }>(editedCid)!;

      // The first chunk must be identical (content-defined boundaries).
      expect(editedManifest.chunks[0]!.cid).toBe(originalManifest.chunks[0]!.cid);
    });
  });
});
