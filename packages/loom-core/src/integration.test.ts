import { describe, it, expect } from "vitest";
import {
  applyOps,
  authorize,
  emptyState,
  factCacheKey,
  impliedEffects,
  mergeStates,
  mintNodeIdent,
  reapply,
  stateAddress,
  verifyEffects,
  type Cell,
  type Cid,
  type Did,
  type Grant,
  type Recipe,
  type State
} from "./index.js";

// Cross-module integration: exercises the public barrel and proves the modules
// compose into the worked scenario from docs/loom/reapply-merge-engine.md §5.2
// (agent-authored codemod, base advances, reapply recomputes, governance authorizes).

const T0 = "loom:sha256:genesis" as Cid;
const nidA = mintNodeIdent(T0, 0, "callers/a.ts");
const nidB = mintNodeIdent(T0, 1, "callers/b.ts");
const nidTest = mintNodeIdent(T0, 2, "tests/util.test.ts");

function requireState(state: State, ops: Parameters<typeof applyOps>[1]): State {
  const result = applyOps(state, ops);
  if (!result.ok) {
    throw new Error(`setup applyOps failed: ${result.error.detail}`);
  }
  return result.state;
}

function textAt(state: State, path: string): string | undefined {
  return state.cells[path]?.text;
}

const base = requireState(emptyState(), [
  { op: "put_cell", at: "callers/a.ts", ident: nidA, facet: "text", text: "foo(x)" },
  { op: "put_cell", at: "callers/b.ts", ident: nidB, facet: "text", text: "foo(x)" }
]);

const codemod: Recipe = {
  engine: "regex-replace",
  determinismClass: "pinned",
  toolchain: { engineDigest: "e1", runtimeDigest: "r1" },
  rule: { find: "foo\\(([^)]*)\\)", replace: "foo($1, ctx)", flags: "g" },
  inputSelector: [{ path: "callers/a.ts" }, { path: "callers/b.ts" }],
  writeScope: [{ path: "callers/a.ts" }, { path: "callers/b.ts" }]
};

describe("loom-core integration — codemod → reapply → governance", () => {
  it("authors the codemod result over the base (reapply is the authoring primitive)", () => {
    const authored = reapply(codemod, base, base, codemod.toolchain);
    expect(authored.kind).toBe("CleanReapply");
    if (authored.kind === "CleanReapply") {
      expect(textAt(authored.resultState, "callers/a.ts")).toBe("foo(x, ctx)");
      expect(textAt(authored.resultState, "callers/b.ts")).toBe("foo(x, ctx)");
    }
  });

  it("recomputes over an advanced base that added a conflicting call", () => {
    const authored = reapply(codemod, base, base, codemod.toolchain);
    if (authored.kind !== "CleanReapply") throw new Error("authoring failed");
    // Base advances: a teammate adds foo(y) on callers/a.ts.
    const advanced = requireState(base, [
      { op: "put_cell", at: "callers/a.ts", ident: nidA, facet: "text", text: "foo(x) foo(y)" }
    ]);
    const outcome = reapply(codemod, authored.resultState, advanced, codemod.toolchain);
    expect(outcome.kind).toBe("CleanReapply");
    if (outcome.kind === "CleanReapply") {
      // The new call is transformed too — the intent, not the old diff, was rebased.
      expect(textAt(outcome.resultState, "callers/a.ts")).toBe("foo(x, ctx) foo(y, ctx)");
      expect(outcome.changedResult).toBe(true);
    }
  });

  it("verifies declared effects against a delete-test change (algebra)", () => {
    const withTest = requireState(base, [
      {
        op: "put_cell",
        at: "tests/util.test.ts",
        ident: nidTest,
        facet: "text",
        text: "expect(1).toBe(1)"
      }
    ]);
    const ops = [{ op: "delete_cell", sel: { path: "tests/util.test.ts" } }] as const;
    const implied = impliedEffects(withTest, ops);
    expect(implied).toContain("deletes_test");
    expect(verifyEffects(["deletes_source", "deletes_test"], implied).ok).toBe(true);
    expect(verifyEffects(["deletes_source"], implied).ok).toBe(false); // under-declared
  });

  it("authorizes the change via a Grant chain rooted at the controller", () => {
    const controller = "did:loom:ctrl" as Did;
    const agent = "did:loom:agent" as Did;
    const grant: Grant = {
      issuer: controller,
      audience: agent,
      transformTypes: ["*"],
      cellSelectors: ["callers/**"],
      effectBounds: {
        maxCellsTouched: 10,
        allowDelete: false,
        allowSensitive: false,
        allowedEffectKinds: ["edits_source"]
      }
    };
    const okDecision = authorize({
      chain: [grant],
      actor: agent,
      controller,
      base,
      ops: [
        {
          op: "patch_text",
          sel: { path: "callers/a.ts" },
          range: [0, 0],
          text: "// governed\n"
        }
      ],
      effects: ["edits_source"]
    });
    expect(okDecision.ok).toBe(true);

    const denied = authorize({
      chain: [grant],
      actor: agent,
      controller,
      base,
      ops: [
        {
          op: "put_cell",
          at: "secrets/key.txt",
          ident: mintNodeIdent(T0, 3, "secrets/key.txt"),
          facet: "text",
          text: "not-a-secret"
        }
      ],
      effects: ["edits_source"]
    });
    expect(denied.ok).toBe(false);
  });

  it("produces a stable, field-order-insensitive fact cache key", () => {
    const authored = reapply(codemod, base, base, codemod.toolchain);
    if (authored.kind !== "CleanReapply") throw new Error("authoring failed");
    const resultCid = stateAddress(authored.resultState);
    const k1 = factCacheKey({
      detectorRegistryVersion: "1.0.0",
      baseState: stateAddress(base),
      resultState: resultCid,
      diffViewDigest: "d1",
      toolchainDigest: "t1",
      policyVersionHash: "p1"
    });
    const k2 = factCacheKey({
      policyVersionHash: "p1",
      toolchainDigest: "t1",
      diffViewDigest: "d1",
      resultState: resultCid,
      baseState: stateAddress(base),
      detectorRegistryVersion: "1.0.0"
    });
    expect(k1).toBe(k2);
  });

  it("merges independent edits on different cells without conflict", () => {
    const ours = requireState(base, [
      { op: "patch_text", sel: { path: "callers/a.ts" }, range: [0, 6], text: "bar(x)" }
    ]);
    const theirs = requireState(base, [
      { op: "patch_text", sel: { path: "callers/b.ts" }, range: [0, 6], text: "baz(x)" }
    ]);
    const merged = mergeStates(base, ours, theirs);
    expect(merged.conflicts).toHaveLength(0);
    expect(textAt(merged.candidate, "callers/a.ts")).toBe("bar(x)");
    expect(textAt(merged.candidate, "callers/b.ts")).toBe("baz(x)");
  });
});
