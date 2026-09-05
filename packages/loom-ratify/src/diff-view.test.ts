import { describe, it, expect } from "vitest";
import type { Cell, NodeIdent, State } from "@agentforge/loom-core";
import { fabricDiffView } from "./index.js";

function state(entries: Record<string, { ident: string; text: string }>): State {
  const cells: Record<string, Cell> = {};
  for (const [path, entry] of Object.entries(entries)) {
    cells[path] = { facet: "text", ident: entry.ident as NodeIdent, text: entry.text };
  }
  return { kind: "state", cells };
}

describe("fabricDiffView", () => {
  it("reports an added file", () => {
    const base = state({});
    const result = state({ "a.ts": { ident: "nid:a", text: "one\ntwo" } });
    const [file] = fabricDiffView(base, result);
    expect(file?.status).toBe("added");
    expect(file?.filename).toBe("a.ts");
    expect(file?.currentContent).toBe("one\ntwo");
    expect(file?.additions).toBe(2);
    expect(file?.patch).toContain("+one");
  });

  it("reports a removed file", () => {
    const base = state({ "a.ts": { ident: "nid:a", text: "one\ntwo" } });
    const result = state({});
    const [file] = fabricDiffView(base, result);
    expect(file?.status).toBe("removed");
    expect(file?.previousContent).toBe("one\ntwo");
    expect(file?.deletions).toBe(2);
    expect(file?.patch).toContain("-one");
  });

  it("reports a modified file with a +/- patch", () => {
    const base = state({ "a.ts": { ident: "nid:a", text: "one\ntwo\nthree" } });
    const result = state({ "a.ts": { ident: "nid:a", text: "one\nTWO\nthree" } });
    const [file] = fabricDiffView(base, result);
    expect(file?.status).toBe("modified");
    expect(file?.patch).toContain("-two");
    expect(file?.patch).toContain("+TWO");
    expect(file?.additions).toBe(1);
    expect(file?.deletions).toBe(1);
  });

  it("detects a rename EXACTLY by stable identity (not heuristic)", () => {
    const base = state({ "old/util.ts": { ident: "nid:x", text: "same" } });
    const result = state({ "new/util.ts": { ident: "nid:x", text: "same" } });
    const [file] = fabricDiffView(base, result);
    expect(file?.status).toBe("renamed");
    expect(file?.previousFilename).toBe("old/util.ts");
    expect(file?.filename).toBe("new/util.ts");
  });

  it("skips unchanged cells (including both empty states)", () => {
    const base = state({ "a.ts": { ident: "nid:a", text: "same" } });
    const result = state({ "a.ts": { ident: "nid:a", text: "same" } });
    expect(fabricDiffView(base, result)).toHaveLength(0);
    expect(fabricDiffView(state({}), state({}))).toHaveLength(0);
  });

  it("reports a rename with content change as one renamed entry with both - and + lines", () => {
    const base = state({ "old/util.ts": { ident: "nid:x", text: "keep\nchange-me" } });
    const result = state({ "new/util.ts": { ident: "nid:x", text: "keep\nchanged" } });
    const [file] = fabricDiffView(base, result);
    expect(file?.status).toBe("renamed");
    expect(file?.previousFilename).toBe("old/util.ts");
    expect(file?.filename).toBe("new/util.ts");
    expect(file?.additions).toBe(1);
    expect(file?.deletions).toBe(1);
    expect(file?.patch).toContain("-change-me");
    expect(file?.patch).toContain("+changed");
  });

  it("reports a pure rename (identical content) with a header-only, change-free patch", () => {
    const base = state({ "old/util.ts": { ident: "nid:x", text: "same" } });
    const result = state({ "new/util.ts": { ident: "nid:x", text: "same" } });
    const [file] = fabricDiffView(base, result);
    expect(file?.status).toBe("renamed");
    expect(file?.additions).toBe(0);
    expect(file?.deletions).toBe(0);
    expect(file?.patch).toMatch(/^--- a\/new\/util\.ts\n\+\+\+ b\/new\/util\.ts\n@@ [^\n]* @@$/u);
    expect(file?.patch?.split("\n")).toHaveLength(3); // headers only, no body
  });

  it("treats the same path under a different identity as remove + add, not a modification", () => {
    const base = state({ "a.ts": { ident: "nid:old", text: "content" } });
    const result = state({ "a.ts": { ident: "nid:new", text: "content" } });
    const files = fabricDiffView(base, result);
    expect(files.map((file) => file.status).sort()).toEqual(["added", "removed"]);
    const removed = files.find((file) => file.status === "removed");
    const added = files.find((file) => file.status === "added");
    expect(removed?.deletions).toBe(1);
    expect(removed?.patch).toContain("-content");
    expect(added?.additions).toBe(1);
    expect(added?.patch).toContain("+content");
  });

  it("tracks identities that swap paths as two independent renames", () => {
    const base = state({
      "a.ts": { ident: "nid:x", text: "1" },
      "b.ts": { ident: "nid:y", text: "2" }
    });
    const result = state({
      "a.ts": { ident: "nid:y", text: "2" },
      "b.ts": { ident: "nid:x", text: "1" }
    });
    const files = fabricDiffView(base, result);
    expect(files).toHaveLength(2);
    for (const file of files) {
      expect(file.status).toBe("renamed");
      expect(file.additions).toBe(0);
      expect(file.deletions).toBe(0);
    }
    expect(files.map((file) => `${file.previousFilename}->${file.filename}`).sort()).toEqual([
      "a.ts->b.ts",
      "b.ts->a.ts"
    ]);
  });

  it("emits exactly one hunk header for a multi-line edit", () => {
    const base = state({ "a.ts": { ident: "nid:a", text: "p\nx\ny\nq\ns" } });
    const result = state({ "a.ts": { ident: "nid:a", text: "p\nX\nZ\nq\ns" } });
    const [file] = fabricDiffView(base, result);
    expect(file?.patch?.split("\n").filter((line) => line.startsWith("@@"))).toHaveLength(1);
    expect(file?.deletions).toBe(2);
    expect(file?.additions).toBe(2);
  });

  it("round-trips content emptied to an empty string and back", () => {
    // The patch is always 3 header lines (---, +++, @@) followed by +/- body lines.
    const bodyOf = (patch: string | undefined): string[] => patch?.split("\n").slice(3) ?? [];
    const base = state({ "a.ts": { ident: "nid:a", text: "only line" } });
    const emptied = state({ "a.ts": { ident: "nid:a", text: "" } });
    const [toEmpty] = fabricDiffView(base, emptied);
    expect(toEmpty?.status).toBe("modified");
    expect(toEmpty?.deletions).toBe(1);
    expect(toEmpty?.additions).toBe(0);
    expect(bodyOf(toEmpty?.patch)).toEqual(["-only line"]);

    const [fromEmpty] = fabricDiffView(emptied, base);
    expect(fromEmpty?.status).toBe("modified");
    expect(fromEmpty?.deletions).toBe(0);
    expect(fromEmpty?.additions).toBe(1);
    expect(bodyOf(fromEmpty?.patch)).toEqual(["+only line"]);
  });

  it("treats a missing trailing newline as a phantom final line", () => {
    // "a\n" splits into ["a", ""] so dropping the newline deletes the phantom line.
    const base = state({ "a.ts": { ident: "nid:a", text: "a\n" } });
    const result = state({ "a.ts": { ident: "nid:a", text: "a" } });
    const [file] = fabricDiffView(base, result);
    expect(file?.status).toBe("modified");
    expect(file?.deletions).toBe(1);
    expect(file?.additions).toBe(0);
    // The removed phantom line renders as a bare "-" line.
    expect(file?.patch).toMatch(/\n-\n?$/u);
  });

  it("preserves CRLF and unicode bytes verbatim inside +/- lines", () => {
    const base = state({ "a.ts": { ident: "nid:a", text: "café\r\nok" } });
    const result = state({ "a.ts": { ident: "nid:a", text: "café\r\nnaïve ☕" } });
    const [file] = fabricDiffView(base, result);
    expect(file?.patch).toContain("-ok");
    expect(file?.patch).toContain("+naïve ☕");
    // The unchanged CRLF line is not part of the patch, and CR never leaks into +/- lines.
    expect(file?.patch).not.toContain("\r\n+");
  });

  it("fails closed on a State containing duplicate NodeIdents", () => {
    const base = state({});
    const result = state({
      "a.ts": { ident: "nid:dup", text: "1" },
      "b.ts": { ident: "nid:dup", text: "2" }
    });
    expect(() => fabricDiffView(base, result)).toThrow(/duplicate NodeIdent/u);
    expect(() => fabricDiffView(result, base)).toThrow(/duplicate NodeIdent/u);
  });

  it("treats a '__proto__' path as an ordinary path (no prototype pollution)", () => {
    // Build states on a null-prototype cells map so "__proto__" is a real own key.
    const make = (entry: { ident: string; text: string } | undefined): State => {
      const cells = Object.create(null) as Record<string, Cell>;
      if (entry !== undefined) {
        cells["__proto__"] = { facet: "text", ident: entry.ident as NodeIdent, text: entry.text };
      }
      return { kind: "state", cells };
    };
    const files = fabricDiffView(make({ ident: "nid:p", text: "secret" }), make(undefined));
    expect(files).toHaveLength(1);
    expect(files[0]?.filename).toBe("__proto__");
    expect(files[0]?.status).toBe("removed");
    expect(files[0]?.previousContent).toBe("secret");
    expect(Object.getPrototypeOf(files)).toBe(Array.prototype);
  });

  it("returns entries sorted by filename regardless of insertion order", () => {
    const base = state({});
    const result = state({
      "z.ts": { ident: "nid:z", text: "z" },
      "a/b.ts": { ident: "nid:ab", text: "ab" },
      "a.ts": { ident: "nid:a", text: "a" },
      "A.ts": { ident: "nid:upper", text: "A" }
    });
    const files = fabricDiffView(base, result);
    expect(files.map((file) => file.filename)).toEqual(["A.ts", "a.ts", "a/b.ts", "z.ts"]);
  });

  it("handles a very long single line without losing bytes", () => {
    const long = "x".repeat(500_000);
    const base = state({ "big.txt": { ident: "nid:big", text: long } });
    const result = state({});
    const [file] = fabricDiffView(base, result);
    expect(file?.status).toBe("removed");
    expect(file?.deletions).toBe(1);
    expect(file?.patch?.length).toBeGreaterThan(500_000);
  });
});
