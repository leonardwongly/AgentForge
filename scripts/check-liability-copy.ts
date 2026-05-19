import { readFile } from "node:fs/promises";
import path from "node:path";

const files = [
  "README.md",
  "docs/product-overview.md",
  "docs/policy-packs.md",
  "docs/roadmap.md",
  "docs/launch-readiness-evidence.md",
  "docs/launch-positioning-and-pricing.md"
];

const bannedClaims = [
  "guaranteed safe",
  "guarantees safe",
  "guarantees security",
  "prevents all vulnerable code",
  "complete security coverage",
  "replaces code review",
  "certifies compliance",
  "detects every risky agent change",
  "ai firewall"
];

const requiredPrinciples = [
  "Deterministic checks decide. AI explains and assists. Humans approve risk.",
  "does not claim a PR is safe or unsafe",
  "LLM output, when enabled later, is advisory only",
  "autonomous merging"
];

const root = process.cwd();
const failures: string[] = [];
const combined: string[] = [];

for (const file of files) {
  const absolute = path.join(root, file);
  const content = await readFile(absolute, "utf8");
  const scannable = stripExplicitDisallowedExamples(content);
  const lower = scannable.toLowerCase();
  combined.push(content);
  for (const claim of bannedClaims) {
    if (lower.includes(claim)) {
      failures.push(`${file}: remove liability-heavy claim "${claim}"`);
    }
  }
}

const allContent = combined.join("\n");
for (const principle of requiredPrinciples) {
  if (!allContent.includes(principle)) {
    failures.push(`Missing required messaging principle: ${principle}`);
  }
}

if (failures.length > 0) {
  console.error(
    ["Messaging validation failed:", ...failures.map((failure) => `- ${failure}`)].join("\n")
  );
  process.exit(1);
}

console.log("Messaging validation passed.");

function stripExplicitDisallowedExamples(content: string): string {
  return content.replace(/Disallowed:[\s\S]*?## V1 Boundaries/u, "## V1 Boundaries");
}
