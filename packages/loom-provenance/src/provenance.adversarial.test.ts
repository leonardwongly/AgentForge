import { describe, expect, it } from "vitest";

import {
  buildDeterministicCheckStatement,
  generateKeyPair,
  signStatement,
  verifyEnvelope
} from "./provenance.js";
import type { DeterministicCheckInput, DsseEnvelope } from "./types.js";

const input: DeterministicCheckInput = {
  checkerDid: "did:loom:test-checker",
  detectorSuiteVersion: "suite@1",
  baseState: "loom:sha256:base" as never,
  resultState: "loom:sha256:result" as never,
  policyVersion: "policy@1",
  facts: [],
  decision: "pass"
};

describe("provenance adversarial envelope handling", () => {
  it("rejects payload encodings with ignored characters instead of verifying normalized bytes", () => {
    const key = generateKeyPair();
    const envelope = signStatement(buildDeterministicCheckStatement(input), key);

    // Buffer.from(value, "base64") silently ignores punctuation. A verifier
    // must not accept an envelope whose serialized payload is malformed even
    // when its decoded bytes happen to remain unchanged.
    const malformed: DsseEnvelope = { ...envelope, payload: `${envelope.payload}!` };
    expect(verifyEnvelope(malformed, key.publicKeyPem)).toBe(false);
  });

  it("ignores malformed extra signatures but still accepts a valid signature", () => {
    const key = generateKeyPair();
    const envelope = signStatement(buildDeterministicCheckStatement(input), key);
    const withMalformedExtra: DsseEnvelope = {
      ...envelope,
      signatures: [{ sig: "not base64 !" }, ...envelope.signatures]
    };

    expect(verifyEnvelope(withMalformedExtra, key.publicKeyPem)).toBe(true);
  });

  it("rejects a mismatched public/private key pair before producing an unverifiable envelope", () => {
    const publicKey = generateKeyPair();
    const privateKey = generateKeyPair();

    expect(() =>
      signStatement(buildDeterministicCheckStatement(input), {
        publicKeyPem: publicKey.publicKeyPem,
        privateKeyPem: privateKey.privateKeyPem
      })
    ).toThrow(/matching Ed25519 key material/);
  });
});
