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
    const outcome = reapply(CTX_CODEMOD, originalResult, newBase, TOOLCHAIN);
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
  it("rejects regex recipes with catastrophic-backtracking constructs", () => {
    const nid = mintNodeIdent(TX, 4, "a.ts");
    const recipe: Recipe = {
      ...CTX_CODEMOD,
      rule: { find: "(a+)+$", replace: "x" },
      inputSelector: [{ path: "a.ts" }],
      writeScope: [{ path: "a.ts" }]
    };
    const outcome = reapply(
      recipe,
      stateOf([["a.ts", cellOf(nid, "x")]]),
      stateOf([["a.ts", cellOf(nid, `${"a".repeat(10_000)}!`)]]),
      TOOLCHAIN
    );
    expect(outcome.kind).toBe("HardFailure");
    if (outcome.kind === "HardFailure") expect(outcome.reason).toBe("engine_error");
  });

  it("rejects regex inputs above the bounded execution size", () => {
    const nid = mintNodeIdent(TX, 5, "a.ts");
    const recipe: Recipe = {
      ...CTX_CODEMOD,
      rule: { find: "a+", replace: "b", flags: "g" },
      inputSelector: [{ path: "a.ts" }],
      writeScope: [{ path: "a.ts" }]
    };
    const outcome = reapply(
      recipe,
      stateOf([["a.ts", cellOf(nid, "")]]),
      stateOf([["a.ts", cellOf(nid, `${"a".repeat(256 * 1024 + 1)}`)]]),
      TOOLCHAIN
    );
    expect(outcome.kind).toBe("HardFailure");
    if (outcome.kind === "HardFailure") expect(outcome.reason).toBe("engine_error");
  });

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
    const outcome = reapply(recipe, newBase, newBase, TOOLCHAIN);
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
    const outcome = reapply(recipe, originalResult, newBase, TOOLCHAIN);
    expect(outcome.kind).toBe("CleanReapply");
    if (outcome.kind === "CleanReapply") {
      expect(textAt(outcome.resultState, "a.ts")).toBe("foo(x, ctx)");
      expect(outcome.changedResult).toBe(false);
    }
  });
});

