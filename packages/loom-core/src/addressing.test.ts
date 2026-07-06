import { describe, expect, it } from "vitest";
import {
  address,
  canonicalize,
  cellAddress,
  sha256Hex,
  stateAddress,
  verifyAddress
} from "./addressing.js";
import type { Cell, CellFacet, NodeIdent, State } from "./types.js";

// Known SHA-256 vectors (utf8 input), independently verified against
// node:crypto so they pin sha256Hex's exact digest, not just self-consistency.
const SHA256_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

function cellOf(ident: string, text: string, facet: CellFacet = "text"): Cell {
  return { facet, ident: ident as NodeIdent, text };
}

function stateOf(entries: ReadonlyArray<readonly [string, Cell]>): State {
  const cells: Record<string, Cell> = {};
  for (const [path, cell] of entries) {
    cells[path] = cell;
  }
  return { kind: "state", cells };
}

describe("canonicalize", () => {
  it("is key-order-insensitive at the top level", () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });

  it("sorts keys recursively so nested reorderings are equal", () => {
    expect(canonicalize({ outer: { x: 1, y: 2 }, z: 3 })).toBe(
      canonicalize({ z: 3, outer: { y: 2, x: 1 } })
    );
  });

  it("omits undefined-valued fields, matching optional-field omission", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("is deterministic for the same logical value", () => {
    const value = { facet: "text", ident: "nid:x", text: "hi" };
    expect(canonicalize(value)).toBe(canonicalize({ ...value }));
  });

  it("throws on top-level undefined", () => {
    expect(() => canonicalize(undefined)).toThrow();
  });

  it("throws on non-finite numbers (NaN and Infinity)", () => {
    expect(() => canonicalize(Number.NaN)).toThrow();
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => canonicalize(Number.NEGATIVE_INFINITY)).toThrow();
    // and when the non-finite value is nested inside an object
    expect(() => canonicalize({ n: Number.NaN })).toThrow();
  });
});

describe("sha256Hex", () => {
  it("matches known SHA-256 vectors", () => {
    expect(sha256Hex("")).toBe(SHA256_EMPTY);
    expect(sha256Hex("abc")).toBe(SHA256_ABC);
  });

  it("is deterministic for the same input", () => {
    expect(sha256Hex("loom")).toBe(sha256Hex("loom"));
  });
});

describe("address", () => {
  it("is stable across equal-but-reordered inputs", () => {
    expect(address({ a: 1, b: 2 })).toBe(address({ b: 2, a: 1 }));
  });

  it("has the loom:sha256 form derived from the canonical hash", () => {
    const value = { hello: "world" };
    expect(address(value)).toBe(`loom:sha256:${sha256Hex(canonicalize(value))}`);
  });

  it("is collision-sensitive: any change flips the Cid", () => {
    const base = address({ a: 1, b: 2 });
    expect(address({ a: 1, b: 3 })).not.toBe(base); // changed value
    expect(address({ a: 1, b: 2, c: 0 })).not.toBe(base); // added field
    expect(address({ a: 1 })).not.toBe(base); // removed field
  });
});

describe("cellAddress", () => {
  it("is stable for structurally identical cells", () => {
    expect(cellAddress(cellOf("nid:1", "hello"))).toBe(cellAddress(cellOf("nid:1", "hello")));
  });

  it("flips when any single field changes", () => {
    const base = cellAddress(cellOf("nid:1", "hello"));
    expect(cellAddress(cellOf("nid:1", "hello!"))).not.toBe(base); // text
    expect(cellAddress(cellOf("nid:2", "hello"))).not.toBe(base); // ident
    expect(cellAddress(cellOf("nid:1", "hello", "bytes"))).not.toBe(base); // facet
  });

  it("distinguishes presence and value of the optional mode field", () => {
    const bare = cellOf("nid:1", "hello");
    const withMode: Cell = { ...bare, mode: 0o644 };
    const withOtherMode: Cell = { ...bare, mode: 0o600 };
    expect(cellAddress(withMode)).not.toBe(cellAddress(bare)); // adding mode
    expect(cellAddress(withMode)).not.toBe(cellAddress(withOtherMode)); // differing mode
  });
});

describe("stateAddress", () => {
  it("is insensitive to cell insertion order (keys are canonically sorted)", () => {
    const a = cellOf("nid:a", "aaa");
    const b = cellOf("nid:b", "bbb");
    const s1 = stateOf([
      ["a.txt", a],
      ["b.txt", b]
    ]);
    const s2 = stateOf([
      ["b.txt", b],
      ["a.txt", a]
    ]);
    expect(stateAddress(s1)).toBe(stateAddress(s2));
  });

  it("flips when a cell's content or the cell set changes", () => {
    const a = cellOf("nid:a", "aaa");
    const b = cellOf("nid:b", "bbb");
    const base = stateOf([
      ["a.txt", a],
      ["b.txt", b]
    ]);
    const mutatedContent = stateOf([
      ["a.txt", cellOf("nid:a", "aaa!")],
      ["b.txt", b]
    ]);
    const removedCell = stateOf([["a.txt", a]]);
    expect(stateAddress(mutatedContent)).not.toBe(stateAddress(base));
    expect(stateAddress(removedCell)).not.toBe(stateAddress(base));
  });
});

describe("verifyAddress", () => {
  it("returns true when the value matches the Cid", () => {
    const cell = cellOf("nid:v", "payload");
    expect(verifyAddress(cellAddress(cell), cell)).toBe(true);
  });

  it("returns false after a single-field mutation", () => {
    const cell = cellOf("nid:v", "payload");
    const cid = cellAddress(cell);
    expect(verifyAddress(cid, cellOf("nid:v", "payload."))).toBe(false); // text
    expect(verifyAddress(cid, cellOf("nid:w", "payload"))).toBe(false); // ident
    expect(verifyAddress(cid, { ...cell, mode: 0o600 })).toBe(false); // added field
  });

  it("verifies whole-state addresses and rejects mutated states", () => {
    const state = stateOf([["a", cellOf("nid:a", "x")]]);
    const cid = stateAddress(state);
    expect(verifyAddress(cid, state)).toBe(true);
    expect(verifyAddress(cid, stateOf([["a", cellOf("nid:a", "y")]]))).toBe(false);
  });
});
