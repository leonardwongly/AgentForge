import { createHmac } from "node:crypto";
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

describe("Proxy Authentication cryptographic security", () => {
  const secret = "super-secret-key-12345";

  it("accepts valid proxy headers with correct signature and timestamp", () => {
    process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS = "true";
    process.env.AGENTFORGE_API_PROXY_SECRET = secret;

    const actor = "alex";
    const role = "platform_admin";
    const org = "org_test";
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const payload = [timestamp, actor, role, org].join(":");
    const signature = createHmac("sha256", secret).update(payload).digest("hex");

    const req = requestFromHeaders({
      "x-agentforge-authenticated-actor": actor,
      "x-agentforge-authenticated-role": role,
      "x-agentforge-authenticated-organization": org,
      "x-agentforge-signature-timestamp": timestamp,
      "x-agentforge-signature": signature
    });

    const result = resolveApiActor(req);
    expect(result).toEqual({ login: actor, role, organizationId: org });
  });

  it("rejects when proxy secret is not configured", () => {
    process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS = "true";
    delete process.env.AGENTFORGE_API_PROXY_SECRET;

    const req = requestFromHeaders({
      "x-agentforge-authenticated-actor": "alex",
      "x-agentforge-authenticated-role": "platform_admin",
      "x-agentforge-authenticated-organization": "org_test",
      "x-agentforge-signature-timestamp": Math.floor(Date.now() / 1000).toString(),
      "x-agentforge-signature": "somesignature"
    });

    expect(() => resolveApiActor(req)).toThrowError(
      "AGENTFORGE_API_PROXY_SECRET must be configured when AGENTFORGE_API_TRUST_PROXY_HEADERS is enabled."
    );
  });

  it("rejects when signature is missing", () => {
    process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS = "true";
    process.env.AGENTFORGE_API_PROXY_SECRET = secret;

    const req = requestFromHeaders({
      "x-agentforge-authenticated-actor": "alex",
      "x-agentforge-authenticated-role": "platform_admin",
      "x-agentforge-authenticated-organization": "org_test",
      "x-agentforge-signature-timestamp": Math.floor(Date.now() / 1000).toString()
    });

    const result = resolveApiActor(req);
    expect(result).toBeUndefined();
  });

  it("rejects when signature is invalid", () => {
    process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS = "true";
    process.env.AGENTFORGE_API_PROXY_SECRET = secret;

    const req = requestFromHeaders({
      "x-agentforge-authenticated-actor": "alex",
      "x-agentforge-authenticated-role": "platform_admin",
      "x-agentforge-authenticated-organization": "org_test",
      "x-agentforge-signature-timestamp": Math.floor(Date.now() / 1000).toString(),
      "x-agentforge-signature": "incorrectsignaturehex"
    });

    const result = resolveApiActor(req);
    expect(result).toBeUndefined();
  });

  it("rejects when timestamp has expired (outside 5-minute window)", () => {
    process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS = "true";
    process.env.AGENTFORGE_API_PROXY_SECRET = secret;

    const actor = "alex";
    const role = "platform_admin";
    const org = "org_test";

    // 6 minutes ago (360 seconds)
    const timestamp = (Math.floor(Date.now() / 1000) - 360).toString();
    const payload = [timestamp, actor, role, org].join(":");
    const signature = createHmac("sha256", secret).update(payload).digest("hex");

    const req = requestFromHeaders({
      "x-agentforge-authenticated-actor": actor,
      "x-agentforge-authenticated-role": role,
      "x-agentforge-authenticated-organization": org,
      "x-agentforge-signature-timestamp": timestamp,
      "x-agentforge-signature": signature
    });

    const result = resolveApiActor(req);
    expect(result).toBeUndefined();
  });

  it("rejects when timestamp is in the future (outside 5-minute window)", () => {
    process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS = "true";
    process.env.AGENTFORGE_API_PROXY_SECRET = secret;

    const actor = "alex";
    const role = "platform_admin";
    const org = "org_test";

    // 6 minutes in the future (360 seconds)
    const timestamp = (Math.floor(Date.now() / 1000) + 360).toString();
    const payload = [timestamp, actor, role, org].join(":");
    const signature = createHmac("sha256", secret).update(payload).digest("hex");

    const req = requestFromHeaders({
      "x-agentforge-authenticated-actor": actor,
      "x-agentforge-authenticated-role": role,
      "x-agentforge-authenticated-organization": org,
      "x-agentforge-signature-timestamp": timestamp,
      "x-agentforge-signature": signature
    });

    const result = resolveApiActor(req);
    expect(result).toBeUndefined();
  });

  it("rejects when actor contains invalid characters", () => {
    process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS = "true";
    process.env.AGENTFORGE_API_PROXY_SECRET = secret;

    const actor = "alex;inject";
    const role = "platform_admin";
    const org = "org_test";
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const payload = [timestamp, actor, role, org].join(":");
    const signature = createHmac("sha256", secret).update(payload).digest("hex");

    const req = requestFromHeaders({
      "x-agentforge-authenticated-actor": actor,
      "x-agentforge-authenticated-role": role,
      "x-agentforge-authenticated-organization": org,
      "x-agentforge-signature-timestamp": timestamp,
      "x-agentforge-signature": signature
    });

    const result = resolveApiActor(req);
    expect(result).toBeUndefined();
  });

  it("rejects a request carrying a raw spoofable x-agentforge-actor header alongside otherwise-valid signed headers", () => {
    // Proves AGENTFORGE_AUTH_PROXY_STRIPS_HEADERS is enforced at request time: if the
    // ingress proxy failed to strip the raw header (or an attacker reaches the app
    // directly), the request is rejected outright rather than silently resolved from
    // the signed header set alone.
    process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS = "true";
    process.env.AGENTFORGE_API_PROXY_SECRET = secret;

    const actor = "alex";
    const role = "platform_admin";
    const org = "org_test";
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const payload = [timestamp, actor, role, org].join(":");
    const signature = createHmac("sha256", secret).update(payload).digest("hex");

    const req = requestFromHeaders({
      "x-agentforge-authenticated-actor": actor,
      "x-agentforge-authenticated-role": role,
      "x-agentforge-authenticated-organization": org,
      "x-agentforge-signature-timestamp": timestamp,
      "x-agentforge-signature": signature,
      // Spoofed raw header injected by a client the proxy failed to strip.
      "x-agentforge-actor": "attacker",
      "x-agentforge-role": "platform_admin",
      "x-agentforge-organization": "org_victim"
    });

    const result = resolveApiActor(req);
    expect(result).toBeUndefined();
  });

  it("rejects a request carrying only a raw spoofable header with no signed headers at all", () => {
    process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS = "true";
    process.env.AGENTFORGE_API_PROXY_SECRET = secret;

    const req = requestFromHeaders({
      "x-agentforge-actor": "attacker",
      "x-agentforge-role": "platform_admin",
      "x-agentforge-organization": "org_victim"
    });

    const result = resolveApiActor(req);
    expect(result).toBeUndefined();
  });

  it("still accepts a valid signed request with no raw headers present (regression guard)", () => {
    process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS = "true";
    process.env.AGENTFORGE_API_PROXY_SECRET = secret;

    const actor = "alex";
    const role = "platform_admin";
    const org = "org_test";
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const payload = [timestamp, actor, role, org].join(":");
    const signature = createHmac("sha256", secret).update(payload).digest("hex");

    const req = requestFromHeaders({
      "x-agentforge-authenticated-actor": actor,
      "x-agentforge-authenticated-role": role,
      "x-agentforge-authenticated-organization": org,
      "x-agentforge-signature-timestamp": timestamp,
      "x-agentforge-signature": signature
    });

    const result = resolveApiActor(req);
    expect(result).toEqual({ login: actor, role, organizationId: org });
  });
});
