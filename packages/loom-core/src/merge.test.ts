import { describe, expect, it } from "vitest";
import { address } from "./addressing.js";
import { mintNodeIdent } from "./identity.js";
import { classify, lca, mergeStates, textThreeWay } from "./merge.js";
import type { TransformGraph } from "./merge.js";
import type { Cell, Cid, NodeIdent, State } from "./types.js";

// A fixed transform Cid used only to mint stable, distinct node identities.
const TX = "loom:sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as Cid;

function cellOf(ident: NodeIdent, text: string): Cell {
  return { facet: "text", ident, text };
}

function stateOf(entries: ReadonlyArray<readonly [string, Cell]>): State {
  const cells: Record<string, Cell> = {};
  for (const [path, cell] of entries) {
    cells[path] = cell;
  }
  return { kind: "state", cells };
}

function textAt(state: State, path: string): string | undefined {
  return state.cells[path]?.text;
}

describe("lca", () => {
  // root -> {x, y} -> merge   (a diamond)
  const root = address("root");
  const x = address("x");
  const y = address("y");
  const merge = address("merge");
  const diamond: TransformGraph = new Map<Cid, ReadonlyArray<Cid>>([
    [merge, [x, y]],
    [x, [root]],
    [y, [root]],
    [root, []]
  ]);

  it("finds the shared root of two diverged branches", () => {
    expect(lca(diamond, x, y)).toBe(root);
  });

  it("returns the deeper node when one is an ancestor of the other", () => {
    expect(lca(diamond, merge, x)).toBe(x);
    expect(lca(diamond, x, merge)).toBe(x);
  });

  it("returns the node itself for lca(a, a)", () => {
    expect(lca(diamond, root, root)).toBe(root);
    expect(lca(diamond, merge, merge)).toBe(merge);
  });

  it("returns undefined when the two nodes share no ancestor", () => {
    const iso = address("iso");
    const disjoint: TransformGraph = new Map<Cid, ReadonlyArray<Cid>>([
      [iso, []],
      [root, []]
    ]);
    expect(lca(disjoint, iso, root)).toBeUndefined();
  });
});

describe("textThreeWay", () => {
  it("takes the one side that changed a region", () => {
    expect(textThreeWay("a\nb\nc", "a\nB\nc", "a\nb\nc")).toEqual({
      text: "a\nB\nc",
      conflict: false
    });
    expect(textThreeWay("a\nb\nc", "a\nb\nc", "a\nb\nC")).toEqual({
      text: "a\nb\nC",
      conflict: false
    });
  });

  it("merges disjoint non-overlapping edits from both sides cleanly", () => {
    const merged = textThreeWay("a\nb\nc\nd\ne", "a\nB\nc\nd\ne", "a\nb\nc\nD\ne");
    expect(merged.conflict).toBe(false);
    expect(merged.text).toBe("a\nB\nc\nD\ne");
  });

  it("takes either side when both made the identical change", () => {
    expect(textThreeWay("x", "y", "y")).toEqual({ text: "y", conflict: false });
  });

  it("emits git-style markers and reports a conflict when both changed differently", () => {
    const merged = textThreeWay("foo(x)", "foo(x, ctx)", "foo(x) foo(y)");
    expect(merged.conflict).toBe(true);
    expect(merged.text).toContain("<<<<<<< ours");
    expect(merged.text).toContain("foo(x, ctx)");
    expect(merged.text).toContain("=======");
    expect(merged.text).toContain("foo(x) foo(y)");
    expect(merged.text).toContain(">>>>>>> theirs");
  });
});

