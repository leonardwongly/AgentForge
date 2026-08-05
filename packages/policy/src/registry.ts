import type { PolicyMode, PolicyResult, PullRequestInput, VerifiedFact } from "@agentforge/core";
import { evaluateMergeGuard } from "./evaluate.js";
import { parsePolicyYaml } from "./parser.js";
import { builtinPolicyPacks, type PolicyPack } from "./packs.js";

export type PolicyPackSummary = {
  id: string;
  ref: string;
  name: string;
  description: string;
  version: string;
  builtIn: boolean;
  defaultMode: PolicyMode;
};

// Shareable, version-qualified identifier (matches the policyVersion convention).
export function policyPackRef(pack: Pick<PolicyPack, "id" | "version">): string {
  return `${pack.id}@${pack.version}`;
}

// Registry catalog: version-qualified summaries of the available packs.
export function listPolicyPacks(packs: PolicyPack[] = builtinPolicyPacks): PolicyPackSummary[] {
  return packs.map((pack) => ({
    id: pack.id,
    ref: policyPackRef(pack),
    name: pack.name,
    description: pack.description,
    version: pack.version,
    builtIn: pack.builtIn,
    defaultMode: pack.defaultMode
  }));
}

// Version-aware resolution: accepts "id" (any version) or "id@version".
export function getPolicyPackByRef(
  ref: string,
  packs: PolicyPack[] = builtinPolicyPacks
): PolicyPack | undefined {
  const separator = ref.indexOf("@");
  const id = separator === -1 ? ref : ref.slice(0, separator);
  const version = separator === -1 ? undefined : ref.slice(separator + 1);
  return packs.find(
    (pack) => pack.id === id && (version === undefined || pack.version === version)
  );
}

// Preview the governance impact of a pack on a pull request. Detection stays the
// caller's responsibility (facts are passed in), so this adds no cross-package
// dependency and never blocks — it returns the deterministic evaluation result.
export function previewPolicyPackImpact(input: {
  pack: PolicyPack;
  pr: PullRequestInput;
  facts: VerifiedFact[];
}): PolicyResult {
  const parsed = parsePolicyYaml(input.pack.contentYaml);
  return evaluateMergeGuard(input.pr, input.facts, parsed.config, undefined, {
    sourceContentHash: parsed.contentHash
  });
}
