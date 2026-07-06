import { describe, expect, it } from "vitest";

import type { VerifiedFact } from "@agentforge/core";
import type { Cid } from "@agentforge/loom-core";

import {
  buildDeterministicCheckStatement,
  factsDigest,
  generateKeyPair,
  pae,
  signStatement,
  verifyEnvelope,
  verifyProvenance
} from "./provenance.js";
import {
  DETERMINISTIC_CHECK_PREDICATE_TYPE,
  INTOTO_STATEMENT_TYPE,
  type DeterministicCheckInput,
  type DeterministicCheckPredicate,
  type DsseEnvelope,
  type InTotoStatement
} from "./types.js";

const cid = (value: string): Cid => value as Cid;

const fact = (id: string): VerifiedFact => ({
  id,
  type: "sensitive_path_changed",
  source: "github_diff",
  evidence: `evidence-${id}`,
  confidence: "verified"
});

const baseInput: DeterministicCheckInput = {
  transformCid: cid("loom:sha256:abc123"),
  checkerDid: "did:key:checker",
  detectorSuiteVersion: "detector-suite@1",
  baseState: cid("loom:sha256:basestate"),
  resultState: cid("loom:sha256:resultstate"),
  policyVersion: "policy@1",
  facts: [fact("f1"), fact("f2")],
  decision: "pass"
};

describe("generateKeyPair", () => {
  it("returns PEM-encoded SPKI public and PKCS#8 private keys", () => {
    const key = generateKeyPair();
    expect(key.publicKeyPem).toContain("-----BEGIN PUBLIC KEY-----");
    expect(key.publicKeyPem).toContain("-----END PUBLIC KEY-----");
    expect(key.privateKeyPem).toContain("-----BEGIN PRIVATE KEY-----");
    expect(key.privateKeyPem).toContain("-----END PRIVATE KEY-----");
  });

  it("round-trips: a statement signed by a key verifies with its public key", () => {
    const key = generateKeyPair();
    const envelope = signStatement(buildDeterministicCheckStatement(baseInput), key);
    expect(verifyEnvelope(envelope, key.publicKeyPem)).toBe(true);
  });
});

describe("verifyEnvelope", () => {
  it("returns false for a different public key", () => {
    const signer = generateKeyPair();
    const other = generateKeyPair();
    const envelope = signStatement(buildDeterministicCheckStatement(baseInput), signer);
    expect(verifyEnvelope(envelope, other.publicKeyPem)).toBe(false);
  });

  it("returns false when the payload is tampered", () => {
    const key = generateKeyPair();
    const envelope = signStatement(buildDeterministicCheckStatement(baseInput), key);
    const tampered: DsseEnvelope = {
      ...envelope,
      payload: Buffer.from("tampered-payload", "utf8").toString("base64")
    };
    expect(verifyEnvelope(tampered, key.publicKeyPem)).toBe(false);
  });

  it("includes keyid only when provided and still verifies", () => {
    const key = generateKeyPair();
    const statement = buildDeterministicCheckStatement(baseInput);
    const withoutKeyid = signStatement(statement, key);
    const withKeyid = signStatement(statement, key, "key-1");

    expect(withoutKeyid.signatures[0]?.keyid).toBeUndefined();
    expect(withKeyid.signatures[0]?.keyid).toBe("key-1");
    // keyid is metadata only: it must not change the signed bytes.
    expect(withKeyid.payload).toBe(withoutKeyid.payload);
    expect(verifyEnvelope(withKeyid, key.publicKeyPem)).toBe(true);
  });
});

describe("pae", () => {
  it("produces the exact DSSE PAE byte layout for a known small input", () => {
    // payloadType "ty" (2 bytes) + payload "hi" (2 bytes).
    const result = pae("ty", Buffer.from("hi"));
    expect(result.toString("ascii")).toBe("DSSEv1 2 ty 2 hi");
    const expected = Buffer.concat([Buffer.from("DSSEv1 2 ty 2 ", "ascii"), Buffer.from("hi")]);
    expect(result.equals(expected)).toBe(true);
  });

  it("uses byte lengths and appends raw (non-ASCII) payload bytes verbatim", () => {
    const payload = Buffer.from([0x00, 0xff, 0x41]);
    const payloadType = "application/vnd.in-toto+json";
    const result = pae(payloadType, payload);
    const header = Buffer.from(
      `DSSEv1 ${Buffer.byteLength(payloadType)} ${payloadType} ${payload.length} `,
      "ascii"
    );
    expect(result.equals(Buffer.concat([header, payload]))).toBe(true);
  });
});

