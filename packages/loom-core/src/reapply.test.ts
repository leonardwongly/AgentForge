import { describe, expect, it } from "vitest";
import { stateAddress } from "./addressing.js";
import { mintNodeIdent } from "./identity.js";
import { textThreeWay } from "./merge.js";
import { reapply } from "./reapply.js";
import type { Cell, Cid, NodeIdent, Recipe, State, ToolchainLock } from "./types.js";

const TX = "loom:sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" as Cid;

const TOOLCHAIN: ToolchainLock = { engineDigest: "engine@1", runtimeDigest: "node@22" };

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

// The §5.2 codemod: foo(x) -> foo(x, ctx). Idempotent (its output no longer
// matches), pinned, writing only the caller cell.
const CTX_CODEMOD: Recipe = {
  engine: "regex-replace",
  determinismClass: "pinned",
  toolchain: TOOLCHAIN,
  rule: { find: "foo\\(([a-zA-Z]+)\\)", replace: "foo($1, ctx)", flags: "g" },
  inputSelector: [{ path: "callers/a.ts" }],
  writeScope: [{ path: "callers/a.ts" }]
};

describe("reapply — headline recompute over a conflicting base edit (§5.2)", () => {
  const nidA = mintNodeIdent(TX, 0, "callers/a.ts");
  // original codemod result on the OLD base (only foo(x)).
  const originalResult = stateOf([["callers/a.ts", cellOf(nidA, "foo(x, ctx)")]]);
  // the moved base: a teammate added a NEW call foo(y) on the same cell.
  const newBase = stateOf([["callers/a.ts", cellOf(nidA, "foo(x) foo(y)")]]);

  it("recomputes the rule over the new base, transforming the newly added call too", () => {
    const outcome = reapply(CTX_CODEMOD, originalResult, newBase);
    expect(outcome.kind).toBe("CleanReapply");
    if (outcome.kind === "CleanReapply") {
      // BOTH calls are transformed, including the one git never saw.
      expect(textAt(outcome.resultState, "callers/a.ts")).toBe("foo(x, ctx) foo(y, ctx)");
      expect(outcome.recomputed).toBe(true);
      expect(outcome.changedResult).toBe(true);
    }
  });

  it("would be a git conflict on that same cell (the floor diff3 disagrees)", () => {
    const merged = textThreeWay("foo(x)", "foo(x, ctx)", "foo(x) foo(y)");
    expect(merged.conflict).toBe(true);
  });
});

describe("reapply — engines", () => {
  it("dep-bump rewrites only the pinned version in a manifest cell", () => {
    const nid = mintNodeIdent(TX, 1, "package.json");
    const manifest = '{\n  "dependencies": {\n    "left-pad": "1.0.0"\n  }\n}';
    const bumped = '{\n  "dependencies": {\n    "left-pad": "2.0.0"\n  }\n}';
    const newBase = stateOf([["package.json", cellOf(nid, manifest)]]);
    const recipe: Recipe = {
      engine: "dep-bump",
      determinismClass: "pinned",
      toolchain: TOOLCHAIN,
      rule: { name: "left-pad", from: "1.0.0", to: "2.0.0" },
      inputSelector: [{ path: "package.json" }],
      writeScope: [{ path: "package.json" }]
    };
    const outcome = reapply(recipe, newBase, newBase);
    expect(outcome.kind).toBe("CleanReapply");
    if (outcome.kind === "CleanReapply") {
      expect(textAt(outcome.resultState, "package.json")).toBe(bumped);
      expect(outcome.changedResult).toBe(true);
    }
  });

  it("reports changedResult=false when the recompute reproduces the original result", () => {
    const nid = mintNodeIdent(TX, 2, "a.ts");
    const originalResult = stateOf([["a.ts", cellOf(nid, "foo(x, ctx)")]]);
    const newBase = stateOf([["a.ts", cellOf(nid, "foo(x)")]]);
    const recipe: Recipe = {
      engine: "regex-replace",
      determinismClass: "pinned",
      toolchain: TOOLCHAIN,
      rule: { find: "foo\\(([a-zA-Z]+)\\)", replace: "foo($1, ctx)", flags: "g" },
      inputSelector: [{ path: "a.ts" }],
      writeScope: [{ path: "a.ts" }]
    };
    const outcome = reapply(recipe, originalResult, newBase);
    expect(outcome.kind).toBe("CleanReapply");
    if (outcome.kind === "CleanReapply") {
      expect(textAt(outcome.resultState, "a.ts")).toBe("foo(x, ctx)");
      expect(outcome.changedResult).toBe(false);
    }
  });
});

