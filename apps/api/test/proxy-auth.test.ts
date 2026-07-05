import { createHmac, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { resolveApiActor } from "../src/auth.js";

const mutableEnvKeys = [
  "NODE_ENV",
  "AGENTFORGE_API_TRUST_PROXY_HEADERS",
  "AGENTFORGE_API_PROXY_SECRET"
] as const;

const originalEnv = new Map<string, string | undefined>(
  mutableEnvKeys.map((key) => [key, process.env[key]])
);

afterEach(() => {
  for (const key of mutableEnvKeys) {
    const originalValue = originalEnv.get(key);
    if (originalValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalValue;
    }
  }
});

function requestFromHeaders(headers: Record<string, string>) {
  return { headers } as any;
}

function signedRequest(
  secret: string,
  fields: { actor: string; role: string; org: string; timestamp?: string; nonce?: string }
) {
  const timestamp = fields.timestamp ?? Math.floor(Date.now() / 1000).toString();
  const nonce = fields.nonce ?? randomUUID();
  const payload = [timestamp, nonce, fields.actor, fields.role, fields.org].join(":");
  const signature = createHmac("sha256", secret).update(payload).digest("hex");

  return requestFromHeaders({
    "x-agentforge-authenticated-actor": fields.actor,
    "x-agentforge-authenticated-role": fields.role,
    "x-agentforge-authenticated-organization": fields.org,
    "x-agentforge-signature-timestamp": timestamp,
    "x-agentforge-signature-nonce": nonce,
    "x-agentforge-signature": signature
  });
}

describe("Proxy Authentication cryptographic security", () => {
  const secret = "super-secret-key-12345";

  it("accepts valid proxy headers with correct signature, timestamp, and nonce", async () => {
    process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS = "true";
    process.env.AGENTFORGE_API_PROXY_SECRET = secret;

    const req = signedRequest(secret, { actor: "alex", role: "platform_admin", org: "org_test" });

    const result = await resolveApiActor(req);
    expect(result).toEqual({ login: "alex", role: "platform_admin", organizationId: "org_test" });
  });

  it("rejects when proxy secret is not configured", async () => {
    process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS = "true";
    delete process.env.AGENTFORGE_API_PROXY_SECRET;

    const req = requestFromHeaders({
      "x-agentforge-authenticated-actor": "alex",
      "x-agentforge-authenticated-role": "platform_admin",
      "x-agentforge-authenticated-organization": "org_test",
      "x-agentforge-signature-timestamp": Math.floor(Date.now() / 1000).toString(),
      "x-agentforge-signature-nonce": randomUUID(),
      "x-agentforge-signature": "somesignature"
    });

    await expect(resolveApiActor(req)).rejects.toThrowError(
      "AGENTFORGE_API_PROXY_SECRET must be configured when AGENTFORGE_API_TRUST_PROXY_HEADERS is enabled."
    );
  });

  it("rejects when signature is missing", async () => {
    process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS = "true";
    process.env.AGENTFORGE_API_PROXY_SECRET = secret;

    const req = requestFromHeaders({
      "x-agentforge-authenticated-actor": "alex",
      "x-agentforge-authenticated-role": "platform_admin",
      "x-agentforge-authenticated-organization": "org_test",
      "x-agentforge-signature-timestamp": Math.floor(Date.now() / 1000).toString(),
      "x-agentforge-signature-nonce": randomUUID()
    });

    const result = await resolveApiActor(req);
    expect(result).toBeUndefined();
  });

  it("rejects when the nonce is missing, even with an otherwise-valid legacy-style signature", async () => {
    // The nonce is mandatory: a nonce-less signed request has no per-request
    // binding, so registerSignatureUse is never consulted and it could be
    // replayed indefinitely within the timestamp window if this were accepted.
    process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS = "true";
    process.env.AGENTFORGE_API_PROXY_SECRET = secret;

    const actor = "alex";
    const role = "platform_admin";
    const org = "org_test";
    const timestamp = Math.floor(Date.now() / 1000).toString();
    // Legacy nonce-less payload shape (no nonce segment).
    const payload = [timestamp, actor, role, org].join(":");
    const signature = createHmac("sha256", secret).update(payload).digest("hex");

    const req = requestFromHeaders({
      "x-agentforge-authenticated-actor": actor,
      "x-agentforge-authenticated-role": role,
      "x-agentforge-authenticated-organization": org,
      "x-agentforge-signature-timestamp": timestamp,
      "x-agentforge-signature": signature
      // No x-agentforge-signature-nonce header.
    });

    const result = await resolveApiActor(req);
    expect(result).toBeUndefined();
  });

  it("rejects when signature is invalid", async () => {
    process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS = "true";
    process.env.AGENTFORGE_API_PROXY_SECRET = secret;

    const req = requestFromHeaders({
      "x-agentforge-authenticated-actor": "alex",
      "x-agentforge-authenticated-role": "platform_admin",
      "x-agentforge-authenticated-organization": "org_test",
      "x-agentforge-signature-timestamp": Math.floor(Date.now() / 1000).toString(),
      "x-agentforge-signature-nonce": randomUUID(),
      "x-agentforge-signature": "incorrectsignaturehex"
    });

    const result = await resolveApiActor(req);
    expect(result).toBeUndefined();
  });

  it("rejects when timestamp has expired (outside 5-minute window)", async () => {
    process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS = "true";
    process.env.AGENTFORGE_API_PROXY_SECRET = secret;

    // 6 minutes ago (360 seconds)
    const timestamp = (Math.floor(Date.now() / 1000) - 360).toString();
    const req = signedRequest(secret, {
      actor: "alex",
      role: "platform_admin",
      org: "org_test",
      timestamp
    });

    const result = await resolveApiActor(req);
    expect(result).toBeUndefined();
  });

  it("rejects when timestamp is in the future (outside 5-minute window)", async () => {
    process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS = "true";
    process.env.AGENTFORGE_API_PROXY_SECRET = secret;

    // 6 minutes in the future (360 seconds)
    const timestamp = (Math.floor(Date.now() / 1000) + 360).toString();
    const req = signedRequest(secret, {
      actor: "alex",
      role: "platform_admin",
      org: "org_test",
      timestamp
    });

    const result = await resolveApiActor(req);
    expect(result).toBeUndefined();
  });

  it("rejects when actor contains invalid characters", async () => {
    process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS = "true";
    process.env.AGENTFORGE_API_PROXY_SECRET = secret;

    const req = signedRequest(secret, {
      actor: "alex;inject",
      role: "platform_admin",
      org: "org_test"
    });

    const result = await resolveApiActor(req);
    expect(result).toBeUndefined();
  });

  it("rejects a replayed nonce: resolving the exact same signed headers twice (as distinct request objects) succeeds once, then fails", async () => {
    // Direct proof of the replay-protection guarantee the nonce exists for: the
    // SAME signed headers cannot be accepted twice, even well within the
    // timestamp window, when presented as two separate requests.
    process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS = "true";
    process.env.AGENTFORGE_API_PROXY_SECRET = secret;

    const req = signedRequest(secret, { actor: "alex", role: "platform_admin", org: "org_test" });

    const first = await resolveApiActor(requestFromHeaders({ ...req.headers }));
    expect(first).toEqual({ login: "alex", role: "platform_admin", organizationId: "org_test" });

    const second = await resolveApiActor(requestFromHeaders({ ...req.headers }));
    expect(second).toBeUndefined();
  });

  it("does not self-replay-reject when the SAME request object is resolved twice (onRequest hook + route handler)", async () => {
    // Regression test for a real bug: app.ts's onRequest hook calls
    // resolveApiActor(request) to bind RLS org context on every request. If a
    // route handler's own requireApiActor -> resolveApiActor call on that exact
    // same request object consumed the nonce a second time, every nonce-signed
    // trusted-proxy request would 401 on the route despite being entirely
    // legitimate and only actually used once by the caller. Resolving the actor
    // multiple times for the SAME request object must be idempotent.
    process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS = "true";
    process.env.AGENTFORGE_API_PROXY_SECRET = secret;

    const req = signedRequest(secret, { actor: "alex", role: "platform_admin", org: "org_test" });

    // Simulates app.ts's onRequest hook resolving the actor first.
    const fromHook = await resolveApiActor(req);
    expect(fromHook).toEqual({ login: "alex", role: "platform_admin", organizationId: "org_test" });

    // Simulates the route handler's requireApiActor resolving the SAME request
    // object again later in the same request's lifecycle.
    const fromRouteHandler = await resolveApiActor(req);
    expect(fromRouteHandler).toEqual({
      login: "alex",
      role: "platform_admin",
      organizationId: "org_test"
    });
  });

  it("resolves the SAME request object exactly once even when awaited concurrently (onRequest hook racing a route handler)", async () => {
    // Stronger regression guard than the sequential case above: two
    // concurrent (not sequential) resolveApiActor(request) calls on the same
    // request object must share one in-flight resolution, not race to both
    // call the nonce-claiming replay guard before either has settled -- which
    // would non-deterministically 401 one of two entirely legitimate,
    // concurrent callers.
    process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS = "true";
    process.env.AGENTFORGE_API_PROXY_SECRET = secret;

    const req = signedRequest(secret, { actor: "alex", role: "platform_admin", org: "org_test" });

    const [fromHook, fromRouteHandler] = await Promise.all([
      resolveApiActor(req),
      resolveApiActor(req)
    ]);
    expect(fromHook).toEqual({ login: "alex", role: "platform_admin", organizationId: "org_test" });
    expect(fromRouteHandler).toEqual({
      login: "alex",
      role: "platform_admin",
      organizationId: "org_test"
    });
  });

  it("rejects a request carrying a raw spoofable x-agentforge-actor header alongside otherwise-valid signed headers", async () => {
    // Proves AGENTFORGE_AUTH_PROXY_STRIPS_HEADERS is enforced at request time: if the
    // ingress proxy failed to strip the raw header (or an attacker reaches the app
    // directly), the request is rejected outright rather than silently resolved from
    // the signed header set alone.
    process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS = "true";
    process.env.AGENTFORGE_API_PROXY_SECRET = secret;

    const req = signedRequest(secret, { actor: "alex", role: "platform_admin", org: "org_test" });
    // Spoofed raw header injected by a client the proxy failed to strip.
    req.headers["x-agentforge-actor"] = "attacker";
    req.headers["x-agentforge-role"] = "platform_admin";
    req.headers["x-agentforge-organization"] = "org_victim";

    const result = await resolveApiActor(req);
    expect(result).toBeUndefined();
  });

  it("rejects a request carrying only a raw spoofable header with no signed headers at all", async () => {
    process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS = "true";
    process.env.AGENTFORGE_API_PROXY_SECRET = secret;

    const req = requestFromHeaders({
      "x-agentforge-actor": "attacker",
      "x-agentforge-role": "platform_admin",
      "x-agentforge-organization": "org_victim"
    });

    const result = await resolveApiActor(req);
    expect(result).toBeUndefined();
  });

  it("still accepts a valid signed request with no raw headers present (regression guard)", async () => {
    process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS = "true";
    process.env.AGENTFORGE_API_PROXY_SECRET = secret;

    const req = signedRequest(secret, { actor: "alex", role: "platform_admin", org: "org_test" });

    const result = await resolveApiActor(req);
    expect(result).toEqual({ login: "alex", role: "platform_admin", organizationId: "org_test" });
  });
});
