import { readFile } from "node:fs/promises";
import { validatePolicyYaml } from "../packages/policy/src/index.ts";

const policyPath = process.argv[2];

async function main(): Promise<void> {
  if (!policyPath) {
    console.error("Usage: pnpm policy:validate <policy.yaml>");
    process.exit(1);
  }

  const content = await readFile(policyPath, "utf8");
  const result = validatePolicyYaml(content);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.valid ? 0 : 1);
}

void main();
