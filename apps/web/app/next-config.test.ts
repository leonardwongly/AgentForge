import { pathToFileURL } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Next.js static security headers", () => {
  it("sets hardening headers and delegates CSP to the proxy", async () => {
    const config = await loadNextConfig();
    const headers = await config.headers();
    const headerEntries = headers[0]?.headers ?? [];
    const keys = headerEntries.map((header) => header.key);

    expect(keys).toContain("X-Frame-Options");
    expect(keys).toContain("X-Content-Type-Options");
    expect(keys).toContain("Cross-Origin-Opener-Policy");
    expect(keys).toContain("Permissions-Policy");

    // The CSP is emitted per-request by proxy.ts with a fresh nonce, so the
    // static config must NOT also emit one (that would produce a conflicting,
    // nonce-less policy).
    expect(keys).not.toContain("Content-Security-Policy");
    expect(keys).not.toContain("Content-Security-Policy-Report-Only");
  });
});

async function loadNextConfig(): Promise<{
  headers: () => Promise<Array<{ headers: Array<{ key: string; value: string }> }>>;
}> {
  const configUrl = pathToFileURL(path.resolve("apps/web/next.config.mjs"));
  configUrl.search = `cacheBust=${Date.now()}-${Math.random()}`;
  const mod = (await import(configUrl.href)) as {
    default: {
      headers: () => Promise<Array<{ headers: Array<{ key: string; value: string }> }>>;
    };
  };
  return mod.default;
}
