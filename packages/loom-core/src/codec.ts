/**
 * @agentforge/loom-core — canonical DAG-CBOR codec and CIDv1 addressing
 * (Phase 0 encoding foundation, spec §6.1).
 *
 * Normative structured objects are encoded as canonical DAG-CBOR; raw byte
 * chunks use the multicodec `raw` codec; object addresses are CIDv1 in
 * lowercase base32 text form with a SHA-256 multihash.
 *
 * The encoder is strict and deterministic: it produces exactly one byte
 * representation per logical object, sorts map keys canonically (length then
 * bytewise), rejects duplicate map keys, non-canonical integer/length
 * encodings, unsupported floats, and undefined. The decoder validates the same
 * canonical constraints so two implementations cannot hash or interpret an
 * object differently.
 *
 * This module is hermetic and dependency-free (no network, no ambient state).
 */

import { createHash } from "node:crypto";

import type { Cid } from "./types.js";

// ---- multicodec / multihash constants --------------------------------------

export const MULTICODEC = {
  /** Canonical structured objects. */
  dagCbor: 0x71,
  /** Raw byte chunks. */
  raw: 0x55
} as const;

export const MULTIHASH = {
  /** sha2-256, digest length 32. */
  sha2_256: 0x12
} as const;

export const CID_VERSION = 0x01;

// ---- base32 (RFC 4648, lowercase, no padding) ------------------------------

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const normalized = text.toLowerCase();
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of normalized) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value === -1) {
      throw new Error(`loom: invalid base32 character "${char}"`);
    }
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(bytes);
}

// ---- multihash --------------------------------------------------------------

/** Build a SHA-256 multihash: `0x12 0x20 <32-byte digest>`. */
export function sha256Multihash(bytes: Uint8Array): Uint8Array {
  const digest = createHash("sha256").update(bytes).digest();
  return Uint8Array.from([MULTIHASH.sha2_256, digest.length, ...digest]);
}

// ---- CIDv1 ------------------------------------------------------------------

/** Build a CIDv1 (version byte + codec + multihash) and return base32 text. */
export function cidV1(codec: number, bytes: Uint8Array): Cid {
  const multihash = sha256Multihash(bytes);
  const cidBytes = Uint8Array.from([CID_VERSION, codec, ...multihash]);
  return base32Encode(cidBytes) as Cid;
}

export function cidFromBytes(bytes: Uint8Array): Cid {
  return base32Encode(bytes) as Cid;
}

export interface ParsedCid {
  readonly version: number;
  readonly codec: number;
  readonly multihash: Uint8Array;
  readonly digest: Uint8Array;
}

/** Parse a CIDv1 base32 text form; returns undefined for malformed input. */
export function parseCid(text: string): ParsedCid | undefined {
  try {
    const bytes = base32Decode(text);
    if (bytes.length < 4) {
      return undefined;
    }
    const version = bytes[0]!;
    const codec = bytes[1]!;
    const hashCode = bytes[2]!;
    const hashLength = bytes[3]!;
    if (bytes.length !== 4 + hashLength) {
      return undefined;
    }
    const multihash = bytes.slice(2, 4 + hashLength);
    const digest = bytes.slice(4);
    return { version, codec, multihash, digest };
  } catch {
    return undefined;
  }
}

// ---- DAG-CBOR canonical encoding --------------------------------------------

class ByteWriter {
  private readonly chunks: number[] = [];

  push(byte: number): void {
    this.chunks.push(byte & 0xff);
  }

  pushBytes(bytes: Uint8Array): void {
    for (const byte of bytes) {
      this.chunks.push(byte & 0xff);
    }
  }

  pushHead(major: number, value: number): void {
    if (value < 24) {
      this.push((major << 5) | value);
    } else if (value <= 0xff) {
      this.push((major << 5) | 24);
      this.push(value);
    } else if (value <= 0xffff) {
      this.push((major << 5) | 25);
      this.push(value >>> 8);
      this.push(value & 0xff);
    } else if (value <= 0xffffffff) {
      this.push((major << 5) | 26);
      this.push((value >>> 24) & 0xff);
      this.push((value >>> 16) & 0xff);
      this.push((value >>> 8) & 0xff);
      this.push(value & 0xff);
    } else {
      this.push((major << 5) | 27);
      for (let i = 7; i >= 0; i--) {
        this.push(Number((BigInt(value) >> BigInt(i * 8)) & 0xffn));
      }
    }
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

function encodeInteger(writer: ByteWriter, value: number): void {
  if (value >= 0) {
    writer.pushHead(0, value);
  } else {
    writer.pushHead(1, -1 - value);
  }
}

function encodeString(writer: ByteWriter, value: string): void {
  const bytes = new TextEncoder().encode(value);
  writer.pushHead(3, bytes.length);
  writer.pushBytes(bytes);
}

function encodeBytes(writer: ByteWriter, value: Uint8Array): void {
  writer.pushHead(2, value.length);
  writer.pushBytes(value);
}

function encodeValue(writer: ByteWriter, value: unknown): void {
  if (value === null) {
    writer.push(0xf6);
    return;
  }
  if (value === true) {
    writer.push(0xf5);
    return;
  }
  if (value === false) {
    writer.push(0xf4);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error("loom: DAG-CBOR does not allow non-integer numbers");
    }
    encodeInteger(writer, value);
    return;
  }
  if (typeof value === "bigint") {
    if (value >= 0n) {
      if (value > 0xffffffffffffffffn) {
        throw new Error("loom: integer out of DAG-CBOR range");
      }
      writer.pushHead(0, Number(value));
    } else {
      const n = -1n - value;
      if (n > 0xffffffffffffffffn) {
        throw new Error("loom: integer out of DAG-CBOR range");
      }
      writer.pushHead(1, Number(n));
    }
    return;
  }
  if (typeof value === "string") {
    encodeString(writer, value);
    return;
  }
  if (value instanceof Uint8Array) {
    encodeBytes(writer, value);
    return;
  }
  if (Array.isArray(value)) {
    writer.pushHead(4, value.length);
    for (const item of value) {
      encodeValue(writer, item);
    }
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined
    );
    // Canonical map ordering: sort keys by length, then bytewise (RFC 8949).
    entries.sort(([a], [b]) => (a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0));
    writer.pushHead(5, entries.length);
    for (const [key, item] of entries) {
      encodeString(writer, key);
      encodeValue(writer, item);
    }
    return;
  }
  throw new Error(`loom: cannot DAG-CBOR encode value of type ${typeof value}`);
}

