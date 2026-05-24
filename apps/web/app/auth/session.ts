import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const DASHBOARD_SESSION_COOKIE = "agentforge_dashboard_session";
export const GITHUB_OAUTH_STATE_COOKIE = "agentforge_github_oauth_state";

export type DashboardSession = {
  login: string;
  role: string;
  organizationId: string;
  provider: "github";
  issuedAt: number;
  expiresAt: number;
};

const cookiePairPattern = /;\s*/u;

export function createDashboardSessionCookie(
  input: Pick<DashboardSession, "login" | "role" | "organizationId" | "provider">,
  secret: string,
  now = Date.now()
): string {
  const issuedAt = Math.floor(now / 1000);
  return signJson(
    {
      ...input,
      issuedAt,
      expiresAt: issuedAt + 60 * 60 * 8
    },
    secret
  );
}

export function readDashboardSessionFromCookieHeader(
  cookieHeader: string | null | undefined,
  secret: string | undefined,
  now = Date.now()
): DashboardSession | undefined {
  if (!secret) {
    return undefined;
  }
  const value = cookieValue(cookieHeader, DASHBOARD_SESSION_COOKIE);
  if (!value) {
    return undefined;
  }
  const session = readSignedJson<DashboardSession>(value, secret);
  if (!session) {
    return undefined;
  }
  if (session.expiresAt < Math.floor(now / 1000)) {
    return undefined;
  }
  return session;
}

export function createOauthStateCookie(secret: string): { state: string; value: string } {
  const state = randomBytes(24).toString("base64url");
  return { state, value: signJson({ state, issuedAt: Math.floor(Date.now() / 1000) }, secret) };
}

export function readOauthStateCookie(
  cookieHeader: string | null | undefined,
  secret: string | undefined
): string | undefined {
  if (!secret) {
    return undefined;
  }
  const value = cookieValue(cookieHeader, GITHUB_OAUTH_STATE_COOKIE);
  const payload = value
    ? readSignedJson<{ state?: string; issuedAt?: number }>(value, secret)
    : undefined;
  if (!payload?.state || !payload.issuedAt) {
    return undefined;
  }
  const ageSeconds = Math.floor(Date.now() / 1000) - payload.issuedAt;
  return ageSeconds <= 10 * 60 ? payload.state : undefined;
}

function signJson(payload: Record<string, unknown>, secret: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${signature(encodedPayload, secret)}`;
}

function readSignedJson<T>(value: string, secret: string): T | undefined {
  const [payload, providedSignature] = value.split(".");
  if (!payload || !providedSignature) {
    return undefined;
  }
  const expectedSignature = signature(payload, secret);
  const provided = Buffer.from(providedSignature, "base64url");
  const expected = Buffer.from(expectedSignature, "base64url");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T;
  } catch {
    return undefined;
  }
}

function signature(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function cookieValue(cookieHeader: string | null | undefined, name: string): string | undefined {
  return cookieHeader
    ?.split(cookiePairPattern)
    .map((pair) => pair.split("="))
    .find(([key]) => key === name)
    ?.slice(1)
    .join("=");
}
