import { describe, expect, it } from "vitest";
import type { VerifiedFact } from "@agentforge/core";
import { DETECTOR_REGISTRY_VERSION, detectorRegistry } from "./index.js";

// Completeness gate: adding a new VerifiedFact type is a compile error here
// until listed, then this test fails until a detector declares it.
const allFactTypes: Record<VerifiedFact["type"], true> = {
  sensitive_path_changed: true,
  ci_workflow_changed: true,
  test_deleted: true,
  test_skipped: true,
  coverage_threshold_reduced: true,
  suspicious_test_change: true,
  dependency_added: true,
  dependency_bumped: true,
  migration_added: true,
  agent_signal_detected: true,
  secret_like_value_detected: true,
  detection_coverage_truncated: true
};

describe("detector registry (versioned plug-in surface)", () => {
  it("exposes a version and a non-empty registry", () => {
    expect(DETECTOR_REGISTRY_VERSION).toBeTruthy();
    expect(detectorRegistry.length).toBeGreaterThan(0);
  });

  it("declares a detector for every fact type", () => {
    const declared = new Set(detectorRegistry.flatMap((detector) => detector.factTypes));
    for (const type of Object.keys(allFactTypes) as VerifiedFact["type"][]) {
      expect(declared.has(type)).toBe(true);
    }
  });
});
