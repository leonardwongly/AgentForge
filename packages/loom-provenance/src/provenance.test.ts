import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign
} from "node:crypto";

import type { VerifiedFact } from "@agentforge/core";
import type { Cid } from "@agentforge/loom-core";
import { describe, expect, it } from "vitest";

import {
  buildDeterministicCheckStatement,
  factsDigest,
  generateKeyPair,
  pae,
  signStatement,
  transitionSubjectCid,
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
const cidDigest = (value: Cid): string => value.slice(value.lastIndexOf(":") + 1);

const fact = (id: string): VerifiedFact => ({
  id,
  type: "sensitive_path_changed",
  source: "github_diff",
  evidence: `evidence-${id}`,
  confidence: "verified"
});

const baseInput: DeterministicCheckInput = {
  checkerDid: "did:key:checker",
  detectorSuiteVersion: "detector-suite@1",
  baseState: cid("loom:sha256:basestate"),
  resultState: cid("loom:sha256:resultstate"),
  policyVersion: "policy@1",
  facts: [fact("f1"), fact("f2")],
  decision: "pass"
};

const expectedTransition = {
  baseState: baseInput.baseState,
  resultState: baseInput.resultState
};

describe("generateKeyPair", () => {
  it("returns PEM-encoded SPKI public and PKCS#8 private keys", () => {
    const key = generateKeyPair();
    // Validate by re-importing with node:crypto instead of embedding a PEM
    // header literal (which the repo's secret scanner rejects in tracked files).
    expect(key.publicKeyPem).toContain("BEGIN PUBLIC KEY");
    expect(() => createPublicKey(key.publicKeyPem)).not.toThrow();
    expect(() => createPrivateKey(key.privateKeyPem)).not.toThrow();
    expect(createPublicKey(key.publicKeyPem).asymmetricKeyType).toBe("ed25519");
    expect(createPrivateKey(key.privateKeyPem).asymmetricKeyType).toBe("ed25519");
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

  it("preserves canonical statement bytes regardless of property declaration order", () => {
    const key = generateKeyPair();
    const statement = buildDeterministicCheckStatement(baseInput);
    const reordered: InTotoStatement<DeterministicCheckPredicate> = {
      predicate: {
        decision: statement.predicate.decision,
        factsDigest: statement.predicate.factsDigest,
        facts: statement.predicate.facts,
        inputs: statement.predicate.inputs,
        checker: statement.predicate.checker
      },
      predicateType: statement.predicateType,
      subject: statement.subject,
      _type: statement._type
    };

    expect(signStatement(reordered, key).payload).toBe(signStatement(statement, key).payload);
  });

  it("rejects Ed448 key material when signing", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed448");
    const ed448Key = {
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    };

    expect(() => signStatement(buildDeterministicCheckStatement(baseInput), ed448Key)).toThrow(
      /Ed25519/
    );
  });

  it("rejects an otherwise-valid Ed448 envelope", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed448");
    const payloadType = "application/vnd.example+json";
    const payloadBytes = Buffer.from('{"signed":"with-ed448"}', "utf8");
    const envelope: DsseEnvelope = {
      payloadType,
      payload: payloadBytes.toString("base64"),
      signatures: [
        { sig: nodeSign(null, pae(payloadType, payloadBytes), privateKey).toString("base64") }
      ]
    };
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

    expect(verifyEnvelope(envelope, publicKeyPem)).toBe(false);
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

describe("transitionSubjectCid", () => {
  it("is deterministic and binds both base and result State addresses", () => {
    const subject = transitionSubjectCid(expectedTransition);
    expect(subject).toMatch(/^loom:sha256:[0-9a-f]{64}$/);
    expect(transitionSubjectCid(expectedTransition)).toBe(subject);
    expect(
      transitionSubjectCid({
        baseState: cid("loom:sha256:anotherbase"),
        resultState: baseInput.resultState
      })
    ).not.toBe(subject);
    expect(
      transitionSubjectCid({
        baseState: baseInput.baseState,
        resultState: cid("loom:sha256:anotherresult")
      })
    ).not.toBe(subject);
  });
});

describe("buildDeterministicCheckStatement", () => {
  it("pins the subject to the base-to-result transition and populates predicate fields", () => {
    const statement = buildDeterministicCheckStatement(baseInput);
    const transitionCid = transitionSubjectCid(expectedTransition);

    expect(statement._type).toBe(INTOTO_STATEMENT_TYPE);
    expect(statement.predicateType).toBe(DETERMINISTIC_CHECK_PREDICATE_TYPE);

    const subject = statement.subject[0];
    expect(subject).toBeDefined();
    expect(subject?.name).toBe(transitionCid);
    expect(subject?.digest.sha256).toBe(cidDigest(transitionCid));

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
  it("returns ok for a matching transition, envelope, and key", () => {
    const key = generateKeyPair();
    const envelope = signStatement(buildDeterministicCheckStatement(baseInput), key);
    expect(
      verifyProvenance({
        ...expectedTransition,
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
        ...expectedTransition,
        envelope,
        publicKeyPem: other.publicKeyPem
      })
    ).toEqual({ ok: false, reason: "signature invalid" });
  });

  it("fails with 'unexpected predicate' when the predicateType is not deterministic-check", () => {
    const key = generateKeyPair();
    const statement = buildDeterministicCheckStatement(baseInput);
    const wrongPredicate: InTotoStatement<DeterministicCheckPredicate> = {
      ...statement,
      predicateType: "https://example.com/other-predicate/v1"
    };
    const envelope = signStatement(wrongPredicate, key);
    expect(
      verifyProvenance({
        ...expectedTransition,
        envelope,
        publicKeyPem: key.publicKeyPem
      })
    ).toEqual({ ok: false, reason: "unexpected predicate" });
  });

  it("rejects a valid envelope against another expected base with the same result", () => {
    const key = generateKeyPair();
    const envelope = signStatement(buildDeterministicCheckStatement(baseInput), key);
    expect(
      verifyProvenance({
        baseState: cid("loom:sha256:anotherbase"),
        resultState: baseInput.resultState,
        envelope,
        publicKeyPem: key.publicKeyPem
      })
    ).toEqual({ ok: false, reason: "subject does not match expected transition" });
  });

  it("rejects a signed predicate base that contradicts its transition subject", () => {
    const key = generateKeyPair();
    const statement = buildDeterministicCheckStatement(baseInput);
    const contradictory: InTotoStatement<DeterministicCheckPredicate> = {
      ...statement,
      predicate: {
        ...statement.predicate,
        inputs: {
          ...statement.predicate.inputs,
          baseState: cid("loom:sha256:contradictorybase")
        }
      }
    };
    const envelope = signStatement(contradictory, key);

    expect(
      verifyProvenance({
        ...expectedTransition,
        envelope,
        publicKeyPem: key.publicKeyPem
      })
    ).toEqual({ ok: false, reason: "predicate inputs do not match expected transition" });
  });

  it("rejects a signed predicate result that contradicts its transition subject", () => {
    const key = generateKeyPair();
    const statement = buildDeterministicCheckStatement(baseInput);
    const contradictory: InTotoStatement<DeterministicCheckPredicate> = {
      ...statement,
      predicate: {
        ...statement.predicate,
        inputs: {
          ...statement.predicate.inputs,
          resultState: cid("loom:sha256:contradictoryresult")
        }
      }
    };
    const envelope = signStatement(contradictory, key);

    expect(
      verifyProvenance({
        ...expectedTransition,
        envelope,
        publicKeyPem: key.publicKeyPem
      })
    ).toEqual({ ok: false, reason: "predicate inputs do not match expected transition" });
  });

  it("rejects a signed subject that contradicts the predicate and expected transition", () => {
    const key = generateKeyPair();
    const statement = buildDeterministicCheckStatement(baseInput);
    const otherSubject = transitionSubjectCid({
      baseState: cid("loom:sha256:otherbase"),
      resultState: baseInput.resultState
    });
    const contradictory: InTotoStatement<DeterministicCheckPredicate> = {
      ...statement,
      subject: [{ name: otherSubject, digest: { sha256: cidDigest(otherSubject) } }]
    };
    const envelope = signStatement(contradictory, key);

    expect(
      verifyProvenance({
        ...expectedTransition,
        envelope,
        publicKeyPem: key.publicKeyPem
      })
    ).toEqual({ ok: false, reason: "subject does not match expected transition" });
  });

  it("rejects signed facts when factsDigest does not describe them", () => {
    const key = generateKeyPair();
    const statement = buildDeterministicCheckStatement(baseInput);
    const contradictory: InTotoStatement<DeterministicCheckPredicate> = {
      ...statement,
      predicate: { ...statement.predicate, facts: [fact("different")] }
    };
    const envelope = signStatement(contradictory, key);

    expect(
      verifyProvenance({
        ...expectedTransition,
        envelope,
        publicKeyPem: key.publicKeyPem
      })
    ).toEqual({ ok: false, reason: "facts digest does not match facts" });
  });
});
