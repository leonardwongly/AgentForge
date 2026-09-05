/**
 * @agentforge/loom-core — actor and node identity (spec §6.3, §7.5, §12.1).
 *
 * Normative actor identifiers use DID syntax. `did:loom` derives a
 * method-specific id from a public key over a versioned, domain-separated
 * string, so the same key always yields the same identifier and identifiers
 * never collide with object addresses or node identities.
 *
 * Node identities follow spec §7.5: a 256-bit digest over the domain-separated
 * tuple `(space, authorDid, creationNonce, ordinal)`, multibase-encoded. The
 * nonce is cryptographically random per authoring session; the identity is a
 * function of the creating session and ordinal, never of content, so it
 * survives moves and edits.
 */

import { createHash, randomBytes } from "node:crypto";

import { canonicalize } from "./addressing.js";
import { base32Encode } from "./codec.js";
import type { Did, NodeIdent } from "./types.js";

/** Versioned domain-separation strings (spec §6.3). */
const DID_DOMAIN = "loom-did-v1";
const NODE_DOMAIN = "loom-node-v1";

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function sha256(...parts: Uint8Array[]): Uint8Array {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
  }
  return hash.digest();
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Derive a `did:loom` identifier from a public key (deterministic, domain-separated). */
export function didLoom(publicKeyBytes: Uint8Array): Did {
  const digest = sha256(concat(utf8(DID_DOMAIN), publicKeyBytes));
  return `did:loom:${base32Encode(digest)}` as Did;
}

/** Parse a DID into `{ method, id }`; returns undefined for malformed input. */
export function parseDid(
  did: string
): { readonly method: string; readonly id: string } | undefined {
  if (!did.startsWith("did:")) {
    return undefined;
  }
  const rest = did.slice(4);
  const colon = rest.indexOf(":");
  if (colon === -1) {
    return undefined;
  }
  const method = rest.slice(0, colon);
  const id = rest.slice(colon + 1);
  if (method === "" || id === "") {
    return undefined;
  }
  return { method, id };
}

/** True if the DID is a well-formed `did:loom` identifier. */
export function isLoomDid(did: string): boolean {
  const parsed = parseDid(did);
  return parsed?.method === "loom" && parsed.id !== "";
}

/** Generate a cryptographically random 256-bit creation nonce (hex). */
export function randomCreationNonce(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Derive a stable NodeIdent per spec §7.5:
 * `multibase(sha2-256("loom-node-v1" || canonical(space, authorDid, nonce, ordinal)))`.
 * The `b` prefix is multibase for lowercase base32.
 */
export function nodeIdent(input: {
  readonly space: string;
  readonly authorDid: Did;
  readonly creationNonce: string;
  readonly ordinal: number;
}): NodeIdent {
  const canonical = canonicalize(input);
  const digest = sha256(concat(utf8(NODE_DOMAIN), utf8(canonical)));
  return `b${base32Encode(digest)}` as NodeIdent;
}
