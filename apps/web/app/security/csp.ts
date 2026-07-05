// Shared Content-Security-Policy builder used by the Next.js proxy (which
// injects a per-request nonce) and by tests. Pure/Edge-safe: no Node built-ins.

export function cspOriginFromUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function uniqueDirectiveValues(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function buildContentSecurityPolicy(options: {
  nonce: string;
  isProduction: boolean;
  apiOrigin?: string | undefined;
}): string {
  const { nonce, isProduction, apiOrigin } = options;
  const connectSrc = uniqueDirectiveValues([
    "'self'",
    isProduction ? undefined : "http://localhost:4000",
    isProduction ? undefined : "http://127.0.0.1:4000",
    apiOrigin
  ]);
  // Nonce + strict-dynamic is the CSP3 hardening that replaces 'unsafe-inline':
  // modern browsers ignore 'unsafe-inline'/host-sources when a nonce or
  // 'strict-dynamic' is present, so only Next's nonce-tagged bootstrap (and the
  // chunks it loads) may execute. 'unsafe-eval' is dev-only (React Refresh).
  const scriptSrc = uniqueDirectiveValues([
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    isProduction ? undefined : "'unsafe-eval'"
  ]);
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "form-action 'self'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    `connect-src ${connectSrc.join(" ")}`,
    `script-src ${scriptSrc.join(" ")}`,
    "style-src 'self' 'unsafe-inline'"
  ].join("; ");
}

export function cspHeaderName(isProduction: boolean): string {
  return isProduction ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only";
}
