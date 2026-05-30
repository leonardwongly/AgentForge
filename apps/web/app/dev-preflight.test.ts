import { describe, expect, it } from "vitest";
import {
  checkLocalActorExposure,
  formatPreflightReport,
  hasPreflightFailure
} from "../../../scripts/dev-preflight";

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

  it("blocks local actor fallback on non-loopback URLs", () => {
    const result = checkLocalActorExposure({
      AGENTFORGE_DASHBOARD_ALLOW_LOCAL_ACTOR: "true",
      APP_BASE_URL: "https://dashboard.example.com",
      API_BASE_URL: "http://127.0.0.1:4000"
    });

    expect(result).toMatchObject({
      name: "Local actor exposure",
      ok: false,
      required: true
    });
    expect(result.detail).toContain("APP_BASE_URL=https://dashboard.example.com");
    expect(hasPreflightFailure([result])).toBe(true);
  });

  it("allows local actor fallback on loopback URLs", () => {
    expect(
      checkLocalActorExposure({
        AGENTFORGE_API_ALLOW_LOCAL_ACTOR_HEADERS: "true",
        APP_BASE_URL: "http://localhost:3000",
        NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
        API_BASE_URL: "http://[::1]:4000"
      })
    ).toMatchObject({
      ok: true,
      detail: "local actor fallback is enabled only for loopback URLs"
    });
  });
});
