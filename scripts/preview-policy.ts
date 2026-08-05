import { readFile } from "node:fs/promises";
import type { PullRequestInput } from "../packages/core/src/index.ts";
import { detectorConfigFromPolicy, extractVerifiedFacts } from "../packages/detectors/src/index.ts";
import { evaluateMergeGuard, parsePolicyYaml } from "../packages/policy/src/index.ts";

const [policyPath, fixturePath] = process.argv.slice(2);

async function main(): Promise<void> {
  if (!policyPath || !fixturePath) {
    console.error("Usage: pnpm policy:preview <policy.yaml> <fixture-pr.json>");
    process.exit(1);
  }

  const policyYaml = await readFile(policyPath, "utf8");
  const pr = JSON.parse(await readFile(fixturePath, "utf8")) as PullRequestInput;
  const parsed = parsePolicyYaml(policyYaml);
  if (parsed.errors.length > 0) {
    console.error(JSON.stringify({ valid: false, errors: parsed.errors }, null, 2));
    process.exit(1);
  }

  const facts = extractVerifiedFacts(pr, detectorConfigFromPolicy(parsed.config));
  const result = evaluateMergeGuard(pr, facts, parsed.config, undefined, {
    sourceContentHash: parsed.contentHash
  });
  console.log(JSON.stringify(result, null, 2));
}

void main();
