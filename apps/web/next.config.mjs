import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const apiOrigin = originFromEnvUrl(process.env.API_BASE_URL);
const isProduction = process.env.NODE_ENV === "production";
const cspConnectSources = uniqueDirectiveValues([
  "'self'",
  isProduction ? undefined : "http://localhost:4000",
  isProduction ? undefined : "http://127.0.0.1:4000",
  apiOrigin
]);
const cspScriptSources = uniqueDirectiveValues([
  "'self'",
  // Next currently emits inline bootstrap scripts. Keep this explicit until the
  // dashboard moves to a nonce-based CSP path; never allow eval in production.
  "'unsafe-inline'",
  isProduction ? undefined : "'unsafe-eval'"
]);
const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "form-action 'self'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  `connect-src ${cspConnectSources.join(" ")}`,
  `script-src ${cspScriptSources.join(" ")}`,
  "style-src 'self' 'unsafe-inline'"
].join("; ");
export const cspHeaderName = isProduction
  ? "Content-Security-Policy"
  : "Content-Security-Policy-Report-Only";

function originFromEnvUrl(value) {
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function uniqueDirectiveValues(values) {
  return [...new Set(values.filter(Boolean))];
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  transpilePackages: ["@agentforge/config", "@agentforge/core", "@agentforge/ui"],
  turbopack: {
    root: repoRoot
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: cspHeaderName, value: csp }
        ]
      }
    ];
  }
};

export default nextConfig;
