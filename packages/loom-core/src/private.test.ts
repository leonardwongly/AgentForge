import { describe, expect, it } from "vitest";

import { decryptPrivate, encryptPrivate } from "./private.js";

const KEY = new TextEncoder().encode("0123456789abcdef0123456789abcdef"); // 32 bytes

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("private-object encryption-at-rest", () => {
  it("round-trips plaintext through encryption and decryption", () => {
    const plaintext = bytes("sensitive file content");
    const envelope = encryptPrivate(plaintext, KEY);
    expect(decryptPrivate(envelope, KEY)).toEqual(plaintext);
  });

  it("is deterministic: identical plaintext + key yields an identical envelope (dedup)", () => {
    const plaintext = bytes("same content");
    const a = encryptPrivate(plaintext, KEY);
    const b = encryptPrivate(plaintext, KEY);
    expect(a.iv).toEqual(b.iv);
    expect(a.ciphertext).toEqual(b.ciphertext);
  });

  it("produces different ciphertext under a different key", () => {
    const otherKey = bytes("fedcba9876543210fedcba9876543210");
    const plaintext = bytes("content");
    expect(encryptPrivate(plaintext, KEY).ciphertext).not.toEqual(
      encryptPrivate(plaintext, otherKey).ciphertext
    );
  });

  it("does not leak plaintext in the envelope", () => {
    const plaintext = bytes("super-secret-value");
    const envelope = encryptPrivate(plaintext, KEY);
    const joined = new TextEncoder().encode(
      JSON.stringify([...envelope.iv, ...envelope.ciphertext])
    );
    expect(joined.includes(plaintext[0]!)).toBe(false);
    // The envelope is not simply the plaintext.
    expect(envelope.ciphertext).not.toEqual(plaintext);
  });

  it("fails decryption on a tampered ciphertext (GCM auth)", () => {
    const plaintext = bytes("authenticated content");
    const envelope = encryptPrivate(plaintext, KEY);
    const tampered = {
      ...envelope,
      ciphertext: Uint8Array.from([...envelope.ciphertext.slice(0, -1), envelope.ciphertext.at(-1)! ^ 1])
    };
    expect(() => decryptPrivate(tampered, KEY)).toThrow();
  });

  it("fails decryption with the wrong key", () => {
    const plaintext = bytes("content");
    const envelope = encryptPrivate(plaintext, KEY);
    const wrongKey = bytes("fedcba9876543210fedcba9876543210");
    expect(() => decryptPrivate(envelope, wrongKey)).toThrow();
  });

  it("rejects keys that are not 32 bytes and malformed envelopes", () => {
    const shortKey = bytes("short");
    expect(() => encryptPrivate(bytes("x"), shortKey)).toThrow(/32 bytes/);
    const envelope = encryptPrivate(bytes("x"), KEY);
    expect(() => decryptPrivate({ ...envelope, version: 99 as never }, KEY)).toThrow(/version/);
    expect(() => decryptPrivate({ ...envelope, iv: bytes("too-short") }, KEY)).toThrow(
      /malformed/
    );
  });
});