/** Canonically encode a value as DAG-CBOR bytes. */
export function encodeDagCbor(value: unknown): Uint8Array {
  const writer = new ByteWriter();
  encodeValue(writer, value);
  return writer.toBytes();
}

// ---- DAG-CBOR strict decoding ----------------------------------------------

class ByteReader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  readByte(): number {
    if (this.offset >= this.bytes.length) {
      throw new Error("loom: unexpected end of DAG-CBOR input");
    }
    return this.bytes[this.offset++]!;
  }

  readBytes(count: number): Uint8Array {
    if (this.offset + count > this.bytes.length) {
      throw new Error("loom: unexpected end of DAG-CBOR input");
    }
    const out = this.bytes.slice(this.offset, this.offset + count);
    this.offset += count;
    return out;
  }

  readLength(additional: number): number {
    if (additional < 24) {
      return additional;
    }
    if (additional === 24) {
      const value = this.readByte();
      if (value < 24) {
        throw new Error("loom: non-canonical integer encoding");
      }
      return value;
    }
    if (additional === 25) {
      const hi = this.readByte();
      const lo = this.readByte();
      const value = (hi << 8) | lo;
      if (value < 0x100) {
        throw new Error("loom: non-canonical integer encoding");
      }
      return value;
    }
    if (additional === 26) {
      let value = 0;
      for (let i = 0; i < 4; i++) {
        value = value * 256 + this.readByte();
      }
      if (value < 0x10000) {
        throw new Error("loom: non-canonical integer encoding");
      }
      return value;
    }
    if (additional === 27) {
      let value = 0n;
      for (let i = 0; i < 8; i++) {
        value = value * 256n + BigInt(this.readByte());
      }
      if (value < 0x100000000n) {
        throw new Error("loom: non-canonical integer encoding");
      }
      if (value > 0x7fffffffffffffffn) {
        throw new Error("loom: integer out of supported range");
      }
      return Number(value);
    }
    throw new Error(`loom: unsupported additional info ${additional}`);
  }
}

function decodeValue(reader: ByteReader): unknown {
  const initial = reader.readByte();
  const major = initial >>> 5;
  const additional = initial & 0x1f;

  switch (major) {
    case 0:
      return reader.readLength(additional);
    case 1:
      return -1 - reader.readLength(additional);
    case 2: {
      const length = reader.readLength(additional);
      return reader.readBytes(length);
    }
    case 3: {
      const length = reader.readLength(additional);
      return new TextDecoder().decode(reader.readBytes(length));
    }
    case 4: {
      const length = reader.readLength(additional);
      const out: unknown[] = [];
      for (let i = 0; i < length; i++) {
        out.push(decodeValue(reader));
      }
      return out;
    }
    case 5: {
      const length = reader.readLength(additional);
      const out: Record<string, unknown> = {};
      let previousKey: string | undefined;
      for (let i = 0; i < length; i++) {
        const key = decodeValue(reader);
        if (typeof key !== "string") {
          throw new Error("loom: DAG-CBOR map keys must be strings");
        }
        if (Object.prototype.hasOwnProperty.call(out, key)) {
          throw new Error(`loom: duplicate map key "${key}"`);
        }
        if (
          previousKey !== undefined &&
          !(previousKey.length < key.length || (previousKey.length === key.length && previousKey < key))
        ) {
          throw new Error("loom: map keys not in canonical order");
        }
        previousKey = key;
        out[key] = decodeValue(reader);
      }
      return out;
    }
    case 6:
      throw new Error("loom: unsupported CBOR tag");
    case 7:
      if (additional === 20) {
        return false;
      }
      if (additional === 21) {
        return true;
      }
      if (additional === 22) {
        return null;
      }
      throw new Error("loom: unsupported CBOR simple/float value");
    default:
      throw new Error(`loom: unsupported CBOR major type ${major}`);
  }
}

/** Strictly decode DAG-CBOR bytes, enforcing canonical form. */
export function decodeDagCbor(bytes: Uint8Array): unknown {
  const reader = new ByteReader(bytes);
  const value = decodeValue(reader);
  if (reader.remaining !== 0) {
    throw new Error("loom: trailing bytes after DAG-CBOR value");
  }
  return value;
}


