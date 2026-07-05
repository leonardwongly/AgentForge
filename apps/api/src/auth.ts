import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { SignatureReplayGuard } from "@agentforge/core";

export type ApiActor = {
  login: string;
  role: string;
  organizationId: string;
};

export type AuthzFailure = { ok: false; statusCode: 401 | 403; reason: string };
export type AuthzDecision = { ok: true } | AuthzFailure;

const allowedRoles = new Set([
  "platform_admin",
  "engineering_manager",
  "auditor",
  "security_reviewer",
  "developer"
]);
const actorPattern = /^[A-Za-z0-9_.@-]{1,128}$/u;
const rolePattern = /^[a-z][a-z0-9_-]{0,63}$/u;
const organizationPattern = /^[A-Za-z0-9_.-]{1,128}$/u;
const localOrganizationId = "org_local";

const SIGNATURE_REPLAY_WINDOW_SECONDS = 5 * 60;
// Cross-instance-safe replay cache backed by Redis (SET NX EX), falling back
// to a bounded in-process claim set when REDIS_URL is unset/unreachable. A
// single module-level instance is intentional: this guard's own internal
// Redis connection lifecycle (lazy connect, error/reconnect tracking) is
// meant to be shared process-wide, exactly like packages/core/src/cache.ts's
// RedisCacheManager instances in apps/api/src/app.ts and
// apps/worker/src/index.ts. AF-SEC: closes the multi-instance replay gap a
// per-process Map could not.
const signatureReplayGuard = new SignatureReplayGuard(process.env.REDIS_URL);

async function registerSignatureUse(signature: string, nowMs: number): Promise<boolean> {
  return signatureReplayGuard.claim(
    `agentforge:replay:api:${signature}`,
    SIGNATURE_REPLAY_WINDOW_SECONDS,
    nowMs
  );
}

// Raw, unsigned identity headers a spoofing client could set directly. These are
// only ever legitimate input to auth.ts when AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS
// (local dev) or NODE_ENV=test is active. When trust-proxy mode is active instead,
// AGENTFORGE_AUTH_PROXY_STRIPS_HEADERS attests that the ingress proxy strips these
// before they can reach the app — but that attestation is unenforceable from inside
// the process. Seeing one of these headers arrive on a trust-proxy request is a
// concrete signal that attestation is false for THIS request (the proxy did not
// strip it), so we log it and refuse to resolve any actor for the request at all,
// rather than silently falling through and trusting only the signed header set.
const SPOOFABLE_RAW_IDENTITY_HEADERS = [
  "x-agentforge-actor",
  "x-agentforge-role",
  "x-agentforge-organization"
] as const;

function rawIdentityHeaderNamesPresent(request: FastifyRequest): string[] {
  return SPOOFABLE_RAW_IDENTITY_HEADERS.filter((name) => headerValue(request.headers[name]));
}

// Caches the actor resolved for a given request object within resolveApiActor's
// own lifetime. Trusted-proxy signatures are nonce-bound and single-use
// (registerSignatureUse consumes the nonce on first successful verification) —
// without this cache, a request-scoped hook that resolves the actor early (e.g.
// binding RLS org context in app.ts's onRequest hook) would consume the nonce,
// and the route handler's own later resolveApiActor call on the SAME request
// would then see it as an already-used replay and reject a legitimate request.
// Caches the in-flight Promise itself (not just its resolved value): two
// near-simultaneous resolveApiActor calls on the same request object (e.g. the
// onRequest hook and a route handler both awaiting before either has settled)
// must share one nonce claim, not race to both call registerSignatureUse.
// WeakMap avoids any manual cleanup: entries are collected with the request.
const resolvedActorCache = new WeakMap<FastifyRequest, Promise<ApiActor | undefined>>();

export function resolveApiActor(request: FastifyRequest): Promise<ApiActor | undefined> {
  const cached = resolvedActorCache.get(request);
  if (cached) {
    return cached;
  }
  const resolution = resolveApiActorUncached(request);
  resolvedActorCache.set(request, resolution);
  return resolution;
}

