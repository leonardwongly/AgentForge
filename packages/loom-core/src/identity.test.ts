import { describe, expect, it } from "vitest";
import { cellAddress } from "./addressing.js";
import { applyOps } from "./algebra.js";
import { deriveIdentityIndex, emptyState, mintNodeIdent, resolveSelector } from "./identity.js";
import type { ApplyResult, Cell, CellFacet, Cid, NodeIdent, Op, State } from "./types.js";

// Fixed, deterministic transform Cids used to mint identities. Their exact hash
// content is irrelevant; only that they are stable and distinct from each other.
const TX_A = "loom:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Cid;
const TX_B = "loom:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Cid;

function cellOf(ident: NodeIdent, text: string, facet: CellFacet = "text"): Cell {
  return { facet, ident, text };
}

function stateOf(entries: ReadonlyArray<readonly [string, Cell]>): State {
  const cells: Record<string, Cell> = {};
  for (const [path, cell] of entries) {
    cells[path] = cell;
  }
  return { kind: "state", cells };
}

function expectApplied(result: ApplyResult): State {
  if (!result.ok) {
    throw new Error(`expected applyOps to succeed: ${result.error.detail}`);
  }
  return result.state;
}

function requireCell(state: State, path: string): Cell {
  const cell = state.cells[path];
  if (cell === undefined) {
    throw new Error(`expected a cell at ${path}`);
  }
  return cell;
}

describe("emptyState", () => {
  it("is a state with no cells", () => {
    const state = emptyState();
    expect(state.kind).toBe("state");
    expect(Object.keys(state.cells)).toHaveLength(0);
  });
});

describe("mintNodeIdent", () => {
  it("is deterministic for the same (transform, ordinal, path)", () => {
    expect(mintNodeIdent(TX_A, 0, "src/a.ts")).toBe(mintNodeIdent(TX_A, 0, "src/a.ts"));
  });

  it("produces the nid: prefix and a fixed-width digest slice", () => {
    const nid = mintNodeIdent(TX_A, 0, "src/a.ts");
    expect(nid.startsWith("nid:")).toBe(true);
    expect(nid.slice("nid:".length)).toHaveLength(32);
  });

  it("is distinct across transform, ordinal, and path", () => {
    const baseline = mintNodeIdent(TX_A, 0, "src/a.ts");
    expect(mintNodeIdent(TX_B, 0, "src/a.ts")).not.toBe(baseline); // transform differs
    expect(mintNodeIdent(TX_A, 1, "src/a.ts")).not.toBe(baseline); // ordinal differs
    expect(mintNodeIdent(TX_A, 0, "src/b.ts")).not.toBe(baseline); // path differs
  });
});

describe("deriveIdentityIndex", () => {
  it("maps every cell's nid to its current path", () => {
    const idA = mintNodeIdent(TX_A, 0, "a.ts");
    const idB = mintNodeIdent(TX_A, 1, "b.ts");
    const idC = mintNodeIdent(TX_A, 2, "c.ts");
    const state = stateOf([
      ["a.ts", cellOf(idA, "aaa")],
      ["b.ts", cellOf(idB, "bbb")],
      ["c.ts", cellOf(idC, "ccc")]
    ]);
    const index = deriveIdentityIndex(state);
    expect(index.size).toBe(3);
    expect(index.get(idA)).toBe("a.ts");
    expect(index.get(idB)).toBe("b.ts");
    expect(index.get(idC)).toBe("c.ts");
  });

  it("has no entry for an ident that is not present", () => {
    const idA = mintNodeIdent(TX_A, 0, "a.ts");
    const absent = mintNodeIdent(TX_B, 9, "z.ts");
    const index = deriveIdentityIndex(stateOf([["a.ts", cellOf(idA, "aaa")]]));
    expect(index.get(absent)).toBeUndefined();
  });
});

describe("resolveSelector", () => {
  it("resolves a present path to its cell", () => {
    const idA = mintNodeIdent(TX_A, 0, "a.ts");
    const found = resolveSelector(stateOf([["a.ts", cellOf(idA, "aaa")]]), { path: "a.ts" });
    expect(found?.path).toBe("a.ts");
    expect(found?.cell.ident).toBe(idA);
  });

  it("resolves a nid to its current path and cell", () => {
    const idA = mintNodeIdent(TX_A, 0, "a.ts");
    const found = resolveSelector(stateOf([["a.ts", cellOf(idA, "aaa")]]), { nid: idA });
    expect(found?.path).toBe("a.ts");
    expect(found?.cell.ident).toBe(idA);
  });

  it("returns undefined for an absent path", () => {
    const idA = mintNodeIdent(TX_A, 0, "a.ts");
    const state = stateOf([["a.ts", cellOf(idA, "aaa")]]);
    expect(resolveSelector(state, { path: "missing.ts" })).toBeUndefined();
  });

  it("returns undefined for an absent nid", () => {
    const idA = mintNodeIdent(TX_A, 0, "a.ts");
    const state = stateOf([["a.ts", cellOf(idA, "aaa")]]);
    expect(resolveSelector(state, { nid: mintNodeIdent(TX_B, 5, "gone.ts") })).toBeUndefined();
  });
});

describe("move invariant", () => {
  it("preserves the ident and the content address at the new path after move_cell", () => {
    const ident = mintNodeIdent(TX_A, 0, "src/old.ts");
    const before = stateOf([["src/old.ts", cellOf(ident, "export const x = 1;\n")]]);

    const originalCell = requireCell(before, "src/old.ts");
    const identBefore = originalCell.ident;
    const addressBefore = cellAddress(originalCell);

    const ops: ReadonlyArray<Op> = [
      { op: "move_cell", sel: { path: "src/old.ts" }, to: "src/new.ts" }
    ];
    const after = expectApplied(applyOps(before, ops));

    // the old path is vacated
    expect(after.cells["src/old.ts"]).toBeUndefined();

    const moved = requireCell(after, "src/new.ts");
    // identity survives the move ...
    expect(moved.ident).toBe(identBefore);
    // ... and content is unchanged, so the content address is byte-identical
    expect(cellAddress(moved)).toBe(addressBefore);

    // the stable ident now resolves to the new path
    expect(resolveSelector(after, { nid: ident })?.path).toBe("src/new.ts");
  });
});
