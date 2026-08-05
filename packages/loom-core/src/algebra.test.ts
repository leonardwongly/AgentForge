import { describe, expect, it } from "vitest";
import { applyOps, impliedEffects, isTestPath, verifyEffects } from "./algebra.js";
import { emptyState } from "./identity.js";
import type { ApplyResult, Cell, CellFacet, Effect, NodeIdent, State } from "./types.js";

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

function expectApplied(result: ApplyResult): State {
  if (!result.ok) {
    throw new Error(`expected applyOps to succeed: ${result.error.detail}`);
  }
  return result.state;
}

function expectPrecondition(result: ApplyResult): void {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected a precondition failure but applyOps succeeded");
  }
  expect(result.error.code).toBe("precondition");
}

function requireCell(state: State, path: string): Cell {
  const cell = state.cells[path];
  if (cell === undefined) {
    throw new Error(`expected a cell at ${path}`);
  }
  return cell;
}

describe("applyOps happy paths", () => {
  it("put_cell inserts a cell, honoring the optional mode field", () => {
    const withoutMode = expectApplied(
      applyOps(emptyState(), [
        { op: "put_cell", at: "a.ts", ident: "nid:a" as NodeIdent, facet: "text", text: "A" }
      ])
    );
    expect(requireCell(withoutMode, "a.ts").text).toBe("A");
    expect(requireCell(withoutMode, "a.ts").mode).toBeUndefined();

    const withMode = expectApplied(
      applyOps(withoutMode, [
        {
          op: "put_cell",
          at: "bin",
          ident: "nid:b" as NodeIdent,
          facet: "bytes",
          text: "B",
          mode: 0o755
        }
      ])
    );
    expect(requireCell(withMode, "bin").mode).toBe(0o755);
  });

  it("delete_cell removes a resolved cell", () => {
    const before = stateOf([["a.ts", cellOf("nid:a", "A")]]);
    const after = expectApplied(applyOps(before, [{ op: "delete_cell", sel: { path: "a.ts" } }]));
    expect(after.cells["a.ts"]).toBeUndefined();
    expect(Object.keys(after.cells)).toHaveLength(0);
  });

  it("move_cell relocates a cell to a free path", () => {
    const before = stateOf([["a.ts", cellOf("nid:a", "A")]]);
    const after = expectApplied(
      applyOps(before, [{ op: "move_cell", sel: { path: "a.ts" }, to: "b.ts" }])
    );
    expect(after.cells["a.ts"]).toBeUndefined();
    expect(requireCell(after, "b.ts").text).toBe("A");
  });

  it("move_cell onto its own path is a no-op that keeps the cell", () => {
    const before = stateOf([["a.ts", cellOf("nid:a", "A")]]);
    const after = expectApplied(
      applyOps(before, [{ op: "move_cell", sel: { path: "a.ts" }, to: "a.ts" }])
    );
    expect(requireCell(after, "a.ts").text).toBe("A");
  });

  it("patch_text splices, replaces, and appends within range", () => {
    const before = stateOf([["a.ts", cellOf("nid:a", "hello")]]);
    const spliced = expectApplied(
      applyOps(before, [{ op: "patch_text", sel: { path: "a.ts" }, range: [0, 1], text: "H" }])
    );
    expect(requireCell(spliced, "a.ts").text).toBe("Hello");

    const replaced = expectApplied(
      applyOps(before, [{ op: "patch_text", sel: { path: "a.ts" }, range: [0, 5], text: "bye" }])
    );
    expect(requireCell(replaced, "a.ts").text).toBe("bye");

    const appended = expectApplied(
      applyOps(before, [{ op: "patch_text", sel: { path: "a.ts" }, range: [5, 5], text: "!" }])
    );
    expect(requireCell(appended, "a.ts").text).toBe("hello!");
  });

  it("does not mutate the input state (purity)", () => {
    const before = stateOf([["a.ts", cellOf("nid:a", "A")]]);
    applyOps(before, [{ op: "delete_cell", sel: { path: "a.ts" } }]);
    expect(before.cells["a.ts"]).toBeDefined();
  });
});

