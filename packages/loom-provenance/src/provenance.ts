/**
 * @agentforge/loom-provenance — DSSE-signed, transition-pinned attestations.
 *
 * Pure functions built on established standards:
 *  - in-toto Statement v1 as the attestation body,
 *  - DSSE envelope + Pre-Authentication Encoding (PAE) as the signing frame,
 *  - Ed25519 via node:crypto as the only signature scheme.
 *
 * No external dependencies. The deterministic-check decision is bound to a
 * canonical subject derived from both base and result State addresses. A
 * verifier must independently supply both expected State addresses, preventing
 * an attestation for one base from being replayed against another base that has
 * the same result State.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

import type { VerifiedFact } from "@agentforge/core";
import { address, canonicalize, sha256Hex, type Cid } from "@agentforge/loom-core";

import {
  DETERMINISTIC_CHECK_PREDICATE_TYPE,
  INTOTO_STATEMENT_TYPE,
  type DeterministicCheckInput,
  type DeterministicCheckPredicate,
  type DsseEnvelope,
  type DsseSignature,
  type InTotoStatement,
  type KeyPair,
  type StateTransitionInput,
  type VerifyProvenanceInput,
  type VerifyResult
} from "./types.js";

/** DSSE payloadType for an in-toto Statement body. */
const INTOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";

/** Domain separator for canonical base-to-result transition subjects. */
const STATE_TRANSITION_SUBJECT_TYPE = "https://loom.agentforge.dev/state-transition/v1";

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
 * Content-address the ordered base-to-result transition with an explicit domain
 * separator. Equal result States reached from different bases have different
 * subjects even though their result State Cids are identical.
 */
export function transitionSubjectCid(input: StateTransitionInput): Cid {
  return address({
    _type: STATE_TRANSITION_SUBJECT_TYPE,
    baseState: input.baseState,
    resultState: input.resultState
  });
}

/**
 * Assemble an in-toto Statement whose single subject is derived from both State
 * addresses and whose predicate carries the same pinned inputs, deterministic
 * decision, checker identity, and facts.
 */
export function buildDeterministicCheckStatement(
  input: DeterministicCheckInput
): InTotoStatement<DeterministicCheckPredicate> {
  const subjectCid = transitionSubjectCid(input);
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
        name: subjectCid,
        digest: { sha256: cidSha256(subjectCid) }
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
  const privateKey = createPrivateKey(key.privateKeyPem);
  const publicKey = createPublicKey(key.publicKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("provenance signing requires Ed25519 key material");
  }
  // A KeyPair is a pair, not two independently accepted keys. Without this
  // check a caller can accidentally sign with one private key while publishing
  // a different public key, producing an attestation that can never verify and
  // making a key-rotation/configuration error look like a bad statement.
  const privateJwk = privateKey.export({ format: "jwk" });
  if (
    privateJwk.kty !== "OKP" ||
    privateJwk.crv !== "Ed25519" ||
    typeof privateJwk.x !== "string"
  ) {
    throw new Error("provenance signing requires Ed25519 key material");
  }
  const derivedPublic = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: privateJwk.x },
    format: "jwk"
  }).export({ type: "spki", format: "der" });
  const configuredPublic = publicKey.export({ type: "spki", format: "der" });
  if (!Buffer.from(derivedPublic).equals(Buffer.from(configuredPublic))) {
    throw new Error("provenance signing requires matching Ed25519 key material");
  }
  const signature = sign(null, pae(INTOTO_PAYLOAD_TYPE, payloadBytes), privateKey);
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
 * Malformed untrusted key or envelope data fails closed.
 */
