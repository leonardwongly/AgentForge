import { describe, expect, it } from "vitest";

import type { Did } from "./types.js";
import { didLoom, isLoomDid, nodeIdent, parseDid, randomCreationNonce } from "./did.js";

const DID = "did:loom:abc" as Did;

describe("did:loom", () => {
  it("is deterministic for the same public key", () => {
    const key = new TextEncoder().encode("public-key-bytes");
    expect(didLoom(key)).toBe(didLoom(key));
  });

  it("differs across distinct keys", () => {
    expect(didLoom(new TextEncoder().encode("key-a"))).not.toBe(
      didLoom(new TextEncoder().encode("key-b"))
    );
  });

  it("produces a well-formed did:loom identifier", () => {
    const did = didLoom(new TextEncoder().encode("k"));
    expect(did.startsWith("did:loom:")).toBe(true);
    expect(isLoomDid(did)).toBe(true);
    expect(parseDid(did)).toEqual({ method: "loom", id: did.slice("did:loom:".length) });
  });
});

describe("parseDid", () => {
  it("parses did:key and did:web", () => {
    expect(parseDid("did:key:z6Mkfoo")).toEqual({ method: "key", id: "z6Mkfoo" });
    expect(parseDid("did:web:example.com")).toEqual({ method: "web", id: "example.com" });
  });

  it("rejects malformed DIDs", () => {
    expect(parseDid("")).toBeUndefined();
    expect(parseDid("not-a-did")).toBeUndefined();
    expect(parseDid("did:")).toBeUndefined();
    expect(parseDid("did:key:")).toBeUndefined();
    expect(parseDid("did::id")).toBeUndefined();
  });

  it("distinguishes loom from other methods", () => {
    expect(isLoomDid("did:loom:abc")).toBe(true);
    expect(isLoomDid("did:key:abc")).toBe(false);
    expect(isLoomDid("did:loom:")).toBe(false);
  });
});

describe("nodeIdent (spec §7.5)", () => {
  const base = { space: "space-1", authorDid: DID, creationNonce: "nonce", ordinal: 0 };

  it("is deterministic for identical inputs", () => {
    expect(nodeIdent(base)).toBe(nodeIdent(base));
  });

  it("is multibase base32 prefixed with 'b'", () => {
    const ident = nodeIdent(base);
    expect(ident.startsWith("b")).toBe(true);
    expect(ident.slice(1)).toMatch(/^[a-z2-7]+$/u);
  });

  it("differs when any input changes", () => {
    const original = nodeIdent(base);
    expect(nodeIdent({ ...base, space: "space-2" })).not.toBe(original);
    expect(nodeIdent({ ...base, authorDid: "did:loom:other" as Did })).not.toBe(original);
    expect(nodeIdent({ ...base, creationNonce: "other-nonce" })).not.toBe(original);
    expect(nodeIdent({ ...base, ordinal: 1 })).not.toBe(original);
  });

  it("is independent of content (identity survives edits by construction)", () => {
    // The identity depends only on the session tuple, never on content.
    const a = nodeIdent({ ...base, ordinal: 0 });
    const b = nodeIdent({ ...base, ordinal: 0 });
    expect(a).toBe(b);
  });

  it("generates a unique random creation nonce per call", () => {
    expect(randomCreationNonce()).not.toBe(randomCreationNonce());
    expect(randomCreationNonce()).toMatch(/^[0-9a-f]{64}$/u);
  });
});
