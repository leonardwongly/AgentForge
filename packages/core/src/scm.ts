import type { PullRequestInput } from "./types.js";

// Provider-agnostic webhook envelope: the minimum AgentForge needs to decide
// whether to evaluate a change and to address the resulting check back to the SCM.
export type ScmWebhookEnvelope = {
  provider: string;
  event: string;
  action?: string | undefined;
  repositoryFullName: string;
  pullRequestNumber?: number | undefined;
  headSha?: string | undefined;
  installationId?: string | undefined;
};

// Port that any source-control provider must satisfy. GitHub implements this
// today; a second provider (e.g. GitLab) only needs to implement this seam,
// leaving the deterministic evaluator, records, and policy layers unchanged (C6).
export interface ScmProvider {
  readonly id: string;
  verifyWebhookSignature(input: {
    payload: string;
    signature: string | undefined;
    secret: string | undefined;
  }): boolean;
  normalizeWebhook(input: { event: string; payload: unknown }): ScmWebhookEnvelope | undefined;
  shouldEvaluate(envelope: ScmWebhookEnvelope): boolean;
  fetchPullRequestInput(envelope: ScmWebhookEnvelope): Promise<PullRequestInput>;
}
