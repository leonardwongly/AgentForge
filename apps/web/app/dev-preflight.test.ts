import { describe, expect, it } from "vitest";
import { formatPreflightReport, hasPreflightFailure } from "../../../scripts/dev-preflight";

describe("local dev preflight reporting", () => {
  it("formats actionable failures without hiding successful checks", () => {
    const report = formatPreflightReport([
      { name: ".env", ok: true, required: true, detail: "local configuration file exists" },
      {
        name: "Redis",
        ok: false,
        required: true,
        detail: "not reachable at 127.0.0.1:6379",
        remediation: "Start local services with `docker compose up -d postgres redis minio`."
      }
    ]);

    expect(report).toContain("OK .env");
    expect(report).toContain("FAIL Redis");
    expect(report).toContain("docker compose up -d postgres redis minio");
  });

  it("reports optional service failures without blocking preflight", () => {
    const report = formatPreflightReport([
      {
        name: "MinIO",
        ok: false,
        required: false,
        detail: "not reachable at 127.0.0.1:9000",
        remediation:
          "Start MinIO with `docker compose up -d minio` when testing local export or object-storage behavior."
      }
    ]);

    expect(report).toContain("WARN MinIO");
    expect(
      hasPreflightFailure([{ name: "MinIO", ok: false, required: false, detail: "missing" }])
    ).toBe(false);
  });

  it("treats required failed checks as blocking preflight results", () => {
    expect(
      hasPreflightFailure([
        { name: ".env", ok: true, required: true, detail: "ok" },
        { name: "Postgres", ok: false, required: true, detail: "missing" }
      ])
    ).toBe(true);
    expect(hasPreflightFailure([{ name: ".env", ok: true, required: true, detail: "ok" }])).toBe(
      false
    );
  });
});
