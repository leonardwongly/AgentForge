/** Human-readable rendering of the CLI results. */
import type { CliVerifyResult, RatifyResult } from "./engine.js";

export function formatRatify(res: RatifyResult): string {
  const decision = res.evaluation.result;
  const lines: string[] = [];
  lines.push(`decision: ${decision.status.toUpperCase()}`);
  lines.push(`base:       ${res.baseAddress}`);
  lines.push(`result:     ${res.resultAddress}`);
  lines.push(`transition: ${res.subjectAddress}`);
  lines.push(`changed files: ${res.evaluation.diff.length}`);
  lines.push(`facts:         ${res.evaluation.facts.length}`);

  const requiredReviewers = decision.requiredReviewers.filter((r) => r.tier === "required");
  if (requiredReviewers.length > 0) {
    lines.push("required reviewers:");
    for (const reviewer of requiredReviewers) {
      lines.push(`  - ${reviewer.reviewer} [${reviewer.approved ? "approved" : "pending"}]`);
    }
  }

  const openEvidence = decision.requiredEvidence.filter((e) => e.status !== "approved");
  if (openEvidence.length > 0) {
    lines.push("required evidence:");
    for (const evidence of openEvidence) {
      lines.push(`  - ${evidence.kind} [${evidence.status}]`);
    }
  }

  if (decision.explanation.length > 0) {
    lines.push("reasons:");
    for (const reason of decision.explanation) {
      lines.push(`  - ${reason}`);
    }
  }

  if (res.envelope) {
    lines.push(
      `attestation: signed (${res.envelope.payloadType}, ${res.envelope.signatures.length} signature)`
    );
  }
  return lines.join("\n");
}

export function formatVerify(res: CliVerifyResult): string {
  const lines: string[] = [];
  lines.push(
    res.verdict.ok ? "attestation: VALID" : `attestation: INVALID (${res.verdict.reason})`
  );
  lines.push(`base:       ${res.baseAddress}`);
  lines.push(`result:     ${res.resultAddress}`);
  lines.push(`transition: ${res.subjectAddress}`);
  return lines.join("\n");
}