describe("reapply — HardFailure paths (fall back to text 3-way)", () => {
  const nid = mintNodeIdent(TX, 3, "a.ts");
  const newBase = stateOf([["a.ts", cellOf(nid, "foo(x)")]]);
  const originalResult = stateOf([["a.ts", cellOf(nid, "foo(x, ctx)")]]);

  it("nondeterministic recipe is never reapplied", () => {
    const recipe: Recipe = {
      ...CTX_CODEMOD,
      determinismClass: "nondeterministic",
      inputSelector: [{ path: "a.ts" }],
      writeScope: [{ path: "a.ts" }]
    };
    const outcome = reapply(recipe, originalResult, newBase);
    expect(outcome.kind).toBe("HardFailure");
    if (outcome.kind === "HardFailure") {
      expect(outcome.reason).toBe("nondeterministic");
    }
  });

  it("a vanished input selector is a precondition failure", () => {
    const recipe: Recipe = {
      ...CTX_CODEMOD,
      inputSelector: [{ path: "missing.ts" }],
      writeScope: [{ path: "missing.ts" }]
    };
    const outcome = reapply(recipe, originalResult, newBase);
    expect(outcome.kind).toBe("HardFailure");
    if (outcome.kind === "HardFailure") {
      expect(outcome.reason).toBe("precondition");
    }
  });

  it("a write escaping writeScope is an engine error", () => {
    const recipe: Recipe = {
      engine: "regex-replace",
      determinismClass: "pinned",
      toolchain: TOOLCHAIN,
      rule: { find: "foo\\(([a-zA-Z]+)\\)", replace: "foo($1, ctx)", flags: "g" },
      inputSelector: [{ path: "a.ts" }],
      writeScope: [] // nothing may be written
    };
    const outcome = reapply(recipe, originalResult, newBase);
    expect(outcome.kind).toBe("HardFailure");
    if (outcome.kind === "HardFailure") {
      expect(outcome.reason).toBe("engine_error");
    }
  });

  it("an invalid rule shape is an engine error", () => {
    const recipe: Recipe = {
      engine: "regex-replace",
      determinismClass: "pinned",
      toolchain: TOOLCHAIN,
      rule: { replace: "foo($1, ctx)" }, // missing `find`
      inputSelector: [{ path: "a.ts" }],
      writeScope: [{ path: "a.ts" }]
    };
    const outcome = reapply(recipe, originalResult, newBase);
    expect(outcome.kind).toBe("HardFailure");
    if (outcome.kind === "HardFailure") {
      expect(outcome.reason).toBe("engine_error");
    }
  });

  it("a deterministic but non-idempotent rule still reapplies cleanly (determinism != idempotence)", () => {
    const cell = mintNodeIdent(TX, 4, "a.ts");
    const seed = stateOf([["a.ts", cellOf(cell, "x")]]);
    const recipe: Recipe = {
      engine: "regex-replace",
      determinismClass: "pinned",
      toolchain: TOOLCHAIN,
      // Not a fixpoint of itself (re-running over its OWN output would keep
      // appending), but deterministic: the same input always yields "xy".
      // The self-check must NOT reject this (the common "add an argument" case).
      rule: { find: "x", replace: "xy", flags: "g" },
      inputSelector: [{ path: "a.ts" }],
      writeScope: [{ path: "a.ts" }]
    };
    const outcome = reapply(recipe, seed, seed);
    expect(outcome.kind).toBe("CleanReapply");
    if (outcome.kind === "CleanReapply") {
      expect(outcome.changedResult).toBe(true);
    }
  });
});

describe("reapply — Divergence (never auto-landed)", () => {
  const nid = mintNodeIdent(TX, 5, "a.ts");
  const newBase = stateOf([["a.ts", cellOf(nid, "foo(x)")]]);
  const originalResult = stateOf([["a.ts", cellOf(nid, "foo(x, ctx)")]]);

  it("diverges when an invariant is violated (max_cells_written)", () => {
    // A moved base where the recompute genuinely changes the result, so the
    // Divergence report's expected (original) and actual (candidate) differ.
    const movedBase = stateOf([["a.ts", cellOf(nid, "foo(x) foo(y)")]]);
    const recipe: Recipe = {
      ...CTX_CODEMOD,
      inputSelector: [{ path: "a.ts" }],
      writeScope: [{ path: "a.ts" }],
      invariants: [{ kind: "max_cells_written", limit: 0 }]
    };
    const outcome = reapply(recipe, originalResult, movedBase);
    expect(outcome.kind).toBe("Divergence");
    if (outcome.kind === "Divergence") {
      expect(outcome.expected).toBe(stateAddress(originalResult));
      expect(outcome.actual).toBe(
        stateAddress(stateOf([["a.ts", cellOf(nid, "foo(x, ctx) foo(y, ctx)")]]))
      );
      expect(outcome.actual).not.toBe(outcome.expected);
      expect(outcome.report).toContain("max_cells_written");
    }
  });

  it("diverges when a path_unchanged invariant is violated", () => {
    const recipe: Recipe = {
      ...CTX_CODEMOD,
      inputSelector: [{ path: "a.ts" }],
      writeScope: [{ path: "a.ts" }],
      invariants: [{ kind: "path_unchanged", path: "a.ts" }]
    };
    const outcome = reapply(recipe, originalResult, newBase);
    expect(outcome.kind).toBe("Divergence");
    if (outcome.kind === "Divergence") {
      expect(outcome.report).toContain("path_unchanged");
    }
  });

  it("diverges when the recompute does not match expectedResultDigest", () => {
    const wrongDigest = stateAddress(stateOf([["a.ts", cellOf(nid, "totally different")]]));
    const recipe: Recipe = {
      ...CTX_CODEMOD,
      inputSelector: [{ path: "a.ts" }],
      writeScope: [{ path: "a.ts" }],
      expectedResultDigest: wrongDigest
    };
    const outcome = reapply(recipe, originalResult, newBase);
    expect(outcome.kind).toBe("Divergence");
    if (outcome.kind === "Divergence") {
      expect(outcome.expected).toBe(wrongDigest);
    }
  });

  it("passes expectedResultDigest when it matches the recompute", () => {
    const expected = stateAddress(stateOf([["a.ts", cellOf(nid, "foo(x, ctx)")]]));
    const recipe: Recipe = {
      ...CTX_CODEMOD,
      inputSelector: [{ path: "a.ts" }],
      writeScope: [{ path: "a.ts" }],
      expectedResultDigest: expected
    };
    const outcome = reapply(recipe, originalResult, newBase);
    expect(outcome.kind).toBe("CleanReapply");
  });
});
