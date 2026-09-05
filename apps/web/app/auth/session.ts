import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const DASHBOARD_SESSION_COOKIE = "agentforge_dashboard_session";
export const GITHUB_OAUTH_STATE_COOKIE = "agentforge_github_oauth_state";
// Keep dashboard credentials short-lived.  The session is a signed bearer
// token, so a stolen cookie remains usable until expiry unless the caller is
// forced through OAuth again.  One hour limits that replay window while
// keeping normal dashboard sessions practical.
export const DASHBOARD_SESSION_MAX_AGE_SECONDS = 60 * 60;
const MAX_SESSION_CLAIM_LENGTH = 256;
const MAX_COOKIE_HEADER_BYTES = 16_384;
const MAX_SIGNED_COOKIE_BYTES = 4_096;
const MAX_OAUTH_STATE_LENGTH = 256;

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
      expiresAt: issuedAt + DASHBOARD_SESSION_MAX_AGE_SECONDS
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
  if (
    !session ||
    typeof session !== "object" ||
    typeof session.login !== "string" ||
    typeof session.role !== "string" ||
    typeof session.organizationId !== "string" ||
    session.provider !== "github" ||
    session.login.length === 0 ||
    session.login.length > MAX_SESSION_CLAIM_LENGTH ||
    session.role.length === 0 ||
    session.role.length > MAX_SESSION_CLAIM_LENGTH ||
    session.organizationId.length === 0 ||
    session.organizationId.length > MAX_SESSION_CLAIM_LENGTH
  ) {
    return undefined;
  }
  const nowSeconds = Math.floor(now / 1000);
  // Reject malformed future-dated sessions and treat the expiry instant as
  // invalid (rather than granting an extra second at the boundary).
  if (
    !Number.isSafeInteger(session.issuedAt) ||
    !Number.isSafeInteger(session.expiresAt) ||
    session.expiresAt <= session.issuedAt ||
    session.issuedAt > nowSeconds + 60 ||
    session.expiresAt > session.issuedAt + DASHBOARD_SESSION_MAX_AGE_SECONDS ||
    nowSeconds >= session.issuedAt + DASHBOARD_SESSION_MAX_AGE_SECONDS ||
    session.expiresAt <= nowSeconds
  ) {
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
  const issuedAt = payload?.issuedAt;
  if (
    typeof payload?.state !== "string" ||
    payload.state.length === 0 ||
    payload.state.length > MAX_OAUTH_STATE_LENGTH ||
    typeof issuedAt !== "number" ||
    !Number.isSafeInteger(issuedAt)
  ) {
    return undefined;
  }
  const ageSeconds = Math.floor(Date.now() / 1000) - issuedAt;
  // OAuth state is short-lived and must not be valid before it was issued.
  // A small clock-skew allowance keeps hosts with slightly different clocks
  // usable without turning future-dated state into a replay window.
  return ageSeconds >= -60 && ageSeconds <= 10 * 60 ? payload.state : undefined;
}

function signJson(payload: Record<string, unknown>, secret: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${signature(encodedPayload, secret)}`;
}

function readSignedJson<T>(value: string, secret: string): T | undefined {
  if (Buffer.byteLength(value, "utf8") > MAX_SIGNED_COOKIE_BYTES) {
    return undefined;
  }
  const parts = value.split(".");
  if (parts.length !== 2) {
    return undefined;
  }
  const [payload, providedSignature] = parts;
  if (!payload || !providedSignature) {
    return undefined;
  }
  const expectedSignature = signature(payload, secret);
  const provided = decodeBase64Url(providedSignature);
  const expected = Buffer.from(expectedSignature, "base64url");
  if (!provided || provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return undefined;
  }
  try {
    const decodedPayload = decodeBase64Url(payload);
    if (!decodedPayload) {
      return undefined;
    }
    return JSON.parse(decodedPayload.toString("utf8")) as T;
  } catch {
    return undefined;
  }
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) {
    return undefined;
  }
  return Buffer.from(value, "base64url");
}

function signature(message: string, secret: string): string {
  // This is a keyed MAC for cookie integrity, not a stored password hash.
  // codeql[js/insufficient-password-hash]
  return createHmac("sha256", secret).update(Buffer.from(message, "utf8")).digest("base64url");
}

function cookieValue(cookieHeader: string | null | undefined, name: string): string | undefined {
  if (!cookieHeader || Buffer.byteLength(cookieHeader, "utf8") > MAX_COOKIE_HEADER_BYTES) {
    return undefined;
  }
  let value: string | undefined;
  for (const pair of cookieHeader.split(cookiePairPattern)) {
    const separator = pair.indexOf("=");
    if (separator < 0 || pair.slice(0, separator).trim() !== name) {
      continue;
    }
    if (value !== undefined) {
      // Duplicate cookie names are ambiguous across proxies and frameworks.
      // Reject them rather than allowing ordering differences to select the
      // authenticated value.
      return undefined;
    }
    const candidate = pair.slice(separator + 1).trim();
    if (!candidate || Buffer.byteLength(candidate, "utf8") > MAX_SIGNED_COOKIE_BYTES) {
      return undefined;
    }
    value = candidate;
  }
  return value;
}
