/**
 * @agentforge/loom-core — encryption-at-rest / private-object addressing
 * (Phase 0, spec §23 item 7).
 *
 * A private object is stored as a versioned envelope whose ciphertext is
 * produced by AES-256-GCM with a fresh random IV per envelope. Randomized
 * nonces prevent equality/frequency leakage between identical plaintexts.
 * The object's CID still commits to the plaintext; the envelope is a
 * storage-layer transformation only. GCM authentication ensures any tampering
 * or a wrong key fails decryption.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const PRIVATE_ENVELOPE_VERSION = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface PrivateEnvelope {
  readonly version: 1;
  readonly iv: Uint8Array;
  /** AES-256-GCM ciphertext followed by the 16-byte auth tag. */
  readonly ciphertext: Uint8Array;
}

/** Encrypt `plaintext` under a 32-byte key with a fresh nonce. */
export function encryptPrivate(plaintext: Uint8Array, key: Uint8Array): PrivateEnvelope {
  if (key.length !== KEY_BYTES) {
    throw new Error(`loom: private-object key must be ${KEY_BYTES} bytes`);
  }
  // Never derive the IV from plaintext: doing so leaks equality and frequency
  // information to anyone who can observe stored envelopes. GCM requires a
  // unique nonce for each encryption under a key; randomBytes provides that
  // nonce while keeping the envelope self-contained.
  const iv = Uint8Array.from(randomBytes(IV_BYTES));
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: PRIVATE_ENVELOPE_VERSION,
    iv,
    ciphertext: Uint8Array.from([...encrypted, ...tag])
  };
}

/** Decrypt a private envelope; throws on wrong key, tampering, or bad format. */
export function decryptPrivate(envelope: PrivateEnvelope, key: Uint8Array): Uint8Array {
  if (envelope.version !== PRIVATE_ENVELOPE_VERSION) {
    throw new Error(`loom: unsupported private envelope version ${envelope.version}`);
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(`loom: private-object key must be ${KEY_BYTES} bytes`);
  }
  if (envelope.iv.length !== IV_BYTES || envelope.ciphertext.length < TAG_BYTES) {
    throw new Error("loom: malformed private envelope");
  }
  const data = envelope.ciphertext.slice(0, -TAG_BYTES);
  const tag = envelope.ciphertext.slice(-TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, envelope.iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return Uint8Array.from(plaintext);
}
