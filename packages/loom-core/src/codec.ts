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
export const MAX_DAG_CBOR_BYTES = 8 * 1024 * 1024;
export const MAX_DAG_CBOR_DEPTH = 64;
export const MAX_DAG_CBOR_CONTAINER_ENTRIES = 100_000;

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
  // RFC 4648 requires unused trailing bits to be zero. Without this check,
  // multiple spellings decode to the same bytes and malformed CIDs can pass
  // validation despite not being canonical.
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) {
    throw new Error("loom: non-zero base32 padding bits");
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
  if (!Number.isInteger(codec) || codec < 0 || codec > 0xff) {
    throw new Error("loom: codec must be an unsigned byte");
  }
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
    if (text.length === 0 || text.length > 128 || text !== text.toLowerCase()) {
      return undefined;
    }
    const bytes = base32Decode(text);
    if (bytes.length < 4) {
      return undefined;
    }
    const version = bytes[0]!;
    const codec = bytes[1]!;
    const hashCode = bytes[2]!;
    const hashLength = bytes[3]!;
    if (
      version !== CID_VERSION ||
      hashCode !== MULTIHASH.sha2_256 ||
      hashLength !== 32 ||
      bytes.length !== 4 + hashLength
    ) {
      return undefined;
    }
    const multihash = bytes.slice(2, 4 + hashLength);
    const digest = bytes.slice(4);
    return { version, codec, multihash, digest };
  } catch {
    return undefined;
  }
}

function encodeUtf8(value: string): Uint8Array {
  // TextEncoder replaces lone UTF-16 surrogates with U+FFFD. Rejecting them
  // keeps the encoder injective: decode(encode(value)) must not silently turn
  // an invalid JavaScript string into a different logical value.
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff || Number.isNaN(next)) {
        throw new Error("loom: cannot DAG-CBOR encode an unpaired UTF-16 surrogate");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("loom: cannot DAG-CBOR encode an unpaired UTF-16 surrogate");
    }
  }
  return new TextEncoder().encode(value);
}

function compareCanonicalText(a: string, b: string): number {
  const aBytes = encodeUtf8(a);
  const bBytes = encodeUtf8(b);
  if (aBytes.length !== bBytes.length) {
    return aBytes.length - bBytes.length;
  }
  for (let index = 0; index < aBytes.length; index += 1) {
    if (aBytes[index]! !== bBytes[index]!) {
      return aBytes[index]! - bBytes[index]!;
    }
  }
  return 0;
}

// ---- DAG-CBOR canonical encoding --------------------------------------------

class ByteWriter {
  private readonly chunks: number[] = [];

  push(byte: number): void {
    if (this.chunks.length >= MAX_DAG_CBOR_BYTES) {
      throw new Error("loom: DAG-CBOR output exceeds size limit");
    }
    this.chunks.push(byte & 0xff);
  }

  pushBytes(bytes: Uint8Array): void {
    if (this.chunks.length + bytes.length > MAX_DAG_CBOR_BYTES) {
      throw new Error("loom: DAG-CBOR output exceeds size limit");
    }
    for (const byte of bytes) {
      this.chunks.push(byte & 0xff);
    }
  }