describe("reapply — eligibility and execution toolchain", () => {
  const nid = mintNodeIdent(TX, 6, "a.ts");
  const newBase = stateOf([["a.ts", cellOf(nid, "foo(x)")]]);
  const originalResult = stateOf([["a.ts", cellOf(nid, "foo(x, ctx)")]]);
  const pinnedRecipe: Recipe = {
    ...CTX_CODEMOD,
    inputSelector: [{ path: "a.ts" }],
    writeScope: [{ path: "a.ts" }]
  };
  const environmentToolchain: ToolchainLock = {
    engineDigest: TOOLCHAIN.engineDigest,
    runtimeDigest: TOOLCHAIN.runtimeDigest,
    env: { LANG: "C.UTF-8", TZ: "UTC" }
  };
  const environmentRecipe: Recipe = {
    ...pinnedRecipe,
    toolchain: environmentToolchain
  };

  it("rejects an environment-sensitive recipe as nondeterministic even with a matching lock", () => {
    const outcome = reapply(
      { ...pinnedRecipe, determinismClass: "environment-sensitive" },
      originalResult,
      newBase,
      TOOLCHAIN
    );
    expect(outcome.kind).toBe("HardFailure");
    if (outcome.kind === "HardFailure") {
      expect(outcome.reason).toBe("nondeterministic");
    }
  });

  it("fails closed with toolchain_mismatch when execution context is missing", () => {
    // Reflect models an untyped/runtime caller bypassing the required fourth
    // TypeScript argument. The implementation must still reject it safely.
    const outcome = Reflect.apply(reapply, undefined, [
      pinnedRecipe,
      originalResult,
      newBase
    ]) as ReturnType<typeof reapply>;
    expect(outcome.kind).toBe("HardFailure");
    if (outcome.kind === "HardFailure") {
      expect(outcome.reason).toBe("toolchain_mismatch");
      expect(outcome.detail).toContain("explicit execution ToolchainLock");
    }
  });

  it.each([
    ["engineDigest", { engineDigest: "engine@2", runtimeDigest: TOOLCHAIN.runtimeDigest }],
    ["runtimeDigest", { engineDigest: TOOLCHAIN.engineDigest, runtimeDigest: "node@23" }]
  ] satisfies ReadonlyArray<readonly [string, ToolchainLock]>)(
    "rejects an execution %s mismatch",
    (_field, executionToolchain) => {
      const outcome = reapply(pinnedRecipe, originalResult, newBase, executionToolchain);
      expect(outcome.kind).toBe("HardFailure");
      if (outcome.kind === "HardFailure") {
        expect(outcome.reason).toBe("toolchain_mismatch");
      }
    }
  );

  it.each([
    [
      "changed value",
      {
        engineDigest: TOOLCHAIN.engineDigest,
        runtimeDigest: TOOLCHAIN.runtimeDigest,
        env: { LANG: "C.UTF-8", TZ: "Pacific/Auckland" }
      }
    ],
    [
      "missing key",
      {
        engineDigest: TOOLCHAIN.engineDigest,
        runtimeDigest: TOOLCHAIN.runtimeDigest,
        env: { LANG: "C.UTF-8" }
      }
    ],
    [
      "extra key",
      {
        engineDigest: TOOLCHAIN.engineDigest,
        runtimeDigest: TOOLCHAIN.runtimeDigest,
        env: { CI: "true", LANG: "C.UTF-8", TZ: "UTC" }
      }
    ],
    ["missing env", TOOLCHAIN]
  ] satisfies ReadonlyArray<readonly [string, ToolchainLock]>)(
    "rejects an execution env with a %s mismatch",
    (_case, executionToolchain) => {
      const outcome = reapply(environmentRecipe, originalResult, newBase, executionToolchain);
      expect(outcome.kind).toBe("HardFailure");
      if (outcome.kind === "HardFailure") {
        expect(outcome.reason).toBe("toolchain_mismatch");
      }
    }
  );

  it("accepts equal environment key/value pairs regardless of insertion order", () => {
    const executionToolchain: ToolchainLock = {
      engineDigest: TOOLCHAIN.engineDigest,
      runtimeDigest: TOOLCHAIN.runtimeDigest,
      env: { TZ: "UTC", LANG: "C.UTF-8" }
    };
    const outcome = reapply(environmentRecipe, originalResult, newBase, executionToolchain);
    expect(outcome.kind).toBe("CleanReapply");
    if (outcome.kind === "CleanReapply") {
      expect(textAt(outcome.resultState, "a.ts")).toBe("foo(x, ctx)");
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
    const outcome = reapply(recipe, originalResult, newBase, TOOLCHAIN);
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
    const outcome = reapply(recipe, originalResult, newBase, TOOLCHAIN);
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
    const outcome = reapply(recipe, originalResult, newBase, TOOLCHAIN);
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
    const outcome = reapply(recipe, originalResult, newBase, TOOLCHAIN);
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
    const outcome = reapply(recipe, seed, seed, TOOLCHAIN);
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
    const outcome = reapply(recipe, originalResult, movedBase, TOOLCHAIN);
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
    const outcome = reapply(recipe, originalResult, newBase, TOOLCHAIN);
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
    const outcome = reapply(recipe, originalResult, newBase, TOOLCHAIN);
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
    const outcome = reapply(recipe, originalResult, newBase, TOOLCHAIN);
    expect(outcome.kind).toBe("CleanReapply");
  });
});

describe("reapply — hostile cell path safety", () => {
  function nullPrototypeState(entries: ReadonlyArray<readonly [string, Cell]>): State {
    const cells = Object.create(null) as Record<string, Cell>;
    for (const [path, cell] of entries) {
      cells[path] = cell;
    }
    return { kind: "state", cells };
  }

  it("preserves a null-prototype cell map and prototype-like own paths", () => {
    const paths = ["__proto__", "constructor", "toString"] as const;
    const base = nullPrototypeState(
      paths.map((path, index): readonly [string, Cell] => [
        path,
        cellOf(mintNodeIdent(TX, 20 + index, path), "x")
      ])
    );
    const recipe: Recipe = {
      engine: "regex-replace",
      determinismClass: "pinned",
      toolchain: TOOLCHAIN,
      rule: { find: "x", replace: "y", flags: "g" },
      inputSelector: paths.map((path) => ({ path })),
      writeScope: paths.map((path) => ({ path }))
    };

    const outcome = reapply(recipe, base, base, TOOLCHAIN);
    expect(outcome.kind).toBe("CleanReapply");
    if (outcome.kind === "CleanReapply") {
      expect(Object.getPrototypeOf(outcome.resultState.cells)).toBeNull();
      for (const path of paths) {
        expect(Object.hasOwn(outcome.resultState.cells, path)).toBe(true);
        expect(outcome.resultState.cells[path]?.text).toBe("y");
      }
    }
  });

  it("treats a missing inherited-name invariant path as absent without throwing", () => {
    const ident = mintNodeIdent(TX, 30, "a.ts");
    const base = nullPrototypeState([["a.ts", cellOf(ident, "x")]]);
    const recipe: Recipe = {
      engine: "regex-replace",
      determinismClass: "pinned",
      toolchain: TOOLCHAIN,
      rule: { find: "x", replace: "y" },
      inputSelector: [{ path: "a.ts" }],
      writeScope: [{ path: "a.ts" }],
      invariants: [{ kind: "path_unchanged", path: "constructor" }]
    };
    let outcome: ReturnType<typeof reapply> | undefined;

    expect(() => {
      outcome = reapply(recipe, base, base, TOOLCHAIN);
    }).not.toThrow();
    expect(outcome?.kind).toBe("CleanReapply");
    if (outcome?.kind === "CleanReapply") {
      expect(Object.getPrototypeOf(outcome.resultState.cells)).toBeNull();
      expect(Object.hasOwn(outcome.resultState.cells, "constructor")).toBe(false);
    }
  });
});
