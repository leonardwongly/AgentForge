import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { buildContentSecurityPolicy, cspHeaderName, cspOriginFromUrl } from "./app/security/csp";

/**
 * Generates a per-request CSP nonce and emits a nonce-based Content-Security-Policy.
 *
 * Setting the CSP on the forwarded request headers lets Next.js propagate the
 * nonce to its own bootstrap <script> tags; setting it on the response makes the
 * browser enforce it. This replaces the previous static `script-src 'unsafe-inline'`
 * (AF-SEC L2).
 */
export function middleware(request: NextRequest): NextResponse {
  const randomBytes = new Uint8Array(16);
  crypto.getRandomValues(randomBytes);
  let binary = "";
  for (const byte of randomBytes) {
    binary += String.fromCharCode(byte);
  }
  const nonce = btoa(binary);

  const isProduction = process.env.NODE_ENV === "production";
  const csp = buildContentSecurityPolicy({
    nonce,
    isProduction,
    apiOrigin: cspOriginFromUrl(process.env.API_BASE_URL)
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(cspHeaderName(isProduction), csp);
  return response;
}

export const config = {
  // Apply to all routes except Next static assets and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.svg).*)"]
};
