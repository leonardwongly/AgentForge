import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// NOTE: the Content-Security-Policy is intentionally NOT set here. It is emitted
// per-request by middleware.ts with a fresh nonce so that script-src can use
// 'nonce-...' + 'strict-dynamic' instead of 'unsafe-inline' (AF-SEC L2). Static
// security headers that do not need a nonce remain below.

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
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" }
        ]
      }
    ];
  }
};

export default nextConfig;
