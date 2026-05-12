import { createHash } from "node:crypto";
import YAML from "yaml";
import { policyConfigSchema, type PolicyConfig } from "./schema.js";

export type ParsedPolicy = {
  config: PolicyConfig;
  contentHash: string;
  errors: string[];
};

export function parsePolicyYaml(contentYaml: string): ParsedPolicy {
  const parsed = YAML.parse(contentYaml);
  const result = policyConfigSchema.safeParse(parsed);
  if (!result.success) {
    return {
      config: policyConfigSchema.parse({ version: 1, agentforge: { mode: "observe" } }),
      contentHash: hashPolicy(contentYaml),
      errors: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    };
  }

  return {
    config: result.data,
    contentHash: hashPolicy(contentYaml),
    errors: []
  };
}

export function validatePolicyYaml(contentYaml: string): { valid: boolean; errors: string[] } {
  const parsed = parsePolicyYaml(contentYaml);
  return { valid: parsed.errors.length === 0, errors: parsed.errors };
}

export function hashPolicy(contentYaml: string): string {
  return createHash("sha256").update(contentYaml).digest("hex");
}
