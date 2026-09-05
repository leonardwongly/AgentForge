import { describe, expect, it } from "vitest";

import {
  DEFAULT_ITERATIONS,
  formatBenchmarkReport,
  MAX_ITERATIONS,
  parseIterations,
  percentile,
  summarizeLatencies
} from "./benchmark.js";

describe("benchmark helpers", () => {
  it("computes percentiles", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 95)).toBe(10);
    expect(percentile(sorted, 99)).toBe(10);
    expect(percentile(sorted, 100)).toBe(10);
    expect(percentile(sorted, -10)).toBe(1);
    expect(() => percentile(sorted, Number.NaN)).toThrow(RangeError);
    expect(() => percentile(sorted, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("summarizes latencies and throughput", () => {
    const summary = summarizeLatencies([1, 2, 3, 4]);
    expect(summary.count).toBe(4);
    expect(summary.mean).toBeCloseTo(2.5, 3);
    // 4 evals in 10ms total => 400 evals/sec
    expect(summary.throughputPerSec).toBeCloseTo(400, 1);
  });

  it("returns finite zero metrics for an empty or zero-duration sample", () => {
    expect(summarizeLatencies([])).toEqual({
      count: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      mean: 0,
      throughputPerSec: 0
    });
    expect(() => percentile([], Number.NaN)).toThrow(RangeError);
    expect(summarizeLatencies([0, 0])).toMatchObject({
      count: 2,
      mean: 0,
      throughputPerSec: 0
    });
  });

  it("rejects non-finite and negative latency samples", () => {
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
      expect(() => summarizeLatencies([1, invalid])).toThrow(RangeError);
    }
    expect(() => summarizeLatencies([Number.MAX_VALUE, Number.MAX_VALUE])).toThrow(RangeError);
  });

  it("formats a reproducible report", () => {
    const summary = summarizeLatencies([1, 2, 3]);
    const report = formatBenchmarkReport(summary, {
      fixtures: 3,
      iterations: 1,
      policyPack: "fintech"
    });
    expect(report).toContain("AgentForge evaluation pipeline benchmark");
    expect(report).toContain("3 fixtures x 1 iterations");
    expect(report).toContain("Latency p50");
    expect(report).toContain("Throughput");
  });
});

describe("benchmark iteration parsing", () => {
  it("uses a safe default and accepts exact positive integers", () => {
    expect(parseIterations([])).toBe(DEFAULT_ITERATIONS);
    expect(parseIterations(["--iterations", "1"])).toBe(1);
    expect(parseIterations(["--iterations=25", "--other"])).toBe(25);
    expect(parseIterations(["--iterations", String(MAX_ITERATIONS)])).toBe(MAX_ITERATIONS);
  });

  it("rejects malformed, duplicated, and resource-exhausting values", () => {
    for (const argv of [
      ["--iterations"],
      ["--iterations", "--other"],
      ["--iterations", "0"],
      ["--iterations", "-1"],
      ["--iterations", "1.5"],
      ["--iterations", "2x"],
      ["--iterations", String(MAX_ITERATIONS + 1)],
      ["--iterations=1", "--iterations=2"]
    ]) {
      expect(() => parseIterations(argv)).toThrow();
    }
  });
});
