import { describe, expect, it } from "vitest";
import {
  BLOCKABLE_CONFIDENCES,
  confidenceCanBlock,
  policyModeAllowsBlocking,
  type FactConfidence,
  type PolicyMode
} from "./types.js";

// The Record types below are exhaustive by construction: adding a new
// FactConfidence or PolicyMode without deciding its blocking semantics is a
// compile error here, which forces the trust-model decision to be explicit.
const confidenceCanBlockByValue: Record<FactConfidence, boolean> = {
  verified: true,
  observed: true,
  inferred: false,
  attested: false
};

const modeAllowsBlockingByValue: Record<PolicyMode, boolean> = {
  observe: false,
  warn: false,
  enforce: true,
  optimize: true
};

describe("trust model invariants", () => {
  it("only verified and observed confidences can ever block", () => {
    for (const [confidence, canBlock] of Object.entries(confidenceCanBlockByValue)) {
      expect(confidenceCanBlock(confidence as FactConfidence)).toBe(canBlock);
    }
  });

  it("never lets inferred or attested findings block", () => {
    expect(confidenceCanBlock("inferred")).toBe(false);
    expect(confidenceCanBlock("attested")).toBe(false);
    expect(BLOCKABLE_CONFIDENCES.has("inferred")).toBe(false);
    expect(BLOCKABLE_CONFIDENCES.has("attested")).toBe(false);
  });

  it("only enforce and optimize modes allow blocking", () => {
    for (const [mode, allowsBlocking] of Object.entries(modeAllowsBlockingByValue)) {
      expect(policyModeAllowsBlocking(mode as PolicyMode)).toBe(allowsBlocking);
    }
  });

  it("never lets observe or warn modes block", () => {
    expect(policyModeAllowsBlocking("observe")).toBe(false);
    expect(policyModeAllowsBlocking("warn")).toBe(false);
  });
});
