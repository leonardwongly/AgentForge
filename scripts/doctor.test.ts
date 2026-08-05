import { describe, expect, it } from "vitest";

import {
  checkNodeVersion,
  computeReadinessScore,
  formatDoctorReport,
  NODE_MINIMUM,
  PNPM_EXPECTED,
  type DoctorCheck
} from "./doctor.js";

function check(partial: Partial<DoctorCheck>): DoctorCheck {
  return {
    name: partial.name ?? "check",
    ok: partial.ok ?? true,
    required: partial.required ?? true,
    detail: partial.detail ?? "detail",
    remediation: partial.remediation
  };
}

describe("doctor readiness scoring", () => {
  it("is ready only when every required check passes", () => {
    const report = computeReadinessScore([
      check({ name: "Node", ok: true }),
      check({ name: "Redis", ok: true }),
      check({ name: "MinIO", ok: false, required: false })
    ]);
    expect(report.ready).toBe(true);
    expect(report.requiredPassed).toBe(2);
    expect(report.requiredTotal).toBe(2);
    expect(report.optionalPassed).toBe(0);
    expect(report.optionalTotal).toBe(1);
  });

  it("is not ready when a required check fails", () => {
    const report = computeReadinessScore([
      check({ name: "Node", ok: true }),
      check({ name: "Postgres", ok: false })
    ]);
    expect(report.ready).toBe(false);
    expect(report.requiredPassed).toBe(1);
    expect(report.requiredTotal).toBe(2);
  });

  it("formats a human-readable report with remediation", () => {
    const report = computeReadinessScore([
      check({ name: "Postgres", ok: false, remediation: "docker compose up -d postgres" })
    ]);
    const text = formatDoctorReport(report);
    expect(text).toContain("FAIL Postgres");
    expect(text).toContain("Fix: docker compose up -d postgres");
    expect(text).toContain("0/1 required checks passed");
  });
});

describe("doctor version checks", () => {
  it("accepts Node versions at or above the minimum", () => {
    expect(checkNodeVersion().required).toBe(true);
    expect(NODE_MINIMUM).toBe("22.13");
  });

  it("exposes the expected pnpm version", () => {
    expect(PNPM_EXPECTED).toBe("11.1.1");
  });
});
