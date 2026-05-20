import { describe, expect, it } from "vitest";
import { formatPreflightReport, hasPreflightFailure } from "../../../scripts/dev-preflight";

describe("local dev preflight reporting", () => {
  it("formats actionable failures without hiding successful checks", () => {
    const report = formatPreflightReport([
      { name: ".env", ok: true, detail: "local configuration file exists" },
      {
        name: "Redis",
        ok: false,
        detail: "not reachable at 127.0.0.1:6379",
        remediation: "Start local services with `docker compose up -d postgres redis minio`."
      }
    ]);

    expect(report).toContain("OK .env");
    expect(report).toContain("FAIL Redis");
    expect(report).toContain("docker compose up -d postgres redis minio");
  });

  it("treats any failed check as a blocking preflight result", () => {
    expect(
      hasPreflightFailure([
        { name: ".env", ok: true, detail: "ok" },
        { name: "Postgres", ok: false, detail: "missing" }
      ])
    ).toBe(true);
    expect(hasPreflightFailure([{ name: ".env", ok: true, detail: "ok" }])).toBe(false);
  });
});
