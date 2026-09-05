import { describe, expect, it } from "vitest";

import {
  MULTICODEC,
  MULTIHASH,
  MAX_DAG_CBOR_BYTES,
  base32Decode,
  base32Encode,
  cidV1,
  decodeDagCbor,
  encodeDagCbor,
  parseCid,
  sha256Multihash
} from "./codec.js";

describe("base32 (RFC 4648 lowercase, no padding)", () => {
  it("round-trips bytes", () => {
    const bytes = Uint8Array.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x80]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });

  it("encodes the empty input to the empty string", () => {
    expect(base32Encode(new Uint8Array(0))).toBe("");
  });

  it("matches a known RFC 4648 vector", () => {
    // "foobar" -> "mzxw6ytboi" (lowercase, no padding)
    expect(base32Encode(new TextEncoder().encode("foobar"))).toBe("mzxw6ytboi");
  });

  it("rejects invalid base32 characters", () => {
    expect(() => base32Decode("abc!")).toThrow(/invalid base32/);
  });

  it("rejects non-zero unused padding bits", () => {
    expect(() => base32Decode("ab")).toThrow(/padding bits/);
    expect(base32Decode("aa")).toEqual(new Uint8Array([0]));
  });
});

describe("multihash and CIDv1", () => {
  it("builds a SHA-256 multihash with the correct prefix", () => {
    const mh = sha256Multihash(new TextEncoder().encode("hello"));
    expect(mh[0]).toBe(MULTIHASH.sha2_256);
    expect(mh[1]).toBe(32);
    expect(mh.length).toBe(34);
  });

  it("produces a lowercase base32 CIDv1 that parses back", () => {
    const bytes = new TextEncoder().encode("loom object");
    const cid = cidV1(MULTICODEC.dagCbor, bytes);
    expect(cid).toMatch(/^[a-z2-7]+$/u);
    const parsed = parseCid(cid);
    expect(parsed).toBeDefined();
    expect(parsed?.version).toBe(1);
    expect(parsed?.codec).toBe(MULTICODEC.dagCbor);
    expect(parsed?.multihash[0]).toBe(MULTIHASH.sha2_256);
    expect(parsed?.digest).toEqual(sha256Multihash(bytes).slice(2));
  });

  it("is deterministic: identical bytes yield the identical CID", () => {
    const bytes = new TextEncoder().encode("same content");
    expect(cidV1(MULTICODEC.raw, bytes)).toBe(cidV1(MULTICODEC.raw, bytes));
  });

  it("distinguishes codecs and content", () => {
    const bytes = new TextEncoder().encode("x");
    expect(cidV1(MULTICODEC.raw, bytes)).not.toBe(cidV1(MULTICODEC.dagCbor, bytes));
    expect(cidV1(MULTICODEC.raw, new TextEncoder().encode("x"))).not.toBe(
      cidV1(MULTICODEC.raw, new TextEncoder().encode("y"))
    );
  });

  it("returns undefined for malformed CIDs", () => {
    expect(parseCid("")).toBeUndefined();
    expect(parseCid("a")).toBeUndefined();
    expect(parseCid("!!notbase32!!")).toBeUndefined();
    expect(parseCid("abc")).toBeUndefined();
  });
});

