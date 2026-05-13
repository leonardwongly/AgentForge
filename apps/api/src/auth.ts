import type { FastifyRequest } from "fastify";

export type ApiActor = {
  login: string;
  role: string;
};

export type AuthzFailure = { ok: false; statusCode: 401 | 403; reason: string };
export type AuthzDecision = { ok: true } | AuthzFailure;

export function resolveApiActor(request: FastifyRequest): ApiActor | undefined {
  const login = headerValue(request.headers["x-agentforge-actor"]);
  const role = headerValue(request.headers["x-agentforge-role"]);
  if (!login || !role) {
    return undefined;
  }
  return { login, role };
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

export function actorOrSystem(request: FastifyRequest): ApiActor {
  return resolveApiActor(request) ?? { login: "system", role: "system" };
}

export function isAuthzFailure(value: ApiActor | AuthzDecision): value is AuthzFailure {
  return "ok" in value && !value.ok;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = first?.trim();
  return trimmed || undefined;
}
