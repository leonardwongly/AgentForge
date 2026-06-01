import { describe, expect, it } from "vitest";
import type { PullRequestInput } from "./types.js";
import type { ScmProvider, ScmWebhookEnvelope } from "./scm.js";

// A fake provider proves the port is implementable and shape-stable; a real
// GitLab adapter would follow the same contract.
const fakeProvider: ScmProvider = {
  id: "fake",
  verifyWebhookSignature: ({ signature, secret }) => Boolean(signature) && signature === secret,
  normalizeWebhook: ({ event, payload }) => {
    const body = payload as { repositoryFullName?: string; number?: number };
    if (!body.repositoryFullName) {
      return undefined;
    }
    return {
      provider: "fake",
      event,
      repositoryFullName: body.repositoryFullName,
      pullRequestNumber: body.number
    } satisfies ScmWebhookEnvelope;
  },
  shouldEvaluate: (envelope) => envelope.pullRequestNumber !== undefined,
  fetchPullRequestInput: async (envelope): Promise<PullRequestInput> => ({
    repositoryFullName: envelope.repositoryFullName,
    pullRequestNumber: envelope.pullRequestNumber ?? 0,
    title: "",
    authorLogin: "",
    baseBranch: "main",
    headBranch: "feature",
    headSha: envelope.headSha ?? "sha",
    changedFiles: []
  })
};

describe("ScmProvider port", () => {
  it("verifies signatures and normalizes a webhook into a provider-agnostic envelope", () => {
    expect(
      fakeProvider.verifyWebhookSignature({ payload: "{}", signature: "s", secret: "s" })
    ).toBe(true);
    expect(
      fakeProvider.verifyWebhookSignature({ payload: "{}", signature: "s", secret: "x" })
    ).toBe(false);
    const envelope = fakeProvider.normalizeWebhook({
      event: "pull_request",
      payload: { repositoryFullName: "acme/app", number: 5 }
    });
    expect(envelope).toMatchObject({ provider: "fake", repositoryFullName: "acme/app" });
    expect(envelope && fakeProvider.shouldEvaluate(envelope)).toBe(true);
  });

  it("produces a PullRequestInput the evaluator can consume", async () => {
    const pr = await fakeProvider.fetchPullRequestInput({
      provider: "fake",
      event: "pull_request",
      repositoryFullName: "acme/app",
      pullRequestNumber: 5
    });
    expect(pr.repositoryFullName).toBe("acme/app");
    expect(pr.pullRequestNumber).toBe(5);
  });
});
