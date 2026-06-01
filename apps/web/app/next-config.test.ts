import { pathToFileURL } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const mutableEnvKeys = ["NODE_ENV", "API_BASE_URL"] as const;
const originalEnv = new Map<string, string | undefined>(
  mutableEnvKeys.map((key) => [key, process.env[key]])
);
const mutableEnv = process.env as Record<string, string | undefined>;

describe("Next.js security headers", () => {
  afterEach(() => {
    for (const key of mutableEnvKeys) {
      const originalValue = originalEnv.get(key);
      if (originalValue === undefined) {
        delete mutableEnv[key];
      } else {
        mutableEnv[key] = originalValue;
      }
    }
  });

  it("enforces production CSP without eval or broad connect-src", async () => {
    mutableEnv.NODE_ENV = "production";
    mutableEnv.API_BASE_URL = "https://api.agentforge.example";

    const config = await loadNextConfig();
    const headers = await config.headers();
    const headerEntries = headers[0]?.headers ?? [];
    const csp = headerEntries.find((header) => header.key === "Content-Security-Policy");

    expect(csp?.value).toBeDefined();
    expect(
      headerEntries.some((header) => header.key === "Content-Security-Policy-Report-Only")
    ).toBe(false);
    expect(csp!.value).toContain("connect-src 'self' https://api.agentforge.example");
    expect(cspDirective(csp!.value, "connect-src")).not.toContain("https:");
    expect(csp!.value).not.toContain("'unsafe-eval'");
  });

  it("keeps development CSP report-only with localhost API access", async () => {
    mutableEnv.NODE_ENV = "development";
    mutableEnv.API_BASE_URL = "http://localhost:4000";

    const config = await loadNextConfig();
    const headers = await config.headers();
    const headerEntries = headers[0]?.headers ?? [];
    const csp = headerEntries.find(
      (header) => header.key === "Content-Security-Policy-Report-Only"
    );

    expect(csp?.value).toContain("connect-src 'self' http://localhost:4000");
    expect(csp?.value).toContain("'unsafe-eval'");
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

function cspDirective(value: string, name: string): string[] {
  const directive = value
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `));
  return directive?.split(/\s+/u).slice(1) ?? [];
}
