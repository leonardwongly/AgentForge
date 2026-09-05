import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { mintNodeIdent } from "./identity.js";
import {
  captureState,
  diffWorkingCopy,
  materializeState,
  validateMaterializePath
} from "./materialize.js";
import type { Cell, NodeIdent, State } from "./types.js";

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "loom-materialize-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function cell(text: string, path: string): Cell {
  return { facet: "text", ident: mintNodeIdent("cid" as never, 0, path), text };
}

describe("validateMaterializePath", () => {
  it("accepts safe relative paths", () => {
    expect(validateMaterializePath("src/billing/checkout.ts")).toBeUndefined();
    expect(validateMaterializePath("a/b/c.txt")).toBeUndefined();
  });

  it("rejects traversal, absolute, NUL, and empty paths", () => {
    expect(validateMaterializePath("")).toMatch(/empty/);
    expect(validateMaterializePath("../escape")).toMatch(/not allowed/);
    expect(validateMaterializePath("a/../b")).toMatch(/not allowed/);
    expect(validateMaterializePath("/abs")).toMatch(/relative/);
    expect(validateMaterializePath("a\\b")).toMatch(/relative/);
    expect(validateMaterializePath("a\u0000b")).toMatch(/NUL/);
    expect(validateMaterializePath("a//b")).toMatch(/not allowed/);
  });
});

describe("materializeState / captureState", () => {
  it("writes each cell to its path and captures it back", () => {
    withDir((dir) => {
      const state: State = {
        kind: "state",
        cells: {
          "README.md": cell("# hello", "README.md"),
          "src/billing/checkout.ts": cell("export const a = 1;", "src/billing/checkout.ts")
        }
      };
      materializeState(state, dir);
      expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("# hello");
      expect(readFileSync(join(dir, "src/billing/checkout.ts"), "utf8")).toBe("export const a = 1;");

      const captured = captureState(dir);
      expect(captured.cells["README.md"]?.text).toBe("# hello");
      expect(captured.cells["src/billing/checkout.ts"]?.text).toBe("export const a = 1;");
    });
  });

  it("rejects a path that would escape the working copy", () => {
    withDir((dir) => {
      const state: State = {
        kind: "state",
        cells: { "../escape.txt": cell("x", "../escape.txt") }
      };
      // Path validation rejects the ".." segment before any write happens.
      expect(() => materializeState(state, dir)).toThrow(/not allowed/);
      expect(existsSync(join(dir, "..", "escape.txt"))).toBe(false);
    });
  });

  it("refuses to write through an existing symlink", () => {
    withDir((dir) => {
      const outside = join(dir, "..", "loom-materialize-outside.txt");
      writeFileSync(outside, "keep", "utf8");
      symlinkSync(outside, join(dir, "output.txt"));
      const state: State = { kind: "state", cells: { "output.txt": cell("overwrite", "output.txt") } };
      expect(() => materializeState(state, dir)).toThrow(/ELOOP|symlink|symbolic/u);
      expect(readFileSync(outside, "utf8")).toBe("keep");
      rmSync(outside, { force: true });
    });
  });

  it("captures nested directories deterministically", () => {
    withDir((dir) => {
      writeFileSync(join(dir, "a.txt"), "a", "utf8");
      mkdirSync(join(dir, "sub"), { recursive: true });
      writeFileSync(join(dir, "sub", "b.txt"), "b", "utf8");
      const state = captureState(dir);
      expect(Object.keys(state.cells).sort()).toEqual(["a.txt", "sub/b.txt"]);
    });
  });
});

describe("diffWorkingCopy (change journal)", () => {
  it("reports added, modified, and removed paths", () => {
    withDir((dir) => {
      // Base state has a.txt (unchanged), b.txt (will be modified), gone.txt (will be removed).
      const base: State = {
        kind: "state",
        cells: {
          "a.txt": cell("a", "a.txt"),
          "b.txt": cell("old", "b.txt"),
          "gone.txt": cell("bye", "gone.txt")
        }
      };
      writeFileSync(join(dir, "a.txt"), "a", "utf8");
      writeFileSync(join(dir, "b.txt"), "new", "utf8");
      writeFileSync(join(dir, "c.txt"), "added", "utf8");

      const journal = diffWorkingCopy(dir, base);
      expect(journal.added).toEqual(["c.txt"]);
      expect(journal.modified).toEqual(["b.txt"]);
      expect(journal.removed).toEqual(["gone.txt"]);
    });
  });

  it("reports no changes for an identical working copy", () => {
    withDir((dir) => {
      const base: State = { kind: "state", cells: { "a.txt": cell("a", "a.txt") } };
      writeFileSync(join(dir, "a.txt"), "a", "utf8");
      expect(diffWorkingCopy(dir, base)).toEqual({ added: [], modified: [], removed: [] });
    });
  });
});
