import { describe, expect, it } from "vitest";

import { WitnessSet } from "./witness.js";

function key(seed: number): Uint8Array {
  return new TextEncoder().encode(`witness-key-${seed}`);
}

const witnesses = [
  { did: "did:loom:w1", key: key(1) },
  { did: "did:loom:w2", key: key(2) },
  { did: "did:loom:w3", key: key(3) }
];

describe("witnessed trust", () => {
  const set = new WitnessSet(witnesses);

  it("signs and verifies a checkpoint", () => {
    const sig = set.sign("did:loom:w1", "cid:checkpoint", 1);
    expect(set.verify(sig)).toBe(true);
  });

  it("rejects a tampered signature or unknown witness", () => {
    const sig = set.sign("did:loom:w1", "cid:checkpoint", 1);
    expect(set.verify({ ...sig, signature: "tampered" })).toBe(false);
    expect(set.verify({ ...sig, witnessDid: "did:loom:unknown" })).toBe(false);
  });

  it("reaches quorum only with enough distinct valid signatures", () => {
    const sigs = [set.sign("did:loom:w1", "cid:c", 1), set.sign("did:loom:w2", "cid:c", 1)];
    expect(set.quorumReached(sigs, "cid:c", 2)).toBe(true);
    expect(set.quorumReached(sigs, "cid:c", 3)).toBe(false);
    // A duplicate from the same witness does not count twice.
    expect(set.quorumReached([...sigs, set.sign("did:loom:w1", "cid:c", 1)], "cid:c", 3)).toBe(
      false
    );
  });

  it("detects a fork (split view) when two checkpoints both reach quorum", () => {
    const a = [set.sign("did:loom:w1", "cid:a", 1), set.sign("did:loom:w2", "cid:a", 1)];
    const b = [set.sign("did:loom:w1", "cid:b", 1), set.sign("did:loom:w2", "cid:b", 1)];
    // Both reach quorum=2 on different checkpoints at sequence 1 -> fork.
    expect(set.detectFork(a, b, 1, 2)).toBe(true);
  });

  it("does not flag a consistent checkpoint as a fork", () => {
    const a = [set.sign("did:loom:w1", "cid:c", 1), set.sign("did:loom:w2", "cid:c", 1)];
    const b = [set.sign("did:loom:w1", "cid:c", 1), set.sign("did:loom:w3", "cid:c", 1)];
    expect(set.detectFork(a, b, 1, 2)).toBe(false);
  });
});
