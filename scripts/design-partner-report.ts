/**
 * AgentForge design-partner evidence report.
 *
 * Automates the "evidence capture template" from docs/launch-positioning-and-pricing.md
 * by turning a Change Control Record export into a structured validation report:
 * override rate, evidence-rejection rate, time-to-resolve, reviewer bottlenecks,
 * per-detector precision, and a governance health score.
 *
 * Usage:
 *   pnpm design-partner:report --input records.json [--output report.md]
 *
 * `records.json` is a JSON array of ChangeControlRecord objects (e.g. from a
 * JSON CCR export). The report is written as Markdown and also printed to stdout.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { ChangeControlRecord } from "../packages/core/src/types.ts";
import {
  computeDetectorMetrics,
  generatePolicyTuningReport,
  proposePolicyTuningActions
} from "../packages/records/src/index.ts";

function parseArgs(argv: string[]): { input: string; output?: string } {
  const args = { input: "", output: undefined as string | undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--input" && argv[i + 1]) {
      args.input = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--output" && argv[i + 1]) {
      args.output = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

export function buildEvidenceReport(records: ChangeControlRecord[]): string {
  const report = generatePolicyTuningReport(records);
  const proposals = proposePolicyTuningActions(report);
  const detectorMetrics = computeDetectorMetrics(records);
  const lines: string[] = [];
  lines.push("# AgentForge Design-Partner Evidence Report");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Records analyzed: ${report.recordCount}`);
  lines.push(`- Window: ${report.window.oldestRecordAt ?? "n/a"} → ${report.window.newestRecordAt ?? "n/a"}`);
  lines.push(`- Governance health: ${report.governanceHealth.score}/100 (grade ${report.governanceHealth.grade})`);
  lines.push("");
  lines.push("## Validation metrics");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Override rate | ${report.metrics.overrideRate}% |`);
  lines.push(`| Rejected evidence rate | ${report.metrics.rejectedEvidenceRate}% |`);
  lines.push(`| Open evidence rate | ${report.metrics.openEvidenceRate}% |`);
  lines.push(`| Pending reviewer rate | ${report.metrics.pendingReviewerRate}% |`);
  lines.push(`| Median reviewer approval hours | ${report.metrics.medianReviewerApprovalHours ?? "n/a"} |`);
  lines.push(`| Observe/warn open requirements | ${report.metrics.observeOrWarnOpenRequirementCount} |`);
  lines.push("");
  lines.push("## Per-detector precision");
  lines.push("");
  if (detectorMetrics.length === 0) {
    lines.push("No findings in this window.");
  } else {
    lines.push("| Detector | Findings | Records | Overrides | Precision |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const metric of detectorMetrics) {
      lines.push(
        `| ${metric.detector} | ${metric.findingCount} | ${metric.affectedRecordCount} | ${metric.overrideCount} | ${Math.round(metric.precision * 100)}% |`
      );
    }
  }
  lines.push("");
  lines.push("## Advisory tuning insights");
  lines.push("");
  if (report.insights.length === 0) {
    lines.push("No tuning insights for this window.");
  } else {
    for (const insight of report.insights) {
      lines.push(`- **${insight.title}** (${insight.severity}): ${insight.recommendation}`);
    }
  }
  lines.push("");
  lines.push("## Human-gated proposals");
  lines.push("");
  lines.push(`- ${proposals.length} proposal(s) require explicit platform-admin approval. None are auto-applied.`);
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { input, output } = parseArgs(process.argv.slice(2));
  if (!input) {
    console.error("Missing --input <records.json>");
    process.exitCode = 1;
  } else {
    try {
      const records = JSON.parse(readFileSync(input, "utf8")) as ChangeControlRecord[];
      const markdown = buildEvidenceReport(records);
      if (output) {
        writeFileSync(output, markdown, "utf8");
        console.log(`Wrote evidence report to ${output}`);
      }
      console.log(markdown);
    } catch (error) {
      console.error(`Failed to build evidence report: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
