import { createHash } from "node:crypto";
import YAML from "yaml";
import { policyConfigSchema, type PolicyConfig } from "./schema.js";

export type ParsedPolicy = {
  config: PolicyConfig;
  contentHash: string;
  errors: string[];
};

/** Keep YAML parsing bounded even when policy content comes from a persisted pack. */
export const MAX_POLICY_YAML_BYTES = 256 * 1024;

function failClosedPolicy(contentYaml: string, errors: string[]): ParsedPolicy {
  return {
    // Fail closed: an unparseable policy defaults to the strictest mode rather
    // than "observe" (which never blocks). Callers must still inspect `errors`
    // and reject the policy, but if a future caller uses `config` without
    // checking, this fails in the safe (enforcing) direction.
    config: policyConfigSchema.parse({ version: 1, agentforge: { mode: "enforce" } }),
    contentHash: hashPolicy(contentYaml),
    errors
  };
}

export function parsePolicyYaml(contentYaml: string): ParsedPolicy {
  // Although callers are typed, persisted/user-controlled values can still
  // cross the boundary at runtime. Keep malformed values fail-closed instead
  // of allowing Buffer.byteLength/YAML.parse to throw and bypass validation.
  if (typeof contentYaml !== "string") {
    return failClosedPolicy(String(contentYaml ?? ""), ["policy YAML must be a string"]);
  }
  if (Buffer.byteLength(contentYaml, "utf8") > MAX_POLICY_YAML_BYTES) {
    return failClosedPolicy(contentYaml, [
      `policy YAML exceeds the ${MAX_POLICY_YAML_BYTES}-byte limit`
    ]);
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(contentYaml);
  } catch (error) {
    return failClosedPolicy(contentYaml, [
      `invalid YAML: ${error instanceof Error ? error.message : "parse failed"}`
    ]);
  }

  const result = policyConfigSchema.safeParse(parsed);
  if (!result.success) {
    return failClosedPolicy(
      contentYaml,
      result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    );
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