describe("classify", () => {
  const nidA = mintNodeIdent(TX, 0, "a.ts");

  it("marks a Cell changed on only one side as independent", () => {
    const base = stateOf([["a.ts", cellOf(nidA, "hello")]]);
    const ours = stateOf([["a.ts", cellOf(nidA, "HELLO")]]);
    const theirs = stateOf([["a.ts", cellOf(nidA, "hello")]]);
    expect(classify(base, ours, theirs).get(nidA)).toBe("independent");
  });

  it("marks a move on one side and a content edit on the other as commuting", () => {
    const base = stateOf([["a.ts", cellOf(nidA, "hello")]]);
    const ours = stateOf([["b.ts", cellOf(nidA, "hello")]]); // moved, content untouched
    const theirs = stateOf([["a.ts", cellOf(nidA, "hello world")]]); // edited, not moved
    expect(classify(base, ours, theirs).get(nidA)).toBe("commuting");
  });

  it("marks differing content edits on both sides as a conflict", () => {
    const base = stateOf([["a.ts", cellOf(nidA, "hello")]]);
    const ours = stateOf([["a.ts", cellOf(nidA, "hello ours")]]);
    const theirs = stateOf([["a.ts", cellOf(nidA, "hello theirs")]]);
    expect(classify(base, ours, theirs).get(nidA)).toBe("conflict");
  });

  it("does not report untouched cells", () => {
    const base = stateOf([["a.ts", cellOf(nidA, "hello")]]);
    expect(classify(base, base, base).size).toBe(0);
  });
});

describe("mergeStates", () => {
  const nidA = mintNodeIdent(TX, 0, "a.ts");
  const nidB = mintNodeIdent(TX, 1, "b.ts");

  it("composes independent edits on different cells with no conflict", () => {
    const base = stateOf([
      ["a.ts", cellOf(nidA, "one")],
      ["b.ts", cellOf(nidB, "two")]
    ]);
    const ours = stateOf([
      ["a.ts", cellOf(nidA, "ONE")],
      ["b.ts", cellOf(nidB, "two")]
    ]);
    const theirs = stateOf([
      ["a.ts", cellOf(nidA, "one")],
      ["b.ts", cellOf(nidB, "TWO")]
    ]);
    const { candidate, conflicts } = mergeStates(base, ours, theirs);
    expect(conflicts).toHaveLength(0);
    expect(textAt(candidate, "a.ts")).toBe("ONE");
    expect(textAt(candidate, "b.ts")).toBe("TWO");
  });

  it("composes a move with a content edit (commuting) without conflict", () => {
    const base = stateOf([["a.ts", cellOf(nidA, "hello")]]);
    const ours = stateOf([["b.ts", cellOf(nidA, "hello")]]);
    const theirs = stateOf([["a.ts", cellOf(nidA, "hello world")]]);
    const { candidate, conflicts } = mergeStates(base, ours, theirs);
    expect(conflicts).toHaveLength(0);
    expect(textAt(candidate, "a.ts")).toBeUndefined(); // moved away
    expect(textAt(candidate, "b.ts")).toBe("hello world"); // moved + edited
    expect(candidate.cells["b.ts"]?.ident).toBe(nidA);
  });

  it("reconciles a true content conflict with git-style markers and a typed Conflict", () => {
    const base = stateOf([["a.ts", cellOf(nidA, "hello")]]);
    const ours = stateOf([["a.ts", cellOf(nidA, "hello ours")]]);
    const theirs = stateOf([["a.ts", cellOf(nidA, "hello theirs")]]);
    const { candidate, conflicts } = mergeStates(base, ours, theirs);

    expect(conflicts).toHaveLength(1);
    const conflict = conflicts[0];
    expect(conflict).toBeDefined();
    if (conflict !== undefined) {
      expect(conflict.kind).toBe("content");
      expect(conflict.nid).toBe(nidA);
      expect(conflict.path).toBe("a.ts");
      expect(conflict.base).toBe("hello");
      expect(conflict.ours).toBe("hello ours");
      expect(conflict.theirs).toBe("hello theirs");
      expect(conflict.textConflict).toContain("<<<<<<< ours");
    }

    const mergedText = textAt(candidate, "a.ts");
    expect(mergedText).toContain("<<<<<<< ours");
    expect(mergedText).toContain(">>>>>>> theirs");
  });

  it("raises a delete/edit conflict and keeps the surviving edit", () => {
    const base = stateOf([["a.ts", cellOf(nidA, "hello")]]);
    const ours = stateOf([]); // deleted the cell
    const theirs = stateOf([["a.ts", cellOf(nidA, "hello edited")]]); // edited it
    const { candidate, conflicts } = mergeStates(base, ours, theirs);

    expect(conflicts).toHaveLength(1);
    const conflict = conflicts[0];
    expect(conflict?.kind).toBe("delete/edit");
    expect(conflict?.nid).toBe(nidA);
    // The edit is preserved (never silently lost) even though it is conflicted.
    expect(textAt(candidate, "a.ts")).toBe("hello edited");
  });

  it("does not lose independent edits made alongside a conflict", () => {
    const base = stateOf([
      ["a.ts", cellOf(nidA, "hello")],
      ["b.ts", cellOf(nidB, "keep")]
    ]);
    const ours = stateOf([
      ["a.ts", cellOf(nidA, "hello ours")],
      ["b.ts", cellOf(nidB, "keep ours")]
    ]);
    const theirs = stateOf([
      ["a.ts", cellOf(nidA, "hello theirs")],
      ["b.ts", cellOf(nidB, "keep")]
    ]);
    const { candidate, conflicts } = mergeStates(base, ours, theirs);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.nid).toBe(nidA);
    // nid:b changed only on ours -> independent -> composed.
    expect(textAt(candidate, "b.ts")).toBe("keep ours");
  });
});

