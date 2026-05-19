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

export function resolveApiActor(request: FastifyRequest): ApiActor | undefined {
  if (process.env.AGENTFORGE_API_TRUST_PROXY_HEADERS === "true") {
    const actor = actorFromHeaders(
      request.headers["x-agentforge-authenticated-actor"],
      request.headers["x-agentforge-authenticated-role"],
      request.headers["x-agentforge-authenticated-organization"]
    );
    if (actor) {
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

export function actorOrSystem(request: FastifyRequest): ApiActor {
  return (
    resolveApiActor(request) ?? {
      login: "system",
      role: "system",
      organizationId: localOrganizationId
    }
  );
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
