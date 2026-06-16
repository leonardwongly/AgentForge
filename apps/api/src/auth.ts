import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

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
// Best-effort in-process replay cache. Each signed request carries a unique
// nonce; once a signature is seen it is rejected until its window expires.
// NOTE: this is per-instance. Multi-instance API deployments behind a load
// balancer should use sticky routing or a shared store for cross-instance
// replay protection; the timestamp window still bounds replay regardless.
const seenSignatures = new Map<string, number>();

function registerSignatureUse(signature: string, nowMs: number): boolean {
  if (seenSignatures.size > 20_000) {
    for (const [key, expiry] of seenSignatures) {
      if (expiry <= nowMs) {
        seenSignatures.delete(key);
      }
    }
  }
  const existing = seenSignatures.get(signature);
  if (existing !== undefined && existing > nowMs) {
    return false;
  }
  seenSignatures.set(signature, nowMs + SIGNATURE_REPLAY_WINDOW_SECONDS * 1000);
  return true;
}

export function resolveApiActor(request: FastifyRequest): ApiActor | undefined {
  if (process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS === "true") {
    const secret = process.env.AGENTFORGE_API_PROXY_SECRET;
    if (!secret) {
      throw new Error(
        "AGENTFORGE_API_PROXY_SECRET must be configured when AGENTFORGE_API_TRUST_PROXY_HEADERS is enabled."
      );
    }

    const actorStr = headerValue(request.headers["x-agentforge-authenticated-actor"]);
    const roleStr = headerValue(request.headers["x-agentforge-authenticated-role"]);
    const orgStr = headerValue(request.headers["x-agentforge-authenticated-organization"]);
    const timestampStr = headerValue(request.headers["x-agentforge-signature-timestamp"]);
    const signatureStr = headerValue(request.headers["x-agentforge-signature"]);
    const nonceStr = headerValue(request.headers["x-agentforge-signature-nonce"]);

    if (!actorStr || !roleStr || !orgStr || !timestampStr || !signatureStr) {
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

    // Reconstruct payload and verify HMAC-SHA256 signature. The nonce (when the
    // signer includes one) binds the signature to a single request so it can be
    // rejected on replay.
    const payload = nonceStr
      ? [timestampStr, nonceStr, actorStr, roleStr, orgStr].join(":")
      : [timestampStr, actorStr, roleStr, orgStr].join(":");
    const expectedSignature = createHmac("sha256", secret).update(payload).digest("hex");

    const bufA = Buffer.from(signatureStr, "hex");
    const bufB = Buffer.from(expectedSignature, "hex");

    if (bufA.length !== bufB.length || !timingSafeEqual(bufA, bufB)) {
      return undefined;
    }

    const actor = actorFromHeaders(actorStr, roleStr, orgStr);
    if (actor) {
      // Reject replays of a previously seen signed request within the window.
      if (nonceStr && !registerSignatureUse(signatureStr, Date.now())) {
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

export function requireApiActor(request: FastifyRequest): ApiActor | AuthzFailure {
  const actor = resolveApiActor(request);
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
