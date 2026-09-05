import { describe, expect, it } from "vitest";

import type { Recipe } from "./types.js";
import {
  DEFAULT_SANDBOX_LIMITS,
  runEngineBounded,
  validateRecipeBudget,
  type EngineRunner,
  type SandboxLimits
} from "./sandbox.js";

const recipe = (overrides: Partial<Recipe> = {}): Recipe => ({
  engine: "regex-replace",
  determinismClass: "pinned",
  toolchain: { engineDigest: "e", runtimeDigest: "r" },
  rule: { find: "a", replace: "b" },
  inputSelector: [{ path: "a.ts" }],
  writeScope: [{ path: "a.ts" }],
  ...overrides
});

const runner: EngineRunner = {
  run: (inputs) => new Map(inputs.map((input) => [input.path, input.cell.text.toUpperCase()]))
};

const tightLimits: SandboxLimits = {
  ...DEFAULT_SANDBOX_LIMITS,
  maxInputs: 2,
  maxWrites: 2,
  maxWriteBytes: 5,
  maxTotalWriteBytes: 10
};

describe("validateRecipeBudget", () => {
  it("accepts a well-bounded recipe", () => {
    expect(validateRecipeBudget(recipe())).toBeUndefined();
  });

  it("rejects an oversized inputSelector", () => {
    const r = recipe({
      inputSelector: Array.from({ length: DEFAULT_SANDBOX_LIMITS.maxInputs + 1 }, (_, i) => ({
        path: `p${i}`
      }))
    });
    expect(validateRecipeBudget(r)).toMatch(/maxInputs/);
  });

  it("rejects an oversized writeScope", () => {
    const r = recipe({
      writeScope: Array.from({ length: DEFAULT_SANDBOX_LIMITS.maxWrites + 1 }, (_, i) => ({
        path: `p${i}`
      }))
    });
    expect(validateRecipeBudget(r)).toMatch(/maxWrites/);
  });

  it("rejects an oversized rule payload", () => {
    const r = recipe({
      rule: { find: "a".repeat(DEFAULT_SANDBOX_LIMITS.maxRuleBytes + 1), replace: "b" }
    });
    expect(validateRecipeBudget(r)).toMatch(/maxRuleBytes/);
  });

  it("rejects too many invariants", () => {
    const r = recipe({
      invariants: Array.from({ length: DEFAULT_SANDBOX_LIMITS.maxInvariants + 1 }, () => ({
        kind: "path_unchanged",
        path: "a.ts"
      }))
    });
    expect(validateRecipeBudget(r)).toMatch(/maxInvariants/);
  });
});

describe("runEngineBounded", () => {
  it("runs normally within budget", () => {
    const writes = runEngineBounded(
      runner,
      [{ path: "a.ts", cell: { text: "hello" } }],
      tightLimits
    );
    expect(writes.get("a.ts")).toBe("HELLO");
  });

  it("throws when the input count exceeds the budget", () => {
    const inputs = Array.from({ length: 3 }, (_, i) => ({ path: `p${i}`, cell: { text: "x" } }));
    expect(() => runEngineBounded(runner, inputs, tightLimits)).toThrow(/maxInputs/);
  });

  it("throws when a single write exceeds maxWriteBytes", () => {
    const long = { path: "a.ts", cell: { text: "x".repeat(100) } };
    expect(() => runEngineBounded(runner, [long], tightLimits)).toThrow(/maxWriteBytes/);
  });

  it("throws when total write bytes exceed the budget", () => {
    const inputs = [
      { path: "a.ts", cell: { text: "aaaa" } },
      { path: "b.ts", cell: { text: "bbbb" } }
    ];
    // 4 + 4 = 8 bytes total, within maxTotalWriteBytes=10 but each <= 5.
    const writes = runEngineBounded(runner, inputs, tightLimits);
    expect(writes.size).toBe(2);
  });

  it("throws when the number of distinct writes exceeds the budget", () => {
    const manyRunner: EngineRunner = {
      run: () => new Map(Array.from({ length: 3 }, (_, i) => [`p${i}`, "x"]))
    };
    expect(() =>
      runEngineBounded(manyRunner, [{ path: "a.ts", cell: { text: "x" } }], tightLimits)
    ).toThrow(/maxWrites/);
  });
});
