import { describe, expect, it } from "vitest";

import {
  createVerificationBundle,
  detectForkUnderPartition,
  quorumFor,
  reconcile,
  reconcileMany,
  verifyBundle
} from "./bundle.js";
import { WitnessSet } from "./witness.js";

function key(seed: number): Uint8Array {
  return new TextEncoder().encode(`key-${seed}`);
}

const witnesses = new WitnessSet([
  { did: "did:loom:w1", key: key(1) },
  { did: "did:loom:w2", key: key(2) },
  { did: "did:loom:w3", key: key(3) }
]);

function bundle(
  authority: string,
  cid: string,
  sequence: number,
  sigDids: string[],
  set: WitnessSet = witnesses
): ReturnType<typeof createVerificationBundle> {
  return createVerificationBundle(
    authority,
    cid,
    sequence,
    sigDids.map((did) => set.sign(did, cid, sequence))
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

describe("quorum configuration", () => {
  it("resolves the default quorum for an authority without an override", () => {
    expect(quorumFor({ defaultQuorum: 2 }, "auth-a")).toBe(2);
  });

  it("applies a per-authority override", () => {
    const config = { defaultQuorum: 2, perAuthority: { "auth-primary": 3 } };
    expect(quorumFor(config, "auth-primary")).toBe(3);
    expect(quorumFor(config, "auth-replica")).toBe(2);
  });
});

describe("multi-authority reconciliation (reconcileMany)", () => {
  const many = new WitnessSet([
    { did: "did:loom:w1", key: key(1) },
    { did: "did:loom:w2", key: key(2) },
    { did: "did:loom:w3", key: key(3) },
    { did: "did:loom:w4", key: key(4) },
    { did: "did:loom:w5", key: key(5) }
  ]);

  it("reconciles three authorities that agree on the same checkpoint", () => {
    const bundles = [
      bundle("auth-a", "cid:c", 1, ["did:loom:w1", "did:loom:w2"], many),
      bundle("auth-b", "cid:c", 1, ["did:loom:w2", "did:loom:w3"], many),
      bundle("auth-c", "cid:c", 1, ["did:loom:w3", "did:loom:w4"], many)
    ];
    expect(reconcileMany(bundles, many, { defaultQuorum: 2 })).toEqual({
      consistent: true,
      checkpointCid: "cid:c"
    });
  });

  it("detects a fork across three authorities when one disagrees", () => {
    const bundles = [
      bundle("auth-a", "cid:c", 1, ["did:loom:w1", "did:loom:w2"], many),
      bundle("auth-b", "cid:c", 1, ["did:loom:w2", "did:loom:w3"], many),
      bundle("auth-c", "cid:evil", 1, ["did:loom:w3", "did:loom:w4"], many)
    ];
    const result = reconcileMany(bundles, many, { defaultQuorum: 2 });
    expect(result.consistent).toBe(false);
    expect(result.consistent === false && result.reason).toBe("fork");
  });

  it("reports no_quorum when a bundle fails its per-authority quorum", () => {
    const bundles = [
      bundle("auth-primary", "cid:c", 1, ["did:loom:w1", "did:loom:w2"], many),
      bundle("auth-replica", "cid:c", 1, ["did:loom:w1", "did:loom:w2"], many)
    ];
    const result = reconcileMany(bundles, many, {
      defaultQuorum: 2,
      perAuthority: { "auth-primary": 3 }
    });
    expect(result.consistent).toBe(false);
    expect(result.consistent === false && result.reason).toBe("no_quorum");
  });

  it("reports no_quorum for empty input or mixed sequences", () => {
    expect(reconcileMany([], many, { defaultQuorum: 2 }).consistent).toBe(false);
    const mixed = [
      bundle("auth-a", "cid:c", 1, ["did:loom:w1", "did:loom:w2"], many),
      bundle("auth-b", "cid:c", 2, ["did:loom:w1", "did:loom:w2"], many)
    ];
    expect(reconcileMany(mixed, many, { defaultQuorum: 2 }).consistent).toBe(false);
  });
});

describe("partition fault-injection", () => {
  const many = new WitnessSet([
    { did: "did:loom:w1", key: key(1) },
    { did: "did:loom:w2", key: key(2) },
    { did: "did:loom:w3", key: key(3) },
    { did: "did:loom:w4", key: key(4) }
  ]);

  it("detects a fork when two partitions reach quorum on different checkpoints", () => {
    const result = detectForkUnderPartition(
      [
        {
          name: "p1",
          checkpointCid: "cid:a",
          sequence: 1,
          authorities: [
            { name: "auth-a", signatures: [many.sign("did:loom:w1", "cid:a", 1), many.sign("did:loom:w2", "cid:a", 1)] }
          ]
        },
        {
          name: "p2",
          checkpointCid: "cid:b",
          sequence: 1,
          authorities: [
            { name: "auth-b", signatures: [many.sign("did:loom:w3", "cid:b", 1), many.sign("did:loom:w4", "cid:b", 1)] }
          ]
        }
      ],
      many,
      { defaultQuorum: 2 }
    );
    expect(result.fork).toBe(true);
  });

  it("does not flag a fork when partitions agree on the same checkpoint", () => {
    const result = detectForkUnderPartition(
      [
        {
          name: "p1",
          checkpointCid: "cid:c",
          sequence: 1,
          authorities: [
            { name: "auth-a", signatures: [many.sign("did:loom:w1", "cid:c", 1), many.sign("did:loom:w2", "cid:c", 1)] }
          ]
        },
        {
          name: "p2",
          checkpointCid: "cid:c",
          sequence: 1,
          authorities: [
            { name: "auth-b", signatures: [many.sign("did:loom:w3", "cid:c", 1), many.sign("did:loom:w4", "cid:c", 1)] }
          ]
        }
      ],
      many,
      { defaultQuorum: 2 }
    );
    expect(result.fork).toBe(false);
  });

  it("does not flag a fork when neither partition reaches quorum (fail closed)", () => {
    const result = detectForkUnderPartition(
      [
        {
          name: "p1",
          checkpointCid: "cid:a",
          sequence: 1,
          authorities: [{ name: "auth-a", signatures: [many.sign("did:loom:w1", "cid:a", 1)] }]
        },
        {
          name: "p2",
          checkpointCid: "cid:b",
          sequence: 1,
          authorities: [{ name: "auth-b", signatures: [many.sign("did:loom:w2", "cid:b", 1)] }]
        }
      ],
      many,
      { defaultQuorum: 2 }
    );
    expect(result.fork).toBe(false);
  });
});
