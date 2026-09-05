/**
 * @agentforge/loom-core — binary-safe chunked objects (BlobManifest, spec §7.1).
 *
 * Large content is split into ordered chunks, each stored as a `raw`-codec
 * CIDv1 object; a DAG-CBOR `loom.blob` manifest commits to the total size, the
 * versioned chunking parameter set, and each chunk's CID and size. Small
 * content may be a single raw object. Chunk boundaries are a storage
 * optimization and never change the logical byte stream: `loadBlob` must
 * reproduce the exact original bytes or fail.
 *
 * Two versioned chunking algorithms are provided:
 * - `fixed`: deterministic fixed-size chunks (last chunk may be smaller).
 * - `cdc`: content-defined chunking via a buzhash rolling hash, so boundaries
 *   are stable across edits (a change only re-chunks the affected region).
 */

import type { Cid } from "./types.js";
import type { DurableObjectStore } from "./store.js";

export type ChunkAlgorithm = "fixed" | "cdc";

export interface ChunkingParams {
  readonly version: 1;
  readonly algorithm: ChunkAlgorithm;
  /** Target chunk size in bytes (the average for `cdc`). */
  readonly chunkSize: number;
}

export interface BlobChunk {
  readonly cid: Cid;
  readonly size: number;
}

export interface BlobManifest {
  readonly kind: "loom.blob";
  readonly schema: 1;
  readonly size: number;
  readonly params: ChunkingParams;
  readonly chunks: readonly BlobChunk[];
}

export const DEFAULT_CHUNK_SIZE = 65_536;

export const DEFAULT_CHUNKING: ChunkingParams = {
  version: 1,
  algorithm: "cdc",
  chunkSize: DEFAULT_CHUNK_SIZE
};

// Deterministic gear table for the buzhash rolling hash (256 entries).
const GEAR = buildGearTable();

function buildGearTable(): Uint8Array {
  const table = new Uint8Array(256);
  let state = 0x9e3779b9;
  for (let i = 0; i < 256; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    table[i] = state & 0xff;
  }
  return table;
}

// ---- chunking ---------------------------------------------------------------

export function chunkBytes(bytes: Uint8Array, params: ChunkingParams): Uint8Array[] {
  if (params.version !== 1) {
    throw new Error(`loom: unsupported chunking params version ${params.version}`);
  }
  if (!Number.isInteger(params.chunkSize) || params.chunkSize < 1) {
    throw new Error("loom: chunkSize must be a positive integer");
  }
  if (bytes.length === 0) {
    return [];
  }
  return params.algorithm === "fixed"
    ? fixedChunk(bytes, params.chunkSize)
    : cdcChunk(bytes, params.chunkSize);
}

function fixedChunk(bytes: Uint8Array, chunkSize: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let start = 0; start < bytes.length; start += chunkSize) {
    chunks.push(bytes.slice(start, start + chunkSize));
  }
  return chunks;
}

function cdcChunk(bytes: Uint8Array, targetSize: number): Uint8Array[] {
  const minSize = Math.max(1, Math.floor(targetSize / 4));
  const maxSize = targetSize * 4;
  const mask = nextPowerOfTwo(targetSize) - 1;
  const chunks: Uint8Array[] = [];
  let start = 0;
  let hash = 0;
  for (let i = 0; i < bytes.length; i++) {
    hash = ((hash << 1) + GEAR[bytes[i]!]!) >>> 0;
    const length = i - start + 1;
    if (length >= minSize && ((hash & mask) === 0 || length >= maxSize)) {
      chunks.push(bytes.slice(start, i + 1));
      start = i + 1;
      hash = 0;
    }
  }
  if (start < bytes.length) {
    chunks.push(bytes.slice(start));
  }
  return chunks;
}

function nextPowerOfTwo(value: number): number {
  let power = 1;
  while (power < value) {
    power *= 2;
  }
  return power;
}

// ---- store / load -----------------------------------------------------------

/** Store bytes as a chunked BlobManifest and return the manifest CID. */
export function storeBlob(
  store: DurableObjectStore,
  bytes: Uint8Array,
  params: ChunkingParams = DEFAULT_CHUNKING
): Cid {
  const chunks = chunkBytes(bytes, params);
  const chunkRefs: BlobChunk[] = chunks.map((chunk) => ({
    cid: store.putRaw(chunk),
    size: chunk.length
  }));
  const manifest: BlobManifest = {
    kind: "loom.blob",
    schema: 1,
    size: bytes.length,
    params,
    chunks: chunkRefs
  };
  return store.putDagCbor(manifest);
}

/**
 * Reconstruct the exact original bytes from a BlobManifest CID.
 * Verifies total size and chunk order; fails on any mismatch.
 */
export function loadBlob(store: DurableObjectStore, manifestCid: Cid): Uint8Array {
  const manifest = store.getDagCbor<BlobManifest>(manifestCid);
  if (!manifest || manifest.kind !== "loom.blob" || manifest.schema !== 1) {
    throw new Error(`loom: not a valid blob manifest at ${manifestCid}`);
  }
  const expectedSize = manifest.size;
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
    throw new Error("loom: blob manifest has an invalid total size");
  }

  const parts: Uint8Array[] = [];
  let total = 0;
  for (const chunk of manifest.chunks) {
    if (!Number.isSafeInteger(chunk.size) || chunk.size < 0) {
      throw new Error("loom: blob manifest has an invalid chunk size");
    }
    const bytes = store.getRaw(chunk.cid);
    if (bytes === undefined) {
      throw new Error(`loom: missing blob chunk ${chunk.cid}`);
    }
    if (bytes.length !== chunk.size) {
      throw new Error(
        `loom: chunk ${chunk.cid} size mismatch (declared ${chunk.size}, actual ${bytes.length})`
      );
    }
    parts.push(bytes);
    total += bytes.length;
  }

  if (total !== expectedSize) {
    throw new Error(`loom: blob total size mismatch (declared ${expectedSize}, actual ${total})`);
  }
  return concatBytes(parts);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