describe("factsDigest", () => {
  it("is a stable 64-char sha256 hex for identical facts", () => {
    const digest = factsDigest([fact("f1")]);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(factsDigest([fact("f1")])).toBe(digest);
  });

  it("is insensitive to field declaration order within a fact", () => {
    const ordered: VerifiedFact = {
      id: "f1",
      type: "ci_workflow_changed",
      source: "github_diff",
      evidence: "e",
      confidence: "observed"
    };
    const reordered: VerifiedFact = {
      confidence: "observed",
      evidence: "e",
      source: "github_diff",
      type: "ci_workflow_changed",
      id: "f1"
    };
    expect(factsDigest([reordered])).toBe(factsDigest([ordered]));
  });

  it("changes when fact content changes", () => {
    expect(factsDigest([fact("f1")])).not.toBe(factsDigest([fact("f2")]));
  });
});

describe("buildDeterministicCheckStatement", () => {
  it("pins the subject digest to the Cid hex and populates predicate fields", () => {
    const statement = buildDeterministicCheckStatement(baseInput);

    expect(statement._type).toBe(INTOTO_STATEMENT_TYPE);
    expect(statement.predicateType).toBe(DETERMINISTIC_CHECK_PREDICATE_TYPE);

    const subject = statement.subject[0];
    expect(subject).toBeDefined();
    expect(subject?.name).toBe(baseInput.transformCid);
    // Subject-pin: hex after the last ":" in "loom:sha256:abc123".
    expect(subject?.digest.sha256).toBe("abc123");

    expect(statement.predicate.checker.did).toBe(baseInput.checkerDid);
    expect(statement.predicate.checker.detectorSuiteVersion).toBe(baseInput.detectorSuiteVersion);
    expect(statement.predicate.inputs.baseState).toBe(baseInput.baseState);
    expect(statement.predicate.inputs.resultState).toBe(baseInput.resultState);
    expect(statement.predicate.inputs.policyVersion).toBe(baseInput.policyVersion);
    expect(statement.predicate.facts).toEqual(baseInput.facts);
    expect(statement.predicate.factsDigest).toBe(factsDigest(baseInput.facts));
    expect(statement.predicate.decision).toBe("pass");
  });
});

describe("verifyProvenance", () => {
  it("returns ok for a matching cid, envelope, and key", () => {
    const key = generateKeyPair();
    const envelope = signStatement(buildDeterministicCheckStatement(baseInput), key);
    expect(
      verifyProvenance({
        transformCid: baseInput.transformCid,
        envelope,
        publicKeyPem: key.publicKeyPem
      })
    ).toEqual({ ok: true });
  });

  it("fails with 'signature invalid' for the wrong public key", () => {
    const key = generateKeyPair();
    const other = generateKeyPair();
    const envelope = signStatement(buildDeterministicCheckStatement(baseInput), key);
    expect(
      verifyProvenance({
        transformCid: baseInput.transformCid,
        envelope,
        publicKeyPem: other.publicKeyPem
      })
    ).toEqual({ ok: false, reason: "signature invalid" });
  });

  it("fails with 'unexpected predicate' when the predicateType is not the deterministic-check type", () => {
    const key = generateKeyPair();
    const statement = buildDeterministicCheckStatement(baseInput);
    const wrongPredicate: InTotoStatement<DeterministicCheckPredicate> = {
      ...statement,
      predicateType: "https://example.com/other-predicate/v1"
    };
    const envelope = signStatement(wrongPredicate, key);
    expect(
      verifyProvenance({
        transformCid: baseInput.transformCid,
        envelope,
        publicKeyPem: key.publicKeyPem
      })
    ).toEqual({ ok: false, reason: "unexpected predicate" });
  });

  it("fails with subject mismatch when verifying against a different Cid", () => {
    const key = generateKeyPair();
    const envelope = signStatement(buildDeterministicCheckStatement(baseInput), key);
    expect(
      verifyProvenance({
        transformCid: cid("loom:sha256:deadbeef"),
        envelope,
        publicKeyPem: key.publicKeyPem
      })
    ).toEqual({ ok: false, reason: "subject digest does not match transform" });
  });
});