async function resolveApiActorUncached(request: FastifyRequest): Promise<ApiActor | undefined> {
  if (process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS === "true") {
    const secret = process.env.AGENTFORGE_API_PROXY_SECRET;
    if (!secret) {
      throw new Error(
        "AGENTFORGE_API_PROXY_SECRET must be configured when AGENTFORGE_API_TRUST_PROXY_HEADERS is enabled."
      );
    }

    // Enforce the AGENTFORGE_AUTH_PROXY_STRIPS_HEADERS attestation at request time,
    // not just at config load. If a raw, spoofable actor/role/organization header
    // reaches us while trust-proxy mode is on, the proxy failed to strip it (or
    // there is no stripping proxy) — reject the request outright rather than
    // silently ignoring the anomaly, so a misconfigured deployment fails loudly
    // instead of appearing to work while quietly relying on unverified input.
    const spoofedHeaderNames = rawIdentityHeaderNamesPresent(request);
    if (spoofedHeaderNames.length > 0) {
      request.log?.warn?.(
        {
          headers: spoofedHeaderNames,
          path: request.url
        },
        "Rejected request carrying raw spoofable identity headers while AGENTFORGE_API_TRUST_PROXY_HEADERS is enabled; the ingress proxy did not strip them as AGENTFORGE_AUTH_PROXY_STRIPS_HEADERS attests."
      );
      return undefined;
    }

    const actorStr = headerValue(request.headers["x-agentforge-authenticated-actor"]);
    const roleStr = headerValue(request.headers["x-agentforge-authenticated-role"]);
    const orgStr = headerValue(request.headers["x-agentforge-authenticated-organization"]);
    const timestampStr = headerValue(request.headers["x-agentforge-signature-timestamp"]);
    const signatureStr = headerValue(request.headers["x-agentforge-signature"]);
    const nonceStr = headerValue(request.headers["x-agentforge-signature-nonce"]);

    // The nonce is mandatory, not optional: a nonce-less signed request has no
    // per-request binding, so registerSignatureUse is never consulted for it and
    // it could otherwise be replayed indefinitely within the 5-minute timestamp
    // window. Reject rather than silently accept a legacy nonce-less payload.
    if (!actorStr || !roleStr || !orgStr || !timestampStr || !signatureStr || !nonceStr) {
      return undefined;
    }

    // Validate timestamp (5-minute window clock skew)
    const now = Math.floor(Date.now() / 1000);
    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp)) {
      return undefined;
    }
    if (Math.abs(now - timestamp) > SIGNATURE_REPLAY_WINDOW_SECONDS) {
      return undefined;
    }

    // Validate signature format is hex
    if (!/^[a-fA-F0-9]+$/.test(signatureStr)) {
      return undefined;
    }

    // Reconstruct payload and verify HMAC-SHA256 signature. The nonce binds the
    // signature to a single request so it can be rejected on replay.
    const payload = [timestampStr, nonceStr, actorStr, roleStr, orgStr].join(":");
    const expectedSignature = createHmac("sha256", secret).update(payload).digest("hex");

    const bufA = Buffer.from(signatureStr, "hex");
    const bufB = Buffer.from(expectedSignature, "hex");

    if (bufA.length !== bufB.length || !timingSafeEqual(bufA, bufB)) {
      return undefined;
    }

    const actor = actorFromHeaders(actorStr, roleStr, orgStr);
    if (actor) {
      // Reject replays of a previously seen signed request within the window.
      // The nonce is now mandatory (checked above), so this always runs.
      if (!(await registerSignatureUse(signatureStr, Date.now()))) {
        return undefined;
      }
      return actor;
    }
  }

  if (
    process.env.NODE_ENV === "test" ||
    process.env.AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS === "true"
  ) {
    return actorFromHeaders(
      request.headers["x-agentforge-actor"],
      request.headers["x-agentforge-role"],
      request.headers["x-agentforge-organization"],
      localOrganizationId
    );
  }

  return undefined;
}

export async function requireApiActor(request: FastifyRequest): Promise<ApiActor | AuthzFailure> {
  const actor = await resolveApiActor(request);
  if (!actor) {
    return {
      ok: false,
      statusCode: 401,
      reason: "Authenticated actor headers are required for this governance action."
    };
  }
  return actor;
}

export function requireRole(
  actor: ApiActor,
  allowedRoles: readonly string[],
  action: string
): AuthzDecision {
  if (allowedRoles.includes(actor.role)) {
    return { ok: true };
  }
  return {
    ok: false,
    statusCode: 403,
    reason: `${action} requires one of these roles: ${allowedRoles.join(", ")}.`
  };
}

export function requireOrganizationAccess(
  actor: ApiActor,
  organizationId: string,
  action: string
): AuthzDecision {
  if (actor.organizationId === organizationId) {
    return { ok: true };
  }
  return {
    ok: false,
    statusCode: 403,
    reason: `${action} is scoped to a different organization.`
  };
}

export function isAuthzFailure(value: ApiActor | AuthzDecision): value is AuthzFailure {
  return "ok" in value && !value.ok;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = first?.trim();
  return trimmed || undefined;
}

function actorFromHeaders(
  loginHeader: string | string[] | undefined,
  roleHeader: string | string[] | undefined,
  organizationHeader: string | string[] | undefined,
  defaultOrganizationId?: string
): ApiActor | undefined {
  const login = headerValue(loginHeader);
  const role = headerValue(roleHeader);
  const organizationId = headerValue(organizationHeader) ?? defaultOrganizationId;
  if (!login || !role || !organizationId) {
    return undefined;
  }
  if (
    !actorPattern.test(login) ||
    !rolePattern.test(role) ||
    !allowedRoles.has(role) ||
    !organizationPattern.test(organizationId)
  ) {
    return undefined;
  }
  return { login, role, organizationId };
}