  pushHead(major: number, value: number | bigint): void {
    const numeric = typeof value === "bigint" ? value : BigInt(value);
    if (numeric < 0n || numeric > 0xffffffffffffffffn) {
      throw new Error("loom: integer out of DAG-CBOR range");
    }
    if (numeric < 24n) {
      this.push((major << 5) | Number(numeric));
    } else if (numeric <= 0xffn) {
      this.push((major << 5) | 24);
      this.push(Number(numeric));
    } else if (numeric <= 0xffffn) {
      this.push((major << 5) | 25);
      this.push(Number((numeric >> 8n) & 0xffn));
      this.push(Number(numeric & 0xffn));
    } else if (numeric <= 0xffffffffn) {
      this.push((major << 5) | 26);
      for (let i = 3; i >= 0; i -= 1) {
        this.push(Number((numeric >> BigInt(i * 8)) & 0xffn));
      }
    } else {
      this.push((major << 5) | 27);
      for (let i = 7; i >= 0; i--) {
        this.push(Number((numeric >> BigInt(i * 8)) & 0xffn));
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
  const bytes = encodeUtf8(value);
  writer.pushHead(3, bytes.length);
  writer.pushBytes(bytes);
}

function encodeBytes(writer: ByteWriter, value: Uint8Array): void {
  writer.pushHead(2, value.length);
  writer.pushBytes(value);
}

function encodeValue(writer: ByteWriter, value: unknown, depth = 0): void {
  if (depth > MAX_DAG_CBOR_DEPTH) {
    throw new Error("loom: DAG-CBOR nesting exceeds depth limit");
  }
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
    if (!Number.isSafeInteger(value)) {
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
      writer.pushHead(0, value);
    } else {
      const n = -1n - value;
      if (n > 0xffffffffffffffffn) {
        throw new Error("loom: integer out of DAG-CBOR range");
      }
      writer.pushHead(1, n);
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
    if (value.length > MAX_DAG_CBOR_CONTAINER_ENTRIES) {
      throw new Error("loom: DAG-CBOR array exceeds entry limit");
    }
    writer.pushHead(4, value.length);
    for (const item of value) {
      encodeValue(writer, item, depth + 1);
    }
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined
    );
    // Canonical map ordering: sort keys by length, then bytewise (RFC 8949).
    entries.sort(([a], [b]) => compareCanonicalText(a, b));
    if (entries.length > MAX_DAG_CBOR_CONTAINER_ENTRIES) {
      throw new Error("loom: DAG-CBOR map exceeds entry limit");
    }
    writer.pushHead(5, entries.length);
    for (const [key, item] of entries) {
      encodeString(writer, key);
      encodeValue(writer, item, depth + 1);
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
    const value = this.readInteger(additional);
    if (typeof value === "bigint") {
      throw new Error("loom: integer out of supported range");
    }
    return value;
  }

  readInteger(additional: number): number | bigint {
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
      return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
    }
    throw new Error(`loom: unsupported additional info ${additional}`);
  }
}

function decodeValue(reader: ByteReader, depth = 0): unknown {
  if (depth > MAX_DAG_CBOR_DEPTH) {
    throw new Error("loom: DAG-CBOR nesting exceeds depth limit");
  }
  const initial = reader.readByte();
  const major = initial >>> 5;
  const additional = initial & 0x1f;

  switch (major) {
    case 0:
      return reader.readInteger(additional);
    case 1: {
      const value = reader.readInteger(additional);
      return typeof value === "bigint" ? -1n - value : -1 - value;
    }
    case 2: {
      const length = reader.readLength(additional);
      if (length > MAX_DAG_CBOR_BYTES) {
        throw new Error("loom: DAG-CBOR byte string exceeds size limit");
      }
      return reader.readBytes(length);
    }
    case 3: {
      const length = reader.readLength(additional);
      if (length > MAX_DAG_CBOR_BYTES) {
        throw new Error("loom: DAG-CBOR text string exceeds size limit");
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(reader.readBytes(length));
    }
    case 4: {
      const length = reader.readLength(additional);
      if (length > MAX_DAG_CBOR_CONTAINER_ENTRIES) {
        throw new Error("loom: DAG-CBOR array exceeds entry limit");
      }
      const out: unknown[] = [];
      for (let i = 0; i < length; i++) {
        out.push(decodeValue(reader, depth + 1));
      }
      return out;
    }
    case 5: {
      const length = reader.readLength(additional);
      if (length > MAX_DAG_CBOR_CONTAINER_ENTRIES) {
        throw new Error("loom: DAG-CBOR map exceeds entry limit");
      }
      // Decode into a null-prototype map so attacker-controlled keys cannot
      // trigger Object.prototype setters (notably `__proto__`) during the
      // assignment below or when the value is later merged by a caller.
      const out = Object.create(null) as Record<string, unknown>;
      let previousKey: string | undefined;
      for (let i = 0; i < length; i++) {
        const key = decodeValue(reader, depth + 1);
        if (typeof key !== "string") {
          throw new Error("loom: DAG-CBOR map keys must be strings");
        }
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new Error(`loom: unsafe DAG-CBOR map key "${key}"`);
        }
        if (Object.prototype.hasOwnProperty.call(out, key)) {
          throw new Error(`loom: duplicate map key "${key}"`);
        }
        if (previousKey !== undefined && compareCanonicalText(previousKey, key) >= 0) {
          throw new Error("loom: map keys not in canonical order");
        }
        previousKey = key;
        out[key] = decodeValue(reader, depth + 1);
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
  if (bytes.length > MAX_DAG_CBOR_BYTES) {
    throw new Error("loom: DAG-CBOR input exceeds size limit");
  }
  const reader = new ByteReader(bytes);
  const value = decodeValue(reader);
  if (reader.remaining !== 0) {
    throw new Error("loom: trailing bytes after DAG-CBOR value");
  }
  return value;
}
