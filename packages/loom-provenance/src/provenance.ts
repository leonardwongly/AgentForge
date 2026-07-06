/**
 * @agentforge/loom-provenance — DSSE-signed, subject-pinned attestations.
 *
 * Pure functions built on established standards:
 *  - in-toto Statement v1 as the attestation body,
 *  - DSSE envelope + Pre-Authentication Encoding (PAE) as the signing frame,
 *  - Ed25519 via node:crypto as the only signature scheme.
 *
 * No external dependencies. The deterministic-check decision is bound to a
 * specific Transform through the in-toto subject digest (the "subject-pin"):
 * the subject digest is the sha256 hex embedded in the Transform's Cid, so a
 * verifier can prove an envelope attests to exactly one Transform.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

import type { VerifiedFact } from "@agentforge/core";
import { canonicalize, sha256Hex, type Cid } from "@agentforge/loom-core";

import {
  DETERMINISTIC_CHECK_PREDICATE_TYPE,
  INTOTO_STATEMENT_TYPE,
  type DeterministicCheckInput,
  type DeterministicCheckPredicate,
  type DsseEnvelope,
  type DsseSignature,
  type InTotoStatement,
  type KeyPair,
  type VerifyResult
} from "./types.js";

/** DSSE payloadType for an in-toto Statement body. */
const INTOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";

/**
 * Generate a fresh Ed25519 key pair, exported as PEM strings
 * (SPKI public key, PKCS#8 private key).
 */
export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    // `.toString()` collapses the `string | Buffer` export union to a string
    // without an unchecked cast; PEM export is always textual.
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  };
}

/**
 * DSSE Pre-Authentication Encoding (PAE):
 *   "DSSEv1" SP LEN(payloadType) SP payloadType SP LEN(payload) SP payload
 * where SP is a single 0x20 space and LEN is the ASCII-decimal BYTE length.
 * The header is ASCII; the raw payload bytes are appended verbatim.
 */
export function pae(payloadType: string, payload: Buffer): Buffer {
  const header = Buffer.from(
    `DSSEv1 ${Buffer.byteLength(payloadType)} ${payloadType} ${payload.length} `,
    "ascii"
  );
  return Buffer.concat([header, payload]);
}

/** sha256 hex of the canonical encoding of the facts array (re-derivable). */
export function factsDigest(facts: ReadonlyArray<VerifiedFact>): string {
  return sha256Hex(canonicalize(facts));
}

/** Extract the sha256 hex from a `loom:sha256:<hex>` Cid (the subject-pin). */
function cidSha256(cid: Cid): string {
  const lastColon = cid.lastIndexOf(":");
  return lastColon === -1 ? cid : cid.slice(lastColon + 1);
}

/**
 * Assemble an in-toto Statement whose single subject is pinned to the
 * Transform's content address and whose predicate carries the
 * deterministic-check decision, inputs, checker identity, and facts.
 */
export function buildDeterministicCheckStatement(
  input: DeterministicCheckInput
): InTotoStatement<DeterministicCheckPredicate> {
  const predicate: DeterministicCheckPredicate = {
    checker: {
      did: input.checkerDid,
      detectorSuiteVersion: input.detectorSuiteVersion
    },
    inputs: {
      baseState: input.baseState,
      resultState: input.resultState,
      policyVersion: input.policyVersion
    },
    facts: input.facts,
    factsDigest: factsDigest(input.facts),
    decision: input.decision
  };

  return {
    _type: INTOTO_STATEMENT_TYPE,
    subject: [
      {
        name: input.transformCid,
        digest: { sha256: cidSha256(input.transformCid) }
      }
    ],
    predicateType: DETERMINISTIC_CHECK_PREDICATE_TYPE,
    predicate
  };
}

/**
 * Sign a statement into a DSSE envelope. The signature is Ed25519 over the
 * PAE of (payloadType, canonical statement bytes). `keyid` is included only
 * when provided so the optional field is never explicitly `undefined`.
 */
export function signStatement(
  statement: InTotoStatement<unknown>,
  key: KeyPair,
  keyid?: string
): DsseEnvelope {
  const payloadBytes = Buffer.from(canonicalize(statement), "utf8");
  const signature = sign(
    null,
    pae(INTOTO_PAYLOAD_TYPE, payloadBytes),
    createPrivateKey(key.privateKeyPem)
  );
  const sig = signature.toString("base64");
  const signatureEntry: DsseSignature = keyid === undefined ? { sig } : { keyid, sig };

  return {
    payloadType: INTOTO_PAYLOAD_TYPE,
    payload: payloadBytes.toString("base64"),
    signatures: [signatureEntry]
  };
}

/**
 * True when at least one signature in the envelope is a valid Ed25519
 * signature (from `publicKeyPem`) over the PAE of the envelope payload.
 */
export function verifyEnvelope(envelope: DsseEnvelope, publicKeyPem: string): boolean {
  const payloadBytes = Buffer.from(envelope.payload, "base64");
  const publicKey = createPublicKey(publicKeyPem);
  const preAuth = pae(envelope.payloadType, payloadBytes);
  return envelope.signatures.some((signature) =>
    verify(null, preAuth, publicKey, Buffer.from(signature.sig, "base64"))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Safely read `subject[0].digest.sha256` from a decoded, untrusted statement. */
function readSubjectDigest(statement: Record<string, unknown>): string | undefined {
  const subject: unknown = statement["subject"];
  if (!Array.isArray(subject)) {
    return undefined;
  }
  const first: unknown = subject[0];
  if (!isRecord(first)) {
    return undefined;
  }
  const digest: unknown = first["digest"];
  if (!isRecord(digest)) {
    return undefined;
  }
  const sha256: unknown = digest["sha256"];
  return typeof sha256 === "string" ? sha256 : undefined;
}

/**
 * Verify a provenance envelope against a Transform Cid and public key:
 *  1. the signature must be valid,
 *  2. the predicate must be the deterministic-check predicate,
 *  3. the subject digest must equal the Cid's sha256 hex (the subject-pin).
 */
export function verifyProvenance(input: {
  readonly transformCid: Cid;
  readonly envelope: DsseEnvelope;
  readonly publicKeyPem: string;
}): VerifyResult {
  if (!verifyEnvelope(input.envelope, input.publicKeyPem)) {
    return { ok: false, reason: "signature invalid" };
  }

  const statement: unknown = JSON.parse(
    Buffer.from(input.envelope.payload, "base64").toString("utf8")
  );

  if (!isRecord(statement) || statement["predicateType"] !== DETERMINISTIC_CHECK_PREDICATE_TYPE) {
    return { ok: false, reason: "unexpected predicate" };
  }

  if (readSubjectDigest(statement) !== cidSha256(input.transformCid)) {
    return { ok: false, reason: "subject digest does not match transform" };
  }

  return { ok: true };
}
