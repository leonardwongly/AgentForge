/**
 * @agentforge/loom-provenance — type surface.
 *
 * Signed provenance for Loom changes, assembled from established standards
 * (in-toto Statement v1 + DSSE envelope + Ed25519 via node:crypto) rather than
 * reinvented crypto. It binds a deterministic-check decision to a specific
 * base-to-result State transition via the in-toto subject digest.
 *
 * Honest scope: this produces and verifies signed, subject-pinned attestations.
 * It does NOT integrate a transparency log / Rekor / witnesses (networked,
 * kill-gated). "Attested, not proven."
 */
import type { VerifiedFact } from "@agentforge/core";
import type { Cid } from "@agentforge/loom-core";

export const INTOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const DETERMINISTIC_CHECK_PREDICATE_TYPE =
  "https://loom.agentforge.dev/deterministic-check/v1";

/** PEM-encoded Ed25519 key pair. */
export interface KeyPair {
  readonly publicKeyPem: string;
  readonly privateKeyPem: string;
}

export interface DsseSignature {
  readonly keyid?: string | undefined;
  /** base64 signature over the DSSE PAE of (payloadType, payload bytes). */
  readonly sig: string;
}

export interface DsseEnvelope {
  readonly payloadType: string;
  /** base64 of the canonical JSON statement bytes. */
  readonly payload: string;
  readonly signatures: ReadonlyArray<DsseSignature>;
}

export interface Subject {
  readonly name: string;
  readonly digest: { readonly sha256: string };
}

export interface InTotoStatement<P> {
  readonly _type: string;
  readonly subject: ReadonlyArray<Subject>;
  readonly predicateType: string;
  readonly predicate: P;
}

/** The independently addressable inputs of one base-to-result transition. */
export interface StateTransitionInput {
  readonly baseState: Cid;
  readonly resultState: Cid;
}

export interface DeterministicCheckPredicate {
  readonly checker: { readonly did: string; readonly detectorSuiteVersion: string };
  readonly inputs: StateTransitionInput & {
    readonly policyVersion: string;
  };
  readonly facts: ReadonlyArray<VerifiedFact>;
  /** sha256 hex of the canonical facts array (re-derivable). */
  readonly factsDigest: string;
  readonly decision: "pass" | "warn" | "block";
}

export interface DeterministicCheckInput extends StateTransitionInput {
  readonly checkerDid: string;
  readonly detectorSuiteVersion: string;
  readonly policyVersion: string;
  readonly facts: ReadonlyArray<VerifiedFact>;
  readonly decision: "pass" | "warn" | "block";
}

/** Expected transition and trust material used to verify an untrusted envelope. */
export interface VerifyProvenanceInput extends StateTransitionInput {
  /** Policy version expected by the verifier; it is part of the signed predicate. */
  readonly policyVersion: string;
  readonly envelope: DsseEnvelope;
  readonly publicKeyPem: string;
}

export type VerifyResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };
