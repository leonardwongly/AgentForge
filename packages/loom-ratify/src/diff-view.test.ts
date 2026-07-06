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

  it("skips unchanged cells", () => {
    const base = state({ "a.ts": { ident: "nid:a", text: "same" } });
    const result = state({ "a.ts": { ident: "nid:a", text: "same" } });
    expect(fabricDiffView(base, result)).toHaveLength(0);
  });
});
