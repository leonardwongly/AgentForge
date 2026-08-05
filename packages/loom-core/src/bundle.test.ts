import { describe, expect, it } from "vitest";

import { createVerificationBundle, reconcile, verifyBundle } from "./bundle.js";
import { WitnessSet } from "./witness.js";

function key(seed: number): Uint8Array {
  return new TextEncoder().encode(`key-${seed}`);
}

const witnesses = new WitnessSet([
  { did: "did:loom:w1", key: key(1) },
  { did: "did:loom:w2", key: key(2) },
  { did: "did:loom:w3", key: key(3) }
]);

function bundle(authority: string, cid: string, sequence: number, sigDids: string[]): ReturnType<typeof createVerificationBundle> {
  return createVerificationBundle(
    authority,
    cid,
    sequence,
    sigDids.map((did) => witnesses.sign(did, cid, sequence))
  );
}

describe("verification bundles", () => {
  it("verifies offline when the bundle reaches quorum", () => {
    const b = bundle("auth-a", "cid:c", 1, ["did:loom:w1", "did:loom:w2"]);
    expect(verifyBundle(b, witnesses, 2)).toBe(true);
    expect(verifyBundle(b, witnesses, 3)).toBe(false);
  });

  it("reconciles two consistent bundles", () => {
    const a = bundle("auth-a", "cid:c", 1, ["did:loom:w1", "did:loom:w2"]);
    const b = bundle("auth-b", "cid:c", 1, ["did:loom:w1", "did:loom:w3"]);
    expect(reconcile(a, b, witnesses, 2)).toEqual({ consistent: true });
  });

  it("detects a fork when authorities witness different checkpoints", () => {
    const a = bundle("auth-a", "cid:a", 1, ["did:loom:w1", "did:loom:w2"]);
    const b = bundle("auth-b", "cid:b", 1, ["did:loom:w1", "did:loom:w2"]);
    const result = reconcile(a, b, witnesses, 2);
    expect(result.consistent).toBe(false);
    expect(result.consistent === false && result.reason).toBe("fork");
  });

  it("reports no_quorum when a bundle lacks quorum", () => {
    const a = bundle("auth-a", "cid:c", 1, ["did:loom:w1"]);
    const b = bundle("auth-b", "cid:c", 1, ["did:loom:w1", "did:loom:w2"]);
    const result = reconcile(a, b, witnesses, 2);
    expect(result.consistent).toBe(false);
    expect(result.consistent === false && result.reason).toBe("no_quorum");
  });
});
