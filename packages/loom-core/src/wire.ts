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
export const MAX_WIRE_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_WIRE_OBJECT_BYTES = 1 * 1024 * 1024;
const MAX_REPLAY_NONCES = 100_000;

export type WireMethod = "hello" | "object.put" | "object.get" | "line.read" | "line.advance";

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

/** Bounded replay nonce memory for one authenticated transport instance. */
export class NonceReplayGuard {
  private readonly seen = new Map<string, number>();
  private earliestExpiry = Number.POSITIVE_INFINITY;

  claim(nonce: string, expiresAt: number, nowMs: number): boolean {
    if (
      typeof nonce !== "string" ||
      nonce.length === 0 ||
      nonce.length > 256 ||
      typeof expiresAt !== "number" ||
      Number.isNaN(expiresAt) ||
      typeof nowMs !== "number" ||
      !Number.isFinite(nowMs)
    ) {
      return false;
    }
    if (nowMs >= this.earliestExpiry) {
      for (const [key, expiry] of this.seen) {
        if (expiry <= nowMs) this.seen.delete(key);
      }
      this.earliestExpiry = Number.POSITIVE_INFINITY;
      for (const expiry of this.seen.values()) {
        this.earliestExpiry = Math.min(this.earliestExpiry, expiry);
      }
    }
    if (this.seen.has(nonce)) return false;
    if (this.seen.size >= MAX_REPLAY_NONCES) return false;
    this.seen.set(nonce, expiresAt);
    this.earliestExpiry = Math.min(this.earliestExpiry, expiresAt);
    return true;
  }
}

export type WireMessage = WireRequest | WireResponse | WireError;

export interface Negotiation {
  readonly version: number;
  readonly server: string;
  readonly methods: readonly WireMethod[];
}

/** Canonical bytes used for request signing (domain-separated, versioned). */
export function canonicalRequest(request: WireRequest): Uint8Array {
  const canonical = `{"v":${jsonValue(request.v)},"id":${jsonValue(request.id)},"method":${jsonValue(
    request.method
  )},"params":${canonicalJson(request.params)},"nonce":${jsonValue(request.nonce)},"timestamp":${jsonValue(
    request.timestamp
  )}}`;
  return new TextEncoder().encode(`loom-wire-v1|${canonical}`);
}

function jsonValue(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("loom: wire value is not JSON serializable");
  }
  return encoded;
}

/** Encode JSON values deterministically, sorting object keys recursively. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return jsonValue(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("loom: wire params contain a non-finite number");
    }
    return jsonValue(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${jsonValue(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new Error(`loom: wire value of type ${typeof value} is not JSON serializable`);
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
  nowMs: number = Date.now(),
  replayGuard?: NonceReplayGuard
): string | undefined {
  const validation = validateWireMessage(request);
  if (validation !== undefined) {
    return validation;
  }
  if (signature === undefined) {
    return "missing signature";
  }
  let expected: string;
  try {
    expected = signRequest(request, secret);
  } catch {
    return "invalid request encoding";
  }
  if (!timingSafeEqualBase64(signature, expected)) {
    return "invalid signature";
  }
  if (typeof request.timestamp !== "number" || !Number.isFinite(request.timestamp)) {
    return "invalid timestamp";
  }
  if (Math.abs(nowMs - request.timestamp) > REPLAY_WINDOW_MS) {
    return "stale timestamp (replay)";
  }
  if (
    replayGuard &&
    !replayGuard.claim(request.nonce, request.timestamp + REPLAY_WINDOW_MS, nowMs)
  ) {
    return "replayed nonce";
  }
  return undefined;
}

function timingSafeEqualBase64(a: string, b: string): boolean {
  if (
    typeof a !== "string" ||
    typeof b !== "string" ||
    !/^[A-Za-z0-9+/]{43}=$/u.test(a) ||
    !/^[A-Za-z0-9+/]{43}=$/u.test(b)
  ) {
    return false;
  }
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
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return "message must be an object";
  }
  const msg = message as Record<string, unknown>;
  if (!Object.hasOwn(msg, "v") || msg.v !== WIRE_VERSION) {
    return `unsupported wire version ${JSON.stringify(msg.v)}`;
  }
  if (!Object.hasOwn(msg, "id") || typeof msg.id !== "string" || msg.id === "") {
    return "message id must be a non-empty string";
  }
  if (msg.id.length > 256) {
    return "message id is too long";
  }
  const unknownField = (allowed: ReadonlySet<string>): string | undefined => {
    const unknown = Object.keys(msg).find((key) => !allowed.has(key));
    return unknown === undefined ? undefined : `unknown message field "${unknown}"`;
  };
  if (Object.hasOwn(msg, "ok")) {
    // response or error
    if (msg.ok === true) {
      const unknown = unknownField(new Set(["v", "id", "ok", "result"]));
      if (unknown !== undefined) return unknown;
      if (!Object.hasOwn(msg, "result")) {
        return "response message requires result";
      }
      return undefined;
    }
    if (msg.ok === false) {
      const unknown = unknownField(new Set(["v", "id", "ok", "error"]));
      if (unknown !== undefined) return unknown;
      const error = msg.error as Record<string, unknown> | undefined;
      if (
        !error ||
        Array.isArray(error) ||
        typeof error.code !== "string" ||
        typeof error.message !== "string" ||
        !Object.hasOwn(error, "code") ||
        !Object.hasOwn(error, "message")
      ) {
        return "error message requires {code, message}";
      }
      const errorKeys = Object.keys(error);
      if (errorKeys.some((key) => key !== "code" && key !== "message")) {
        return `unknown error field "${errorKeys.find((key) => key !== "code" && key !== "message")}"`;
      }
      return undefined;
    }
    return "message ok must be a boolean";
  }
  // request
  const unknown = unknownField(new Set(["v", "id", "method", "params", "nonce", "timestamp"]));
  if (unknown !== undefined) return unknown;
  if (typeof msg.method !== "string" || !WIRE_METHODS.includes(msg.method as WireMethod)) {
    return `unknown method ${JSON.stringify(msg.method)}`;
  }
  if (typeof msg.params !== "object" || msg.params === null || Array.isArray(msg.params)) {
    return "request params must be an object";
  }
  if (typeof msg.nonce !== "string" || msg.nonce === "") {
    return "request nonce must be a non-empty string";
  }
  if (msg.nonce.length > 256) {
    return "request nonce is too long";
  }
  if (typeof msg.timestamp !== "number" || !Number.isFinite(msg.timestamp)) {
    return "request timestamp must be a finite number";
  }
  return undefined;
}
