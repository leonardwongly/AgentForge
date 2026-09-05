/**
 * AgentForge performance benchmark for the deterministic evaluation pipeline
 * (detectors + policy). Measures per-evaluation latency (p50/p95/p99) and
 * throughput over the bundled fixture corpus, and prints a reproducible report
 * with dataset and hardware disclosure.
 *
 * Usage:
 *   pnpm benchmark [--iterations N]
 */
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PullRequestInput } from "../packages/core/src/index.ts";
import { detectorConfigFromPolicy, extractVerifiedFacts } from "../packages/detectors/src/index.ts";
import {
  evaluateMergeGuard,
  getPolicyPack,
  parsePolicyYaml
} from "../packages/policy/src/index.ts";

export const DEFAULT_ITERATIONS = 3;
// Keep the CLI bounded so a typo cannot turn a local benchmark into an
// unbounded CPU/memory workload. The limit is intentionally generous for a
// useful local run while still making accidental resource exhaustion finite.
export const MAX_ITERATIONS = 10_000;

export function percentile(sorted: number[], p: number): number {
  if (!Number.isFinite(p)) {
    throw new RangeError("Percentile must be a finite number.");
  }
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export function summarizeLatencies(latenciesMs: number[]): {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  throughputPerSec: number;
} {
  for (const latency of latenciesMs) {
    if (!Number.isFinite(latency) || latency < 0) {
      throw new RangeError("Latency samples must be finite and non-negative.");
    }
  }
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const totalMs = latenciesMs.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(totalMs)) {
    throw new RangeError("Latency total must be finite.");
  }
  const mean = latenciesMs.length === 0 ? 0 : totalMs / latenciesMs.length;
  return {
    count: latenciesMs.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    mean,
    // A zero-duration sample can occur with a mocked or coarse timer. Do not
    // report Infinity, which would make the benchmark output misleading.
    throughputPerSec: totalMs > 0 ? (latenciesMs.length / totalMs) * 1000 : 0
  };
}

/**
 * Parse the benchmark iteration option without silently accepting malformed
 * values (Number.parseInt("2x") and Number.parseInt("1.5") are both unsafe
 * for a resource-consuming CLI).
 */
export function parseIterations(argv: readonly string[]): number {
  let value: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--iterations") {
      if (value !== undefined) {
        throw new Error("--iterations may be specified only once.");
      }
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("--iterations requires a positive integer value.");
      }
      value = next;
      index += 1;
    } else if (argument?.startsWith("--iterations=")) {
      if (value !== undefined) {
        throw new Error("--iterations may be specified only once.");
      }
      value = argument.slice("--iterations=".length);
    }
  }

  if (value === undefined) {
    return DEFAULT_ITERATIONS;
  }
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error(`--iterations must be a positive integer no greater than ${MAX_ITERATIONS}.`);
  }
  const iterations = Number(value);
  if (!Number.isSafeInteger(iterations) || iterations > MAX_ITERATIONS) {
    throw new Error(`--iterations must be a positive integer no greater than ${MAX_ITERATIONS}.`);
  }
  return iterations;
}

export function formatBenchmarkReport(
  summary: ReturnType<typeof summarizeLatencies>,
  dataset: { fixtures: number; iterations: number; policyPack: string }
): string {
  return [
    "AgentForge evaluation pipeline benchmark",
    `- Dataset: ${dataset.fixtures} fixtures x ${dataset.iterations} iterations (policy pack: ${dataset.policyPack})`,
    `- Platform: ${os.platform()} ${os.arch()}, ${os.cpus().length} CPUs`,
    `- Node: ${process.version}`,
    `- Evaluations: ${summary.count}`,
    `- Latency p50: ${summary.p50.toFixed(3)} ms`,
    `- Latency p95: ${summary.p95.toFixed(3)} ms`,
    `- Latency p99: ${summary.p99.toFixed(3)} ms`,
    `- Mean latency: ${summary.mean.toFixed(3)} ms`,
    `- Throughput: ${summary.throughputPerSec.toFixed(1)} evals/sec`
  ].join("\n");
}

async function main(): Promise<void> {
  const iterations = parseIterations(process.argv.slice(2));

  const policyPack = "fintech";
  const policyYaml = getPolicyPack(policyPack)?.contentYaml ?? "";
  const parsed = parsePolicyYaml(policyYaml);
  if (parsed.errors.length > 0) {
    console.error(`Policy parse failed: ${parsed.errors.join("; ")}`);
    process.exitCode = 1;
    return;
  }

  const fixtureDir = path.resolve(process.cwd(), "fixtures", "repos");
  const files = (await readdir(fixtureDir)).filter((file) => file.endsWith(".json")).sort();
  const prs = await Promise.all(
    files.map(
      async (file) =>
        JSON.parse(await readFile(path.join(fixtureDir, file), "utf8")) as PullRequestInput
    )
  );
  if (prs.length === 0) {
    console.error("No fixture PRs found.");
    process.exitCode = 1;
    return;
  }

  const detectorConfig = detectorConfigFromPolicy(parsed.config);
  const latencies: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    for (const pr of prs) {
      const start = performance.now();
      const facts = extractVerifiedFacts(pr, detectorConfig);
      evaluateMergeGuard(pr, facts, parsed.config, undefined, {
        sourceContentHash: parsed.contentHash
      });
      latencies.push(performance.now() - start);
    }
  }

  const summary = summarizeLatencies(latencies);
  console.log(formatBenchmarkReport(summary, { fixtures: prs.length, iterations, policyPack }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
