import { describe, expect, it } from "vitest";
import type { Cell, State } from "@agentforge/loom-core";
import { execGitReader, nodeIdentForPath, stateFromGitRef, transformSetFromGit } from "./git.js";
import type { GitReader, GitTreeEntry } from "./types.js";

const BASE_REF = "base";
const HEAD_REF = "head";

// Fake trees. "src" is a tree entry that MUST be skipped when building a State.
// "src/app.ts" and "README.md" exist in both refs; "src/removed.ts" is base-only
// and "src/added.ts" is head-only.
const treeByRef: Readonly<Record<string, ReadonlyArray<GitTreeEntry>>> = {
  [BASE_REF]: [
    { path: "src", mode: "040000", type: "tree" },
    { path: "src/app.ts", mode: "100644", type: "blob" },
    { path: "src/removed.ts", mode: "100644", type: "blob" },
    { path: "README.md", mode: "100644", type: "blob" }
  ],
  [HEAD_REF]: [
    { path: "src", mode: "040000", type: "tree" },
    { path: "src/app.ts", mode: "100644", type: "blob" },
    { path: "src/added.ts", mode: "100644", type: "blob" },
    { path: "README.md", mode: "100644", type: "blob" }
  ]
};

const contentByRef: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  [BASE_REF]: {
    "src/app.ts": "export const v = 1;\n",
    "src/removed.ts": "export const gone = true;\n",
    "README.md": "# base\n"
  },
  [HEAD_REF]: {
    "src/app.ts": "export const v = 2;\n",
    "src/added.ts": "export const added = true;\n",
    "README.md": "# base\n"
  }
};

/**
 * In-memory GitReader. readFile rejects for any path not registered as a blob,
 * which also proves stateFromGitRef never reads tree entries.
 */
function fakeReader(): GitReader {
  return {
    lsTree: async (ref: string): Promise<ReadonlyArray<GitTreeEntry>> => {
      return treeByRef[ref] ?? [];
    },
    readFile: async (ref: string, path: string): Promise<string> => {
      const text = contentByRef[ref]?.[path];
      if (text === undefined) {
        throw new Error(`fake reader: no blob at ${ref}:${path}`);
      }
      return text;
    }
  };
}

/** Narrow cells[path] (undefined under noUncheckedIndexedAccess) or fail loudly. */
function cellAt(state: State, path: string): Cell {
  const cell = state.cells[path];
  if (cell === undefined) {
    throw new Error(`expected a cell at ${path}`);
  }
  return cell;
}

describe("nodeIdentForPath", () => {
  it("is deterministic for the same path", () => {
    expect(nodeIdentForPath("src/app.ts")).toBe(nodeIdentForPath("src/app.ts"));
  });

  it("produces the nid:<32 lowercase hex> shape", () => {
    const ident = nodeIdentForPath("src/app.ts");
    expect(ident.startsWith("nid:")).toBe(true);
    expect(ident.slice("nid:".length)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is distinct for distinct paths", () => {
    expect(nodeIdentForPath("a.ts")).not.toBe(nodeIdentForPath("b.ts"));
  });
});

describe("stateFromGitRef", () => {
  it("builds cells for blobs only and skips tree entries", async () => {
    const state = await stateFromGitRef(fakeReader(), BASE_REF);
    expect(Object.keys(state.cells).sort()).toEqual(["README.md", "src/app.ts", "src/removed.ts"]);
    expect(state.cells["src"]).toBeUndefined();
    expect(state.kind).toBe("state");
  });

  it("uses the text facet, path-derived ident, and file text, and omits mode", async () => {
    const state = await stateFromGitRef(fakeReader(), BASE_REF);
    const cell = cellAt(state, "src/app.ts");
    expect(cell.facet).toBe("text");
    expect(cell.text).toBe("export const v = 1;\n");
    expect(cell.ident).toBe(nodeIdentForPath("src/app.ts"));
    expect("mode" in cell).toBe(false);
  });
});

describe("path identity across refs", () => {
  it("shares an ident for a path present in both refs (reads as modified)", async () => {
    const base = await stateFromGitRef(fakeReader(), BASE_REF);
    const head = await stateFromGitRef(fakeReader(), HEAD_REF);
    const baseCell = cellAt(base, "src/app.ts");
    const headCell = cellAt(head, "src/app.ts");
    expect(headCell.ident).toBe(baseCell.ident);
    // Same identity, different content => a downstream diff sees a modification.
    expect(headCell.text).not.toBe(baseCell.text);
  });

  it("gives distinct idents to a base-only vs head-only path (delete+add)", async () => {
    const base = await stateFromGitRef(fakeReader(), BASE_REF);
    const head = await stateFromGitRef(fakeReader(), HEAD_REF);
    const removed = cellAt(base, "src/removed.ts");
    const added = cellAt(head, "src/added.ts");
    expect(added.ident).not.toBe(removed.ident);
    expect(base.cells["src/added.ts"]).toBeUndefined();
    expect(head.cells["src/removed.ts"]).toBeUndefined();
  });
});

describe("transformSetFromGit", () => {
  it("returns both the base and result states", async () => {
    const set = await transformSetFromGit(fakeReader(), BASE_REF, HEAD_REF);
    expect(set.base.kind).toBe("state");
    expect(set.result.kind).toBe("state");
    // base carries the removed file; result carries the added file.
    expect(set.base.cells["src/removed.ts"]).toBeDefined();
    expect(set.result.cells["src/added.ts"]).toBeDefined();
    expect(set.base.cells["src/added.ts"]).toBeUndefined();
    expect(set.result.cells["src/removed.ts"]).toBeUndefined();
  });
});

describe("execGitReader", () => {
  it("is a factory function (real-repo behaviour is covered by integration)", () => {
    expect(typeof execGitReader).toBe("function");
  });
});
