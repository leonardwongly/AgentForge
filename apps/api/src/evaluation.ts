import type { ChangeControlRecord, PullRequestInput } from "@agentforge/core";
import { detectorConfigFromPolicy, extractVerifiedFacts } from "@agentforge/detectors";
import { buildCheckRunPayload } from "@agentforge/github";
import { evaluateMergeGuard, parsePolicyYaml, type PolicyConfig } from "@agentforge/policy";
import { createChangeControlRecord } from "@agentforge/records";

export type EvaluationOutput = {
  policy: PolicyConfig;
  result: ReturnType<typeof evaluateMergeGuard>;
  record: ChangeControlRecord;
  checkRun: ReturnType<typeof buildCheckRunPayload>;
};

export function evaluateFixturePr(input: {
  pr: PullRequestInput;
  policyYaml: string;
  organizationId?: string;
  repositoryId?: string;
}): EvaluationOutput {
  const parsed = parsePolicyYaml(input.policyYaml);
  if (parsed.errors.length > 0) {
    throw new Error(`Policy validation failed: ${parsed.errors.join("; ")}`);
  }
  const facts = extractVerifiedFacts(input.pr, detectorConfigFromPolicy(parsed.config));
  const result = evaluateMergeGuard(input.pr, facts, parsed.config);
  const record = createChangeControlRecord({
    organizationId: input.organizationId ?? "org_local",
    repositoryId: input.repositoryId ?? "repo_local",
    pr: input.pr,
    policyResult: result
  });
  const checkRun = buildCheckRunPayload(input.pr, result);

  return {
    policy: parsed.config,
    result,
    record,
    checkRun
  };
}