describe("merge integrity regressions", () => {
  const nidA = mintNodeIdent(TX, 10, "a.ts");
  const nidB = mintNodeIdent(TX, 11, "b.ts");

  function safeStateOf(entries: ReadonlyArray<readonly [string, Cell]>): State {
    return { kind: "state", cells: Object.fromEntries(entries) };
  }

  it("preserves independent cells at prototype-like paths", () => {
    const ours = safeStateOf([["__proto__", cellOf(nidA, "ours")]]);
    const theirs = safeStateOf([["constructor", cellOf(nidB, "theirs")]]);

    const { candidate, conflicts } = mergeStates(safeStateOf([]), ours, theirs);

    expect(conflicts).toHaveLength(0);
    expect(Object.getPrototypeOf(candidate.cells)).toBeNull();
    expect(Object.hasOwn(candidate.cells, "__proto__")).toBe(true);
    expect(Object.hasOwn(candidate.cells, "constructor")).toBe(true);
    expect(textAt(candidate, "__proto__")).toBe("ours");
    expect(textAt(candidate, "constructor")).toBe("theirs");
  });

  it("emits a path-collision instead of overwriting concurrent adds at one path", () => {
    const base = safeStateOf([]);
    const ours = safeStateOf([["shared.ts", cellOf(nidA, "ours")]]);
    const theirs = safeStateOf([["shared.ts", cellOf(nidB, "theirs")]]);

    const merged = mergeStates(base, ours, theirs);
    const repeated = mergeStates(base, ours, theirs);
    const expectedWinner = [nidA, nidB].sort()[0];
    const expectedLoser = [nidA, nidB].sort()[1];

    expect(merged).toEqual(repeated);
    expect(merged.conflicts).toHaveLength(1);
    expect(merged.conflicts[0]?.kind).toBe("path-collision");
    expect(merged.conflicts[0]?.path).toBe("shared.ts");
    expect(merged.conflicts[0]?.nid).toBe(expectedWinner);
    expect(merged.conflicts[0]?.otherNid).toBe(expectedLoser);
    expect(merged.conflicts[0]?.ours).toBe("ours");
    expect(merged.conflicts[0]?.theirs).toBe("theirs");
    expect(merged.candidate.cells["shared.ts"]?.ident).toBe(expectedWinner);
  });

  it("emits a deterministic move/move conflict for divergent moves", () => {
    const base = stateOf([["a.ts", cellOf(nidA, "same")]]);
    const ours = stateOf([["ours.ts", cellOf(nidA, "same")]]);
    const theirs = stateOf([["theirs.ts", cellOf(nidA, "same")]]);

    const merged = mergeStates(base, ours, theirs);

    expect(merged.conflicts).toHaveLength(1);
    expect(merged.conflicts[0]?.kind).toBe("move/move");
    expect(merged.conflicts[0]?.basePath).toBe("a.ts");
    expect(merged.conflicts[0]?.oursPath).toBe("ours.ts");
    expect(merged.conflicts[0]?.theirsPath).toBe("theirs.ts");
    expect(merged.candidate.cells["ours.ts"]?.ident).toBe(nidA);
    expect(merged.candidate.cells["theirs.ts"]).toBeUndefined();
  });

  it("emits a binary conflict for competing mode changes", () => {
    const baseCell: Cell = { ...cellOf(nidA, "same"), mode: 0o644 };
    const oursCell: Cell = { ...baseCell, mode: 0o755 };
    const theirsCell: Cell = { ...baseCell, mode: 0o600 };

    const merged = mergeStates(
      stateOf([["tool", baseCell]]),
      stateOf([["tool", oursCell]]),
      stateOf([["tool", theirsCell]])
    );

    expect(merged.conflicts).toHaveLength(1);
    expect(merged.conflicts[0]?.kind).toBe("binary");
    expect(merged.conflicts[0]?.baseMode).toBe(0o644);
    expect(merged.conflicts[0]?.oursMode).toBe(0o755);
    expect(merged.conflicts[0]?.theirsMode).toBe(0o600);
    expect(merged.candidate.cells["tool"]?.mode).toBe(0o755);
  });

  it("does not run textual diff3 over competing bytes-facet changes", () => {
    const baseCell: Cell = { facet: "bytes", ident: nidA, text: "base" };
    const oursCell: Cell = { ...baseCell, text: "ours" };
    const theirsCell: Cell = { ...baseCell, text: "theirs" };

    const merged = mergeStates(
      stateOf([["asset.bin", baseCell]]),
      stateOf([["asset.bin", oursCell]]),
      stateOf([["asset.bin", theirsCell]])
    );

    expect(merged.conflicts).toHaveLength(1);
    expect(merged.conflicts[0]?.kind).toBe("binary");
    expect(merged.conflicts[0]?.baseFacet).toBe("bytes");
    expect(merged.conflicts[0]?.ours).toBe("ours");
    expect(merged.conflicts[0]?.theirs).toBe("theirs");
    expect(textAt(merged.candidate, "asset.bin")).toBe("ours");
  });

  it("fails closed before merging a State with duplicate NodeIdent values", () => {
    const duplicate = safeStateOf([
      ["b.ts", cellOf(nidA, "second")],
      ["a.ts", cellOf(nidA, "first")]
    ]);

    expect(() => mergeStates(duplicate, duplicate, duplicate)).toThrow(
      /duplicate NodeIdent.*a\.ts.*b\.ts/u
    );
  });
});

describe("merge cell metadata integrity", () => {
  it("emits a binary conflict when facet and mode changes compete", () => {
    const nid = mintNodeIdent(TX, 12, "asset");
    const baseCell: Cell = { facet: "text", ident: nid, text: "same", mode: 0o644 };
    const oursCell: Cell = { ...baseCell, facet: "bytes" };
    const theirsCell: Cell = { ...baseCell, mode: 0o755 };

    const merged = mergeStates(
      stateOf([["asset", baseCell]]),
      stateOf([["asset", oursCell]]),
      stateOf([["asset", theirsCell]])
    );

    expect(merged.conflicts).toHaveLength(1);
    expect(merged.conflicts[0]?.kind).toBe("binary");
    expect(merged.conflicts[0]?.baseFacet).toBe("text");
    expect(merged.conflicts[0]?.oursFacet).toBe("bytes");
    expect(merged.conflicts[0]?.theirsMode).toBe(0o755);
  });
});
