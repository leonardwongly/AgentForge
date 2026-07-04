import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy, cspHeaderName, cspOriginFromUrl } from "./csp";

function directive(value: string, name: string): string[] {
  const found = value
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `));
  return found?.split(/\s+/u).slice(1) ?? [];
}

describe("content security policy", () => {
  it("enforces a nonce-based production CSP without unsafe-inline or eval", () => {
    const csp = buildContentSecurityPolicy({
      nonce: "test-nonce",
      isProduction: true,
      apiOrigin: cspOriginFromUrl("https://api.agentforge.example")
    });

    expect(cspHeaderName(true)).toBe("Content-Security-Policy");

    const scriptSrc = directive(csp, "script-src");
    expect(scriptSrc).toContain("'nonce-test-nonce'");
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");

    expect(csp).toContain("connect-src 'self' https://api.agentforge.example");
    expect(directive(csp, "connect-src")).not.toContain("https:");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
  });

  it("keeps development CSP report-only with localhost API access and eval", () => {
    const csp = buildContentSecurityPolicy({
      nonce: "dev-nonce",
      isProduction: false,
      apiOrigin: cspOriginFromUrl("http://localhost:4000")
    });

    expect(cspHeaderName(false)).toBe("Content-Security-Policy-Report-Only");
    expect(csp).toContain("connect-src 'self' http://localhost:4000");
    expect(directive(csp, "script-src")).toContain("'unsafe-eval'");
    expect(directive(csp, "script-src")).toContain("'nonce-dev-nonce'");
  });
});
