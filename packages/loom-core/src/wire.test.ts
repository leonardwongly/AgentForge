import { describe, expect, it } from "vitest";

import {
  buildRequest,
  canonicalRequest,
  NonceReplayGuard,
  negotiate,
  signRequest,
  validateWireMessage,
  verifyRequest,
  WIRE_METHODS
} from "./wire.js";

const SECRET = "shared-secret";

describe("wire request signing", () => {
  it("builds a signed request that verifies", () => {
    const { request, signature } = buildRequest("object.get", { cid: "abc" }, SECRET);
    expect(verifyRequest(request, signature, SECRET)).toBeUndefined();
  });

  it("rejects a missing or wrong signature", () => {
    const { request } = buildRequest("hello", {}, SECRET);
    expect(verifyRequest(request, undefined, SECRET)).toMatch(/missing signature/);
    expect(verifyRequest(request, "AAAA", SECRET)).toMatch(/invalid signature/);
  });

  it("rejects a request signed with a different secret", () => {
    const { request } = buildRequest("hello", {}, SECRET);
    const wrongSig = signRequest(request, "other-secret");
    expect(verifyRequest(request, wrongSig, SECRET)).toMatch(/invalid signature/);
  });

  it("rejects a stale (replayed) request outside the replay window", () => {
    const now = Date.now();
    const { request, signature } = buildRequest("hello", {}, SECRET, now);
    expect(verifyRequest(request, signature, SECRET, now)).toBeUndefined();
    // 60s later the request is outside the 30s window.
    expect(verifyRequest(request, signature, SECRET, now + 60_000)).toMatch(/replay/);
  });

  it("consumes a nonce when a replay guard is supplied", () => {
    const now = Date.now();
    const { request, signature } = buildRequest("hello", {}, SECRET, now);
    const guard = new NonceReplayGuard();
    expect(verifyRequest(request, signature, SECRET, now, guard)).toBeUndefined();
    expect(verifyRequest(request, signature, SECRET, now, guard)).toMatch(/replayed nonce/);
  });

  it("is deterministic: same request signs identically", () => {
    const { request } = buildRequest("hello", {}, SECRET);
    expect(signRequest(request, SECRET)).toBe(signRequest(request, SECRET));
    expect(canonicalRequest(request)).toEqual(canonicalRequest(request));
  });
});

describe("negotiation", () => {
  it("advertises the wire version and supported methods", () => {
    const n = negotiate();
    expect(n.version).toBe(1);
    expect(n.methods).toEqual(WIRE_METHODS);
    expect(n.methods).toContain("object.put");
    expect(n.methods).toContain("line.advance");
  });
});

describe("validateWireMessage", () => {
  it("accepts a valid request", () => {
    const { request } = buildRequest("object.put", { bytes: "aGk=" }, SECRET);
    expect(validateWireMessage(request)).toBeUndefined();
  });

  it("accepts valid responses and errors", () => {
    expect(validateWireMessage({ v: 1, id: "1", ok: true, result: {} })).toBeUndefined();
    expect(
      validateWireMessage({ v: 1, id: "1", ok: false, error: { code: "x", message: "y" } })
    ).toBeUndefined();
  });

  it("rejects malformed messages", () => {
    expect(validateWireMessage(null)).toMatch(/must be an object/);
    expect(validateWireMessage({ v: 2, id: "1", ok: true, result: {} })).toMatch(/unsupported/);
    expect(validateWireMessage({ v: 1, id: "", ok: true, result: {} })).toMatch(/non-empty/);
    expect(validateWireMessage({ v: 1, id: "1", method: "bogus", params: {}, nonce: "n", timestamp: 1 })).toMatch(
      /unknown method/
    );
    expect(
      validateWireMessage({ v: 1, id: "1", method: "hello", params: [], nonce: "n", timestamp: 1 })
    ).toMatch(/params must be an object/);
    expect(
      validateWireMessage({ v: 1, id: "1", ok: false, error: { code: "x" } })
    ).toMatch(/requires \{code, message\}/);
  });
});
