import { createHmac, timingSafeEqual } from "node:crypto";
import { SignatureReplayGuard } from "@agentforge/core/cache";
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

const SIGNATURE_WINDOW_SECONDS = 5 * 60;
// Cross-instance-safe replay cache backed by Redis (SET NX EX), falling back
// to a bounded in-process claim set when REDIS_URL is unset/unreachable. See
// apps/api/src/auth.ts's identical pattern; a distinct key namespace
// ("agentforge:replay:dashboard:") keeps API and dashboard replay claims from
// ever colliding even though both share the same Redis instance in most
// deployments.
const dashboardSignatureReplayGuard = new SignatureReplayGuard(process.env.REDIS_URL);

async function registerDashboardSignatureUse(signature: string, nowMs: number): Promise<boolean> {
  return dashboardSignatureReplayGuard.claim(
    `agentforge:replay:dashboard:${signature}`,
    SIGNATURE_WINDOW_SECONDS,
    nowMs
  );
}

export async function resolveDashboardActorContext(
  input: ActorContextInput = {}
): Promise<DashboardActorContext | undefined> {
  const env = input.env ?? process.env;
  if (env.AGENTFORGE_DASHBOARD_TRUST_PROXY_HEADERS === "true" && input.headers) {
    const fromHeaders = await dashboardActorFromTrustedHeaders(
      input.headers,
      env.AGENTFORGE_DASHBOARD_PROXY_SECRET
    );
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

  if (env.AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR === "true") {
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

async function dashboardActorFromTrustedHeaders(
  headers: HeaderReader,
  secret: string | undefined,
  now: number = Date.now()
): Promise<DashboardActorContext | undefined> {
  // Fail closed: trusted identity headers are honored ONLY when the ingress
  // proxy signs them with the shared secret (same HMAC-SHA256 scheme the API
  // uses). Without this, anyone able to reach the dashboard directly could
  // spoof x-agentforge-authenticated-* headers and the dashboard would re-sign
  // them for the API (AF-SEC M1).
  if (!secret) {
    return undefined;
  }
  const login = headers.get("x-agentforge-authenticated-actor")?.trim() || undefined;
  const role = headers.get("x-agentforge-authenticated-role")?.trim() || undefined;
  const organizationId =
    headers.get("x-agentforge-authenticated-organization")?.trim() || undefined;
  const timestampStr = headers.get("x-agentforge-signature-timestamp")?.trim() || undefined;
  const signatureStr = headers.get("x-agentforge-signature")?.trim() || undefined;
  const nonceStr = headers.get("x-agentforge-signature-nonce")?.trim() || undefined;
  // The nonce is mandatory, not optional: a nonce-less signed request has no
  // per-request binding, so registerDashboardSignatureUse is never consulted
  // for it and it could otherwise be replayed indefinitely within the
  // 5-minute timestamp window. Reject rather than silently accept a legacy
  // nonce-less payload (mirrors apps/api/src/auth.ts's resolveApiActor).
  if (!login || !role || !organizationId || !timestampStr || !signatureStr || !nonceStr) {
    return undefined;
  }
  const timestamp = Number.parseInt(timestampStr, 10);
  if (
    Number.isNaN(timestamp) ||
    Math.abs(Math.floor(now / 1000) - timestamp) > SIGNATURE_WINDOW_SECONDS
  ) {
    return undefined;
  }
  if (!/^[a-fA-F0-9]+$/u.test(signatureStr)) {
    return undefined;
  }
  const payload = [timestampStr, nonceStr, login, role, organizationId].join(":");
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const provided = Buffer.from(signatureStr, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  if (provided.length !== expectedBuf.length || !timingSafeEqual(provided, expectedBuf)) {
    return undefined;
  }
  // Reject replays of a previously seen signed request within the window.
  // The nonce is now mandatory (checked above), so this always runs.
  if (!(await registerDashboardSignatureUse(signatureStr, now))) {
    return undefined;
  }
  const safeLogin = safeActorValue(login);
  const safeRole = safeRoleValue(role);
  const safeOrganizationId = safeOrganizationValue(organizationId);
  return safeLogin && safeRole && safeOrganizationId
    ? {
        login: safeLogin,
        role: safeRole,
        organizationId: safeOrganizationId,
        source: "trusted_headers"
      }
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
  const role = safeRoleValue(env.AGENTFORGE_DASHBOARD_ROLE ?? "developer");
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
