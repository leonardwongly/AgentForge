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

export function percentile(sorted: number[], p: number): number {
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
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const totalMs = latenciesMs.reduce((sum, value) => sum + value, 0);
  const mean = totalMs / latenciesMs.length;
  return {
    count: latenciesMs.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    mean,
    throughputPerSec: (latenciesMs.length / totalMs) * 1000
  };
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
  const iterationsArg = process.argv.findIndex((arg) => arg === "--iterations");
  const iterations = iterationsArg >= 0 ? Number.parseInt(process.argv[iterationsArg + 1] ?? "3", 10) : 3;

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
    files.map(async (file) =>
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