describe("applyOps preconditions", () => {
  it("delete_cell on a missing path or nid fails with precondition", () => {
    const empty = emptyState();
    expectPrecondition(applyOps(empty, [{ op: "delete_cell", sel: { path: "nope" } }]));
    expectPrecondition(
      applyOps(empty, [{ op: "delete_cell", sel: { nid: "nid:missing" as NodeIdent } }])
    );
  });

  it("move_cell on a missing selector fails with precondition", () => {
    expectPrecondition(
      applyOps(emptyState(), [{ op: "move_cell", sel: { path: "nope" }, to: "x" }])
    );
  });

  it("patch_text on a missing selector fails with precondition", () => {
    expectPrecondition(
      applyOps(emptyState(), [{ op: "patch_text", sel: { path: "nope" }, range: [0, 0], text: "" }])
    );
  });

  it("move_cell onto an occupied path fails with precondition", () => {
    const before = stateOf([
      ["a.ts", cellOf("nid:a", "A")],
      ["b.ts", cellOf("nid:b", "B")]
    ]);
    expectPrecondition(applyOps(before, [{ op: "move_cell", sel: { path: "a.ts" }, to: "b.ts" }]));
  });

  it("patch_text with an out-of-range span fails with precondition", () => {
    const before = stateOf([["a.ts", cellOf("nid:a", "hi")]]); // length 2
    expectPrecondition(
      applyOps(before, [{ op: "patch_text", sel: { path: "a.ts" }, range: [0, 5], text: "x" }])
    ); // end > len
    expectPrecondition(
      applyOps(before, [{ op: "patch_text", sel: { path: "a.ts" }, range: [-1, 1], text: "x" }])
    ); // start < 0
    expectPrecondition(
      applyOps(before, [{ op: "patch_text", sel: { path: "a.ts" }, range: [2, 1], text: "x" }])
    ); // end < start
  });

  it("stops at the first failing op in a sequence", () => {
    const before = stateOf([["a.ts", cellOf("nid:a", "A")]]);
    const result = applyOps(before, [
      { op: "delete_cell", sel: { path: "a.ts" } },
      { op: "delete_cell", sel: { path: "a.ts" } } // already gone
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("precondition");
    }
  });
});

describe("move_cell preserves identity and content", () => {
  it("keeps ident, text, and facet identical across the move", () => {
    const before = stateOf([["src/old.ts", cellOf("nid:keep", "payload")]]);
    const original = requireCell(before, "src/old.ts");
    const after = expectApplied(
      applyOps(before, [{ op: "move_cell", sel: { path: "src/old.ts" }, to: "src/new.ts" }])
    );
    const moved = requireCell(after, "src/new.ts");
    expect(moved.ident).toBe(original.ident);
    expect(moved.text).toBe(original.text);
    expect(moved.facet).toBe(original.facet);
  });
});

describe("isTestPath", () => {
  it("recognizes test files and directories", () => {
    expect(isTestPath("src/foo.test.ts")).toBe(true);
    expect(isTestPath("src/foo.spec.tsx")).toBe(true);
    expect(isTestPath("tests/foo.ts")).toBe(true);
    expect(isTestPath("test/foo.ts")).toBe(true);
    expect(isTestPath("pkg/__tests__/foo.ts")).toBe(true);
  });

  it("treats ordinary source as non-test", () => {
    expect(isTestPath("src/foo.ts")).toBe(false);
    expect(isTestPath("src/contest/foo.ts")).toBe(false); // "contest" is not a test dir
  });
});

describe("impliedEffects", () => {
  it("put_cell and patch_text imply edits_source", () => {
    expect(
      impliedEffects(emptyState(), [
        { op: "put_cell", at: "a.ts", ident: "nid:a" as NodeIdent, facet: "text", text: "A" }
      ])
    ).toContain("edits_source");

    const withCell = stateOf([["a.ts", cellOf("nid:a", "hello")]]);
    expect(
      impliedEffects(withCell, [
        { op: "patch_text", sel: { path: "a.ts" }, range: [0, 1], text: "H" }
      ])
    ).toContain("edits_source");
  });

  it("delete_cell implies deletes_source, adding deletes_test for a test path", () => {
    const base = stateOf([
      ["src/a.ts", cellOf("nid:a", "A")],
      ["src/a.test.ts", cellOf("nid:t", "T")]
    ]);

    const sourceDelete = impliedEffects(base, [{ op: "delete_cell", sel: { path: "src/a.ts" } }]);
    expect(sourceDelete).toContain("deletes_source");
    expect(sourceDelete).not.toContain("deletes_test");

    const testDelete = impliedEffects(base, [
      { op: "delete_cell", sel: { path: "src/a.test.ts" } }
    ]);
    expect(testDelete).toContain("deletes_source");
    expect(testDelete).toContain("deletes_test");
  });

  it("treats put_cell identity replacement as deletion plus edit", () => {
    const base = stateOf([
      ["src/a.ts", cellOf("nid:old", "old")],
      ["src/a.test.ts", cellOf("nid:test-old", "old test")]
    ]);

    const sourceReplacement = impliedEffects(base, [
      {
        op: "put_cell",
        at: "src/a.ts",
        ident: "nid:new" as NodeIdent,
        facet: "text",
        text: "new"
      }
    ]);
    expect(sourceReplacement).toEqual(expect.arrayContaining(["edits_source", "deletes_source"]));
    expect(sourceReplacement).not.toContain("deletes_test");

    const testReplacement = impliedEffects(base, [
      {
        op: "put_cell",
        at: "src/a.test.ts",
        ident: "nid:test-new" as NodeIdent,
        facet: "text",
        text: "new test"
      }
    ]);
    expect(testReplacement).toEqual(
      expect.arrayContaining(["edits_source", "deletes_source", "deletes_test"])
    );

    const sequentialReplacement = impliedEffects(emptyState(), [
      {
        op: "put_cell",
        at: "src/generated.ts",
        ident: "nid:first" as NodeIdent,
        facet: "text",
        text: "first"
      },
      {
        op: "put_cell",
        at: "src/generated.ts",
        ident: "nid:second" as NodeIdent,
        facet: "text",
        text: "second"
      }
    ]);
    expect(sequentialReplacement).toEqual(
      expect.arrayContaining(["edits_source", "deletes_source"])
    );
  });

  it("does not derive a deletion when put_cell preserves the existing identity", () => {
    const base = stateOf([["src/a.ts", cellOf("nid:a", "old")]]);
    expect(
      impliedEffects(base, [
        {
          op: "put_cell",
          at: "src/a.ts",
          ident: "nid:a" as NodeIdent,
          facet: "text",
          text: "new"
        }
      ])
    ).toEqual(["edits_source"]);
  });

  it("move_cell implies moves_cell", () => {
    const base = stateOf([["a.ts", cellOf("nid:a", "A")]]);
    expect(
      impliedEffects(base, [{ op: "move_cell", sel: { path: "a.ts" }, to: "b.ts" }])
    ).toContain("moves_cell");
  });

  it("patch_text on a test file implies skips_test alongside edits_source", () => {
    const base = stateOf([["src/a.test.ts", cellOf("nid:t", "expect(true).toBe(true)")]]);
    const effects = impliedEffects(base, [
      { op: "patch_text", sel: { path: "src/a.test.ts" }, range: [0, 0], text: "// " }
    ]);
    expect(effects).toContain("skips_test");
    expect(effects).toContain("edits_source");
  });

  it("deduplicates so each effect appears at most once", () => {
    const base = stateOf([
      ["a.ts", cellOf("nid:a", "A")],
      ["b.ts", cellOf("nid:b", "B")]
    ]);
    const effects = impliedEffects(base, [
      { op: "put_cell", at: "c.ts", ident: "nid:c" as NodeIdent, facet: "text", text: "C" },
      { op: "patch_text", sel: { path: "a.ts" }, range: [0, 1], text: "x" }
    ]);
    expect(effects.filter((effect) => effect === "edits_source")).toHaveLength(1);
  });
});

describe("verifyEffects", () => {
  it("is ok when declared exactly matches implied", () => {
    const implied: ReadonlyArray<Effect> = ["edits_source", "moves_cell"];
    const declared: ReadonlyArray<Effect> = ["edits_source", "moves_cell"];
    const check = verifyEffects(declared, implied);
    expect(check.ok).toBe(true);
    expect(check.missing).toHaveLength(0);
    expect(check.extra).toHaveLength(0);
  });

  it("reports missing effects on under-declaration and is not ok", () => {
    const implied: ReadonlyArray<Effect> = ["edits_source", "deletes_source"];
    const declared: ReadonlyArray<Effect> = ["edits_source"];
    const check = verifyEffects(declared, implied);
    expect(check.ok).toBe(false);
    expect(check.missing).toEqual(["deletes_source"]);
  });

  it("reports extra effects on over-declaration but stays ok (extra is allowed)", () => {
    const implied: ReadonlyArray<Effect> = ["edits_source"];
    const declared: ReadonlyArray<Effect> = ["edits_source", "changes_ci"];
    const check = verifyEffects(declared, implied);
    expect(check.ok).toBe(true);
    expect(check.missing).toHaveLength(0);
    expect(check.extra).toEqual(["changes_ci"]);
  });

  it("reports both missing and extra when declaration diverges in both directions", () => {
    const implied: ReadonlyArray<Effect> = ["edits_source", "deletes_source"];
    const declared: ReadonlyArray<Effect> = ["edits_source", "changes_ci"];
    const check = verifyEffects(declared, implied);
    expect(check.ok).toBe(false);
    expect(check.missing).toEqual(["deletes_source"]);
    expect(check.extra).toEqual(["changes_ci"]);
  });
});

describe("State map and identity integrity regressions", () => {
  it("preserves prototype-like path names as own cells", () => {
    const paths = ["__proto__", "constructor", "toString"] as const;
    const result = applyOps(
      emptyState(),
      paths.map((path, ordinal) => ({
        op: "put_cell" as const,
        at: path,
        ident: `nid:special-${ordinal}` as NodeIdent,
        facet: "text" as const,
        text: path
      }))
    );
    const state = expectApplied(result);

    expect(Object.getPrototypeOf(state.cells)).toBeNull();
    expect(Object.keys(state.cells).sort()).toEqual([...paths].sort());
    for (const path of paths) {
      expect(Object.hasOwn(state.cells, path)).toBe(true);
      expect(requireCell(state, path).text).toBe(path);
    }
  });

  it("fails a put_cell that would duplicate a NodeIdent at another path", () => {
    const result = applyOps(emptyState(), [
      { op: "put_cell", at: "a.ts", ident: "nid:duplicate" as NodeIdent, facet: "text", text: "A" },
      { op: "put_cell", at: "b.ts", ident: "nid:duplicate" as NodeIdent, facet: "text", text: "B" }
    ]);

    expectPrecondition(result);
    if (!result.ok) {
      expect(result.error.detail).toMatch(/duplicate NodeIdent.*a\.ts.*b\.ts/u);
    }
  });

  it("fails closed when the input State already contains duplicate identities", () => {
    const cells = Object.create(null) as Record<string, Cell>;
    cells["a.ts"] = cellOf("nid:duplicate", "A");
    cells["b.ts"] = cellOf("nid:duplicate", "B");

    const result = applyOps({ kind: "state", cells }, []);
    expectPrecondition(result);
  });
});
