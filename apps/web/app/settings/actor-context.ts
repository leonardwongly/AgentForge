import { readDashboardSessionFromCookieHeader } from "../auth/session";

export type DashboardActorContext = {
  login: string;
  role: string;
  organizationId: string;
  source: "trusted_headers" | "session" | "local_environment";
};

type HeaderReader = {
  get(name: string): string | null | undefined;
};

type ActorContextInput = {
  headers?: HeaderReader | undefined;
  env?: Record<string, string | undefined> | undefined;
  nodeEnv?: string | undefined;
};

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

export function resolveDashboardActorContext(
  input: ActorContextInput = {}
): DashboardActorContext | undefined {
  const env = input.env ?? process.env;
  if (env.AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS === "true" && input.headers) {
    const fromHeaders = dashboardActorFromTrustedHeaders(input.headers);
    if (fromHeaders) {
      return fromHeaders;
    }
  }

  const fromSession = input.headers
    ? dashboardActorFromSession(input.headers, env.SESSION_SECRET)
    : undefined;
  if (fromSession) {
    return fromSession;
  }

  if (input.nodeEnv !== "production" || env.AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR === "true") {
    return dashboardActorFromLocalEnvironment(env);
  }

  return undefined;
}

export function dashboardActorErrorMessage(): string {
  return [
    "Authenticated dashboard actor context is required.",
    "Configure trusted auth headers or enable the explicit local actor fallback for development."
  ].join(" ");
}

function dashboardActorFromTrustedHeaders(
  headers: HeaderReader
): DashboardActorContext | undefined {
  const login = safeActorValue(headers.get("x-agentforge-authenticated-actor"));
  const role = safeRoleValue(headers.get("x-agentforge-authenticated-role"));
  const organizationId = safeOrganizationValue(
    headers.get("x-agentforge-authenticated-organization")
  );
  return login && role && organizationId
    ? { login, role, organizationId, source: "trusted_headers" }
    : undefined;
}

function dashboardActorFromSession(
  headers: HeaderReader,
  secret: string | undefined
): DashboardActorContext | undefined {
  const session = readDashboardSessionFromCookieHeader(headers.get("cookie"), secret);
  const login = safeActorValue(session?.login);
  const role = safeRoleValue(session?.role);
  const organizationId = safeOrganizationValue(session?.organizationId);
  return login && role && organizationId
    ? { login, role, organizationId, source: "session" }
    : undefined;
}

function dashboardActorFromLocalEnvironment(
  env: Record<string, string | undefined>
): DashboardActorContext | undefined {
  const login = safeActorValue(env.AGENTFORGE_DASHBOARD_ACTOR ?? "dashboard-local");
  const role = safeRoleValue(env.AGENTFORGE_DASHBOARD_ROLE ?? "platform_admin");
  const organizationId = safeOrganizationValue(
    env.AGENTFORGE_DASHBOARD_ORGANIZATION ?? localOrganizationId
  );
  return login && role && organizationId
    ? { login, role, organizationId, source: "local_environment" }
    : undefined;
}

function safeActorValue(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && actorPattern.test(trimmed) ? trimmed : undefined;
}

function safeRoleValue(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && rolePattern.test(trimmed) && allowedRoles.has(trimmed) ? trimmed : undefined;
}

function safeOrganizationValue(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && organizationPattern.test(trimmed) ? trimmed : undefined;
}
