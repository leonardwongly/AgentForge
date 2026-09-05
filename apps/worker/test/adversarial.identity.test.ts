import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "@agentforge/config";
import type { PullRequestInput } from "@agentforge/core";
import type { GithubWebhookEnvelope } from "@agentforge/github";
import {
  CheckPublicationClaimPendingError,
  computeBackoffDelay,
  publishTerminalFailureCheckRun,
  resolveEnvelopeEvaluationContext,
  resolveRuntimeEvaluationContext
} from "../src/index.js";

function envelope(
  overrides: Partial<GithubWebhookEnvelope["repository"]> = {}
): GithubWebhookEnvelope {
  return {
    deliveryId: "delivery-identity",
    event: "pull_request",
    action: "opened",
    installationId: 41,
    repository: {
      id: 9,
      fullName: "acme/payments",
      owner: "acme",
      name: "payments",
      defaultBranch: "main",
      ...overrides
    },
    pullRequest: {
      id: 7,
      number: 7,
      title: "test",
      authorLogin: "author",
      baseBranch: "main",
      headBranch: "feature",
      headSha: "head",
      state: "open",
      merged: false
    },
    receivedAt: "2026-09-05T00:00:00.000Z"
  };
}

const repository = {
  id: "repo-9",
  organizationId: "org-1",
  fullName: "acme/payments",
  enabled: true,
  mode: null,
  currentPolicyVersion: { contentYaml: "version: 1\n" },
  settings: null,
  ownerMappings: []
};

describe("worker adversarial identity and retry boundaries", () => {
  it("rejects an envelope whose owner/name disagrees with fullName before repository lookup", async () => {
    const repositoryFindFirst = vi.fn();
    const prisma = {
      gitHubInstallation: {
        findUnique: vi.fn().mockResolvedValue({
          organizationId: "org-1",
          status: "approved",
          archivedAt: null
        })
      },
      repository: { findFirst: repositoryFindFirst }
    };

    await expect(
      resolveEnvelopeEvaluationContext({
        prisma: prisma as never,
        envelope: envelope({ owner: "attacker" })
      })
    ).rejects.toThrow(/consistent GitHub repository owner/u);
    expect(repositoryFindFirst).not.toHaveBeenCalled();
  });

  it("rejects combining a bound repository policy with a PR from another repository", async () => {
    const pr = {
      repositoryFullName: "attacker/payments"
    } as PullRequestInput;

    await expect(
      resolveRuntimeEvaluationContext({
        prisma: {} as never,
        pr,
        config: loadConfig({ NODE_ENV: "test" }),
        envelopeContext: {
          installationId: 41,
          organizationId: "org-1",
          repository
        }
      })
    ).rejects.toThrow(/does not match the immutable GitHub repository binding/u);
  });

  it("does not publish a terminal failure check to a repository mismatched with the job PR", async () => {
    const publish = vi.fn().mockResolvedValue({ id: 9, conclusion: "failure" as const });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await publishTerminalFailureCheckRun({
        job: {
          data: {
            deliveryId: "delivery-mismatch",
            pr: {
              repositoryFullName: "victim/repo",
              pullRequestNumber: 12,
              headSha: "head"
            },
            envelope: envelope({ fullName: "attacker/repo", owner: "attacker", name: "repo" }),
            githubCheckPublisher: publish
          }
        },
        config: loadConfig({ NODE_ENV: "test" }),
        summary: {
          errorClass: "Error",
          message: "terminal",
          retryable: false,
          terminalFailure: true,
          attemptsMade: 3,
          maxAttempts: 3,
          failedAt: "2026-09-05T00:00:00.000Z",
          correlationId: "delivery-mismatch"
        }
      });
    } finally {
      errorSpy.mockRestore();
    }
    expect(publish).not.toHaveBeenCalled();
  });

  it("bounds malformed publication lease retry metadata", () => {
    const retry = new CheckPublicationClaimPendingError("delivery-lease", Number.NaN);
    const delay = computeBackoffDelay(1, "exponentialWithJitter", retry, { opts: {} });

    expect(delay).toBe(1000);
    expect(Number.isFinite(delay)).toBe(true);
  });
});
