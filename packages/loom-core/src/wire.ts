/**
 * @agentforge/loom-core — Loom Wire v1 protocol (Phase 0, spec §23 item 6).
 *
 * The HTTP/2 wire binding for Loom nodes and clients. This module defines the
 * versioned message envelope, the method vocabulary, request signing
 * (HMAC-SHA256 over a canonical request with a nonce + timestamp for replay
 * protection), and version/capability negotiation. It is pure and hermetic
 * (no network); the transport layer lives in wire-transport.ts.
 *
 * Messages are JSON envelopes with an explicit `v: 1` schema version.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const WIRE_VERSION = 1;
export const WIRE_CONTENT_TYPE = "application/vnd.loom.wire+json";
export const AUTH_SCHEME = "Loom";
/** Reject requests whose timestamp is older than this (replay window). */
export const REPLAY_WINDOW_MS = 30_000;

export type WireMethod =
  | "hello"
  | "object.put"
  | "object.get"
  | "line.read"
  | "line.advance";

export const WIRE_METHODS: readonly WireMethod[] = [
  "hello",
  "object.put",
  "object.get",
  "line.read",
  "line.advance"
];

export interface WireRequest {
  readonly v: 1;
  readonly id: string;
  readonly method: WireMethod;
  readonly params: Record<string, unknown>;
  readonly nonce: string;
  readonly timestamp: number;
}

export interface WireResponse {
  readonly v: 1;
  readonly id: string;
  readonly ok: true;
  readonly result: unknown;
}

export interface WireError {
  readonly v: 1;
  readonly id: string;
  readonly ok: false;
  readonly error: { readonly code: string; readonly message: string };
}

export type WireMessage = WireRequest | WireResponse | WireError;

export interface Negotiation {
  readonly version: number;
  readonly server: string;
  readonly methods: readonly WireMethod[];
}

/** Canonical bytes used for request signing (domain-separated, versioned). */
export function canonicalRequest(request: WireRequest): Uint8Array {
  const canonical = JSON.stringify({
    v: request.v,
    id: request.id,
    method: request.method,
    params: request.params,
    nonce: request.nonce,
    timestamp: request.timestamp
  });
  return new TextEncoder().encode(`loom-wire-v1|${canonical}`);
}

/** Sign a request with a shared secret; returns the base64 HMAC-SHA256. */
export function signRequest(request: WireRequest, secret: string): string {
  return createHmac("sha256", secret).update(canonicalRequest(request)).digest("base64");
}

/**
 * Verify a request signature and replay window. Returns an error string or
 * undefined when the request is authentic and fresh.
 */
export function verifyRequest(
  request: WireRequest,
  signature: string | undefined,
  secret: string,
  nowMs: number = Date.now()
): string | undefined {
  if (signature === undefined) {
    return "missing signature";
  }
  const expected = signRequest(request, secret);
  if (!timingSafeEqualBase64(signature, expected)) {
    return "invalid signature";
  }
  if (typeof request.timestamp !== "number" || !Number.isFinite(request.timestamp)) {
    return "invalid timestamp";
  }
  if (Math.abs(nowMs - request.timestamp) > REPLAY_WINDOW_MS) {
    return "stale timestamp (replay)";
  }
  return undefined;
}

function timingSafeEqualBase64(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "base64");
  const bufB = Buffer.from(b, "base64");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Build a signed request envelope. */
export function buildRequest(
  method: WireMethod,
  params: Record<string, unknown>,
  secret: string,
  nowMs: number = Date.now()
): { request: WireRequest; signature: string } {
  const request: WireRequest = {
    v: WIRE_VERSION,
    id: randomUUID(),
    method,
    params,
    nonce: randomUUID(),
    timestamp: nowMs
  };
  return { request, signature: signRequest(request, secret) };
}

/** Build the negotiation (hello) response. */
export function negotiate(server: string = "loom"): Negotiation {
  return { version: WIRE_VERSION, server, methods: [...WIRE_METHODS] };
}

/** Validate a decoded message envelope; returns an error string or undefined. */
export function validateWireMessage(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) {
    return "message must be an object";
  }
  const msg = message as Record<string, unknown>;
  if (msg.v !== WIRE_VERSION) {
    return `unsupported wire version ${JSON.stringify(msg.v)}`;
  }
  if (typeof msg.id !== "string" || msg.id === "") {
    return "message id must be a non-empty string";
  }
  if ("ok" in msg) {
    // response or error
    if (msg.ok === true) {
      return undefined;
    }
    if (msg.ok === false) {
      const error = msg.error as Record<string, unknown> | undefined;
      if (!error || typeof error.code !== "string" || typeof error.message !== "string") {
        return "error message requires {code, message}";
      }
      return undefined;
    }
    return "message ok must be a boolean";
  }
  // request
  if (typeof msg.method !== "string" || !WIRE_METHODS.includes(msg.method as WireMethod)) {
    return `unknown method ${JSON.stringify(msg.method)}`;
  }
  if (typeof msg.params !== "object" || msg.params === null || Array.isArray(msg.params)) {
    return "request params must be an object";
  }
  if (typeof msg.nonce !== "string" || msg.nonce === "") {
    return "request nonce must be a non-empty string";
  }
  if (typeof msg.timestamp !== "number" || !Number.isFinite(msg.timestamp)) {
    return "request timestamp must be a finite number";
  }
  return undefined;
}
