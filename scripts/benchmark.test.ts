import { describe, expect, it } from "vitest";

import { formatBenchmarkReport, percentile, summarizeLatencies } from "./benchmark.js";

describe("benchmark helpers", () => {
  it("computes percentiles", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 95)).toBe(10);
    expect(percentile(sorted, 99)).toBe(10);
  });

  it("summarizes latencies and throughput", () => {
    const summary = summarizeLatencies([1, 2, 3, 4]);
    expect(summary.count).toBe(4);
    expect(summary.mean).toBeCloseTo(2.5, 3);
    // 4 evals in 10ms total => 400 evals/sec
    expect(summary.throughputPerSec).toBeCloseTo(400, 1);
  });

  it("formats a reproducible report", () => {
    const summary = summarizeLatencies([1, 2, 3]);
    const report = formatBenchmarkReport(summary, { fixtures: 3, iterations: 1, policyPack: "fintech" });
    expect(report).toContain("AgentForge evaluation pipeline benchmark");
    expect(report).toContain("3 fixtures x 1 iterations");
    expect(report).toContain("Latency p50");
    expect(report).toContain("Throughput");
  });
});