describe("DAG-CBOR canonical encoding", () => {
  it("round-trips scalars, arrays, maps, and byte strings", () => {
    const value = {
      kind: "loom.cell",
      schema: 1,
      ident: "n1",
      size: 42,
      flag: true,
      none: null,
      bytes: new TextEncoder().encode("raw bytes"),
      list: [1, 2, 3],
      nested: { a: 1 }
    };
    const decoded = decodeDagCbor(encodeDagCbor(value)) as Record<string, unknown>;
    expect(decoded.kind).toBe("loom.cell");
    expect(decoded.schema).toBe(1);
    expect(decoded.size).toBe(42);
    expect(decoded.flag).toBe(true);
    expect(decoded.none).toBeNull();
    expect(decoded.bytes).toEqual(new TextEncoder().encode("raw bytes"));
    expect(decoded.list).toEqual([1, 2, 3]);
    expect(decoded.nested).toEqual({ a: 1 });
  });

  it("is deterministic: same object -> same bytes regardless of key insertion order", () => {
    const a = { b: 1, a: 2, c: 3 };
    const b = { c: 3, a: 2, b: 1 };
    expect(encodeDagCbor(a)).toEqual(encodeDagCbor(b));
  });

  it("sorts map keys by length then bytewise (RFC 8949 canonical)", () => {
    // "b" (len 1) sorts before "aa" (len 2), even though "aa" < "b" bytewise.
    const encoded = encodeDagCbor({ aa: 1, b: 2 });
    const decoded = decodeDagCbor(encoded) as Record<string, unknown>;
    expect(decoded).toEqual({ aa: 1, b: 2 });
    // Keys are emitted in canonical order: b (len1) then aa (len2).
    const hex = [...encoded].map((x) => x.toString(16).padStart(2, "0")).join("");
    // map(2) 0xa2, "b" 0x61 0x62, 2 0x02, "aa" 0x62 0x61 0x61, 1 0x01.
    expect(hex).toBe("a261620262616101");
  });

  it("encodes negative integers canonically", () => {
    expect(decodeDagCbor(encodeDagCbor(-1))).toBe(-1);
    expect(decodeDagCbor(encodeDagCbor(-100))).toBe(-100);
  });

  it("preserves byte strings exactly (including zero bytes)", () => {
    const bytes = Uint8Array.from([0, 1, 2, 255, 0]);
    expect(decodeDagCbor(encodeDagCbor(bytes))).toEqual(bytes);
  });

  it("rejects non-integer numbers (floats are not allowed in DAG-CBOR)", () => {
    expect(() => encodeDagCbor(1.5)).toThrow(/non-integer/);
    expect(() => encodeDagCbor(Number.NaN)).toThrow(/non-integer/);
    expect(() => encodeDagCbor(Number.POSITIVE_INFINITY)).toThrow(/non-integer/);
    expect(() => encodeDagCbor(Number.MAX_SAFE_INTEGER + 1)).toThrow(/non-integer/);
  });

  it("bounds nesting and container cardinality", () => {
    let nested: unknown = null;
    for (let depth = 0; depth < 66; depth += 1) {
      nested = [nested];
    }
    expect(() => encodeDagCbor(nested)).toThrow(/nesting exceeds depth/);
    expect(() => encodeDagCbor(Array.from({ length: 100_001 }, () => null))).toThrow(
      /array exceeds entry/
    );
  });

  it("bounds encoded string and byte-string payloads", () => {
    expect(() => encodeDagCbor("x".repeat(MAX_DAG_CBOR_BYTES))).toThrow(/size limit/);
    expect(() => encodeDagCbor(new Uint8Array(MAX_DAG_CBOR_BYTES))).toThrow(/size limit/);
  });

  it("rejects undefined values", () => {
    expect(() => encodeDagCbor({ a: undefined })).not.toThrow(); // omitted
    expect(() => encodeDagCbor(undefined)).toThrow(/cannot DAG-CBOR encode/);
  });
});

