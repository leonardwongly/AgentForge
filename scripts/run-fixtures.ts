import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { PullRequestInput } from "../packages/core/src/index.ts";
import { detectorConfigFromPolicy, extractVerifiedFacts } from "../packages/detectors/src/index.ts";
import {
  getPolicyPack,
  parsePolicyYaml,
  evaluateMergeGuard
} from "../packages/policy/src/index.ts";

const policyPath = process.argv[2];

async function main(): Promise<void> {
  const policyYaml = policyPath
    ? await readFile(policyPath, "utf8")
    : (getPolicyPack("fintech")?.contentYaml ?? "");
  const parsed = parsePolicyYaml(policyYaml);
  if (parsed.errors.length > 0) {
    console.error(JSON.stringify({ valid: false, errors: parsed.errors }, null, 2));
    process.exit(1);
  }

  const fixtureDir = path.resolve(process.cwd(), "fixtures", "repos");
  const files = (await readdir(fixtureDir)).filter((file) => file.endsWith(".json")).sort();
  const summary = [];
  for (const file of files) {
    const pr = JSON.parse(await readFile(path.join(fixtureDir, file), "utf8")) as PullRequestInput;
    const facts = extractVerifiedFacts(pr, detectorConfigFromPolicy(parsed.config));
    const result = evaluateMergeGuard(pr, facts, parsed.config, undefined, {
      sourceContentHash: parsed.contentHash
    });
    summary.push({
      fixture: file,
      status: result.status,
      mode: result.mode,
      findings: result.findings.map((finding) => finding.type),
      missingEvidence: result.requiredEvidence
        .filter((item) => item.status === "missing")
        .map((item) => item.kind),
      requiredReviewers: result.requiredReviewers.map((item) => item.reviewer)
    });
  }

  console.log(JSON.stringify(summary, null, 2));
}

void main();