export function verifyEnvelope(envelope: DsseEnvelope, publicKeyPem: string): boolean {
  try {
    if (
      !isRecord(envelope) ||
      typeof envelope.payloadType !== "string" ||
      typeof envelope.payload !== "string" ||
      !isStrictBase64(envelope.payload) ||
      !Array.isArray(envelope.signatures)
    ) {
      return false;
    }
    const payloadBytes = Buffer.from(envelope.payload, "base64");
    const publicKey = createPublicKey(publicKeyPem);
    if (publicKey.asymmetricKeyType !== "ed25519") {
      return false;
    }
    const preAuth = pae(envelope.payloadType, payloadBytes);
    // DSSE permits multiple signatures. A malformed/unrecognized extra entry
    // must not hide a valid signature, but malformed payload encoding itself
    // is rejected above instead of being silently normalized by Buffer.from.
    return envelope.signatures.some((signature) => {
      if (
        !isRecord(signature) ||
        typeof signature.sig !== "string" ||
        !isStrictBase64(signature.sig)
      ) {
        return false;
      }
      try {
        return verify(null, preAuth, publicKey, Buffer.from(signature.sig, "base64"));
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/** Accept only canonical RFC 4648 base64 as emitted by Buffer.toString(). */
function isStrictBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) {
    return false;
  }
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface SubjectPin {
  readonly name: string;
  readonly sha256: string;
}

/** Safely read the one permitted subject from a decoded, untrusted statement. */
function readSubjectPin(statement: Record<string, unknown>): SubjectPin | undefined {
  const subject: unknown = statement["subject"];
  if (!Array.isArray(subject) || subject.length !== 1) {
    return undefined;
  }
  const first: unknown = subject[0];
  if (!isRecord(first) || typeof first["name"] !== "string") {
    return undefined;
  }
  const digest: unknown = first["digest"];
  if (!isRecord(digest) || typeof digest["sha256"] !== "string") {
    return undefined;
  }
  return { name: first["name"], sha256: digest["sha256"] };
}

function isDecision(value: unknown): value is DeterministicCheckPredicate["decision"] {
  return value === "pass" || value === "warn" || value === "block";
}

/**
 * Verify a provenance envelope against independently derived base and result
 * State addresses and a public key:
 *  1. payload type and signature must be valid,
 *  2. statement and predicate types must be exact,
 *  3. the sole subject must equal the canonical expected transition subject,
 *  4. predicate base/result inputs must equal that expected transition, and
 *  5. factsDigest must describe the signed facts.
 */
export function verifyProvenance(input: VerifyProvenanceInput): VerifyResult {
  if (!isRecord(input) || !isRecord(input.envelope)) {
    return { ok: false, reason: "malformed envelope" };
  }
  const envelope = input.envelope as unknown as DsseEnvelope;
  if (envelope.payloadType !== INTOTO_PAYLOAD_TYPE) {
    return { ok: false, reason: "unexpected payload type" };
  }
  if (!verifyEnvelope(envelope, input.publicKeyPem)) {
    return { ok: false, reason: "signature invalid" };
  }

  let statement: unknown;
  try {
    statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed statement" };
  }

  if (!isRecord(statement)) {
    return { ok: false, reason: "malformed statement" };
  }
  if (statement["_type"] !== INTOTO_STATEMENT_TYPE) {
    return { ok: false, reason: "unexpected statement type" };
  }
  if (statement["predicateType"] !== DETERMINISTIC_CHECK_PREDICATE_TYPE) {
    return { ok: false, reason: "unexpected predicate" };
  }

  const expectedSubject = transitionSubjectCid(input);
  const subject = readSubjectPin(statement);
  if (
    subject === undefined ||
    subject.name !== expectedSubject ||
    subject.sha256 !== cidSha256(expectedSubject)
  ) {
    return { ok: false, reason: "subject does not match expected transition" };
  }

  const predicate: unknown = statement["predicate"];
  if (!isRecord(predicate)) {
    return { ok: false, reason: "malformed deterministic-check predicate" };
  }
  const checker: unknown = predicate["checker"];
  const inputs: unknown = predicate["inputs"];
  const facts: unknown = predicate["facts"];
  const signedFactsDigest: unknown = predicate["factsDigest"];
  if (
    !isRecord(checker) ||
    typeof checker["did"] !== "string" ||
    typeof checker["detectorSuiteVersion"] !== "string" ||
    !isRecord(inputs) ||
    typeof inputs["baseState"] !== "string" ||
    typeof inputs["resultState"] !== "string" ||
    typeof inputs["policyVersion"] !== "string" ||
    !Array.isArray(facts) ||
    typeof signedFactsDigest !== "string" ||
    !isDecision(predicate["decision"])
  ) {
    return { ok: false, reason: "malformed deterministic-check predicate" };
  }

  if (
    inputs["baseState"] !== input.baseState ||
    inputs["resultState"] !== input.resultState ||
    inputs["policyVersion"] !== input.policyVersion
  ) {
    return { ok: false, reason: "predicate inputs do not match expected transition" };
  }

  try {
    if (sha256Hex(canonicalize(facts)) !== signedFactsDigest) {
      return { ok: false, reason: "facts digest does not match facts" };
    }
  } catch {
    return { ok: false, reason: "malformed deterministic-check predicate" };
  }

  return { ok: true };
}