describe("DAG-CBOR strict decoding", () => {
  it("rejects trailing bytes", () => {
    const bytes = encodeDagCbor({ a: 1 });
    const padded = Uint8Array.from([...bytes, 0x00]);
    expect(() => decodeDagCbor(padded)).toThrow(/trailing bytes/);
  });

  it("rejects duplicate map keys", () => {
    // a2 (map 2) 61 61 "a" 01 61 61 "a" 02
    const bytes = Uint8Array.from([0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02]);
    expect(() => decodeDagCbor(bytes)).toThrow(/duplicate map key/);
  });

  it("rejects non-canonical integer encodings", () => {
    // 0x18 0x01 encodes 1 but should be the single byte 0x01.
    const bytes = Uint8Array.from([0x18, 0x01]);
    expect(() => decodeDagCbor(bytes)).toThrow(/non-canonical integer/);
  });

  it("rejects non-string map keys", () => {
    // a1 (map 1) 01 (int key) 02
    const bytes = Uint8Array.from([0xa1, 0x01, 0x02]);
    expect(() => decodeDagCbor(bytes)).toThrow(/map keys must be strings/);
  });

  it("rejects prototype-polluting map keys", () => {
    const key = new TextEncoder().encode("__proto__");
    const bytes = Uint8Array.from([0xa1, 0x60 + key.length, ...key, 0x01]);
    expect(() => decodeDagCbor(bytes)).toThrow(/unsafe DAG-CBOR map key/);
  });

  it("rejects unsupported CBOR tags and floats", () => {
    // 0xc1 = tag(1)
    expect(() => decodeDagCbor(Uint8Array.from([0xc1, 0x00]))).toThrow(/unsupported CBOR tag/);
    // 0xf9 0x3c 0x00 = half-precision float
    expect(() => decodeDagCbor(Uint8Array.from([0xf9, 0x3c, 0x00]))).toThrow(/unsupported/);
  });

  it("rejects truncated input", () => {
    // array(1) with no element.
    expect(() => decodeDagCbor(Uint8Array.from([0x81]))).toThrow(/unexpected end/);
    // byte string of length 256 with no content bytes.
    expect(() => decodeDagCbor(Uint8Array.from([0x59, 0x01, 0x00]))).toThrow(/unexpected end/);
  });

  it("rejects oversized declared containers and invalid UTF-8", () => {
    // array(100001) with no elements: the entry limit must fire before iteration.
    expect(() => decodeDagCbor(Uint8Array.from([0x9a, 0x00, 0x01, 0x86, 0xa1]))).toThrow(
      /array exceeds entry/
    );
    expect(() => decodeDagCbor(Uint8Array.from([0x63, 0xed, 0xa0, 0x80]))).toThrow();
  });

  it("rejects map keys not in canonical order", () => {
    // a2 "aa" then "b" — wrong order (should be "b" then "aa").
    const bytes = Uint8Array.from([0xa2, 0x62, 0x61, 0x61, 0x01, 0x61, 0x62, 0x02]);
    expect(() => decodeDagCbor(bytes)).toThrow(/not in canonical order/);
  });
});

describe("fuzzed round-trip (Phase 1 exit evidence)", () => {
  // A deterministic PRNG so the fuzz corpus is reproducible.
  let state = 0x12345678;
  const rand = (): number => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 0xffffffff;
  };
  const randInt = (): number => Math.floor(rand() * 1000) - 500;
  const randString = (): string => {
    const chars = "abcXYZ0123_-/";
    let out = "";
    const len = Math.floor(rand() * 20);
    for (let i = 0; i < len; i++) {
      out += chars[Math.floor(rand() * chars.length)];
    }
    return out;
  };
  const randValue = (depth = 0): unknown => {
    const kind = Math.floor(rand() * 6);
    if (kind === 0) return randInt();
    if (kind === 1) return randString();
    if (kind === 2) return rand() < 0.5;
    if (kind === 3) return null;
    if (kind === 4) {
      const len = Math.floor(rand() * 5);
      return Array.from({ length: len }, () => randValue(depth + 1));
    }
    const obj: Record<string, unknown> = {};
    const len = Math.floor(rand() * 5);
    for (let i = 0; i < len; i++) {
      obj[randString()] = randValue(depth + 1);
    }
    return obj;
  };

  it("round-trips and stays deterministic across many random values", () => {
    for (let i = 0; i < 500; i++) {
      const value = randValue();
      const encoded = encodeDagCbor(value);
      // Determinism: encoding twice yields identical bytes.
      expect(encodeDagCbor(value)).toEqual(encoded);
      // Round-trip: decode(encode(v)) equals v (undefined fields dropped).
      expect(decodeDagCbor(encoded)).toEqual(value);
    }
  });
});
