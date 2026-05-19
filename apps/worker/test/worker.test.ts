import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@agentforge/config";
import type { PolicyResult, PullRequestInput } from "@agentforge/core";
import type { GithubAdapterClient, GithubWebhookEnvelope } from "@agentforge/github";
import {
  classifyMergeGuardEvaluationFailure,
  processMergeGuardEvaluationJob,
  recordMergeGuardEvaluationFailure,
  RepositoryNotConfiguredError,
  resolveRuntimeEvaluationContext
} from "../src/index.js";

const mutableEnvKeys = [
  "NODE_ENV",
  "DATABASE_URL",
  "REDIS_URL",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_INSTALLATION_ID"
] as const;
const originalEnv = new Map<string, string | undefined>(
  mutableEnvKeys.map((key) => [key, process.env[key]])
);

async function loadPr(name: string): Promise<PullRequestInput> {
  return JSON.parse(
    await readFile(path.resolve(process.cwd(), "fixtures", "repos", name), "utf8")
  ) as PullRequestInput;
}

async function loadPolicy(name: string): Promise<string> {
  return readFile(path.resolve(process.cwd(), "fixtures", "policies", name), "utf8");
}

describe("Merge Guard worker evaluation jobs", () => {
  beforeEach(() => {
    for (const key of mutableEnvKeys) {
      process.env[key] = "";
    }
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    for (const key of mutableEnvKeys) {
      const originalValue = originalEnv.get(key);
      if (originalValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValue;
      }
    }
  });

  it("processes a high-risk PR fixture into a Change Control Record result", async () => {
    const result = await processMergeGuardEvaluationJob({
      deliveryId: "delivery-worker-billing",
      pr: await loadPr("billing-path.json"),
      policyYaml: await loadPolicy("fintech.yaml")
    });

    expect(result.repositoryFullName).toBe("acme/payments");
    expect(result.pullRequestNumber).toBe(2);
    expect(result.status).toBe("warn");
    expect(result.checkConclusion).toBe("neutral");
    expect(result.recordId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("keeps agent signals as additional scrutiny instead of the only governance gate", async () => {
    const policyYaml = await loadPolicy("enterprise-strict.yaml");
    const human = await processMergeGuardEvaluationJob({
      deliveryId: "delivery-worker-human-billing",
      pr: await loadPr("billing-path.json"),
      policyYaml
    });
    const agent = await processMergeGuardEvaluationJob({
      deliveryId: "delivery-worker-agent-billing",
      pr: await loadPr("billing-agent.json"),
      policyYaml
    });

    expect(human.status).toBe("block");
    expect(agent.status).toBe("block");
    expect(human.checkConclusion).toBe("failure");
    expect(agent.checkConclusion).toBe("failure");
  });

  it("rejects DB-backed runtime fallback when a repository has no configured policy", async () => {
    const pr = await loadPr("billing-path.json");
    const config = loadConfig();
    const prisma = {
      repository: {
        findFirst: vi.fn().mockResolvedValue(null)
      }
    };

    await expect(
      resolveRuntimeEvaluationContext({
        prisma: prisma as never,
        pr,
        config
      })
    ).rejects.toThrow(RepositoryNotConfiguredError);
  });

  it("allows DB-backed runtime evaluation only with an explicit job policy for unknown repositories", async () => {
    const pr = await loadPr("billing-path.json");
    const policyYaml = await loadPolicy("fintech.yaml");
    const config = loadConfig();
    const prisma = {
      repository: {
        findFirst: vi.fn().mockResolvedValue(null)
      }
    };

    const runtime = await resolveRuntimeEvaluationContext({
      prisma: prisma as never,
      pr,
      config,
      policyYaml
    });

    expect(runtime).toMatchObject({
      organizationId: "org_explicit_policy",
      policyYaml,
      modeOverride: undefined,
      ownerMappings: []
    });
  });

  it("fetches live GitHub PR facts before evaluating webhook jobs and publishing checks", async () => {
    const pr = await loadPr("billing-path.json");
    const envelope = webhookEnvelope(pr);
    const published: Array<{
      owner: string;
      repo: string;
      result: PolicyResult;
      detailsUrl?: string | undefined;
    }> = [];

    const result = await processMergeGuardEvaluationJob({
      deliveryId: envelope.deliveryId,
      envelope,
      policyYaml: await loadPolicy("fintech.yaml"),
      githubClient: githubClientForPr(pr),
      githubCheckPublisher: async (input) => {
        published.push({
          owner: input.owner,
          repo: input.repo,
          result: input.result,
          detailsUrl: input.detailsUrl
        });
        return { id: 42, conclusion: "neutral" };
      }
    });

    expect(result).toMatchObject({
      repositoryFullName: "acme/payments",
      pullRequestNumber: 2,
      status: "warn",
      checkConclusion: "neutral",
      checkPublished: true,
      publishedCheckRunId: 42
    });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ owner: "acme", repo: "payments" });
    expect(published[0]?.detailsUrl).toBeUndefined();
    expect(published[0]?.result.findings.map((finding) => finding.type)).toContain(
      "sensitive_path_changed"
    );
  });

  it("uses verified GitHub team membership to clear required team reviewers", async () => {
    const pr = {
      ...(await loadPr("billing-path.json")),
      body: "Rollback plan: revert the checkout change and redeploy the previous release.",
      reviews: [
        {
          reviewer: "alice",
          reviewerType: "user" as const,
          state: "APPROVED" as const,
          submittedAt: "2026-05-14T00:00:00.000Z"
        }
      ]
    };
    const envelope = webhookEnvelope(pr);
    const published: PolicyResult[] = [];

    await processMergeGuardEvaluationJob({
      deliveryId: envelope.deliveryId,
      envelope,
      policyYaml: await loadPolicy("fintech.yaml"),
      githubClient: githubClientForPr(pr, { alice: ["billing-owner"] }),
      githubCheckPublisher: async (input) => {
        published.push(input.result);
        return { id: 43, conclusion: "neutral" };
      }
    });

    expect(published).toHaveLength(1);
    expect(published[0]?.requiredReviewers[0]).toMatchObject({
      reviewer: "billing-owner",
      reviewerType: "team",
      approved: true,
      approvedBy: "alice"
    });
  });

  it("records merged lifecycle decisions from closed pull request webhooks", async () => {
    const pr = await loadPr("billing-path.json");
    const envelope = webhookEnvelope(pr, { action: "closed", merged: true });

    const result = await processMergeGuardEvaluationJob({
      deliveryId: envelope.deliveryId,
      pr,
      envelope,
      policyYaml: await loadPolicy("fintech.yaml")
    });

    expect(result.lifecycle).toBe("merged");
  });

  it("fails closed for webhook jobs when GitHub PR files cannot be fetched", async () => {
    const pr = await loadPr("billing-path.json");
    await expect(
      processMergeGuardEvaluationJob({
        deliveryId: "delivery-worker-webhook-without-github",
        envelope: webhookEnvelope(pr),
        policyYaml: await loadPolicy("fintech.yaml")
      })
    ).rejects.toThrow("required to inspect pull request files");
  });

  it("rejects queued jobs that do not contain a pull request payload", async () => {
    await expect(
      processMergeGuardEvaluationJob({
        deliveryId: "delivery-worker-non-pr"
      })
    ).rejects.toThrow("requires a pull request payload");
  });

  it("classifies transient GitHub failures as bounded retryable summaries", () => {
    const summary = classifyMergeGuardEvaluationFailure({
      error: new Error("GitHub API timeout while fetching files"),
      deliveryId: "delivery-transient",
      attemptsMade: 2,
      maxAttempts: 3,
      failedAt: "2026-05-19T00:00:00.000Z"
    });

    expect(summary).toEqual({
      errorClass: "Error",
      message: "GitHub API timeout while fetching files",
      retryable: true,
      terminalFailure: false,
      attemptsMade: 2,
      maxAttempts: 3,
      failedAt: "2026-05-19T00:00:00.000Z",
      correlationId: "delivery-transient"
    });
  });

  it("treats invalid payload failures as terminal and redacts unsafe error text", () => {
    const githubToken = ["gh", "p_", "1234567890", "1234567890", "1234567890", "123456"].join("");
    const summary = classifyMergeGuardEvaluationFailure({
      error: new Error(
        `Merge Guard evaluation job requires a pull request payload. token=${githubToken}`
      ),
      deliveryId: "delivery-terminal",
      attemptsMade: 1,
      maxAttempts: 3
    });

    expect(summary.retryable).toBe(false);
    expect(summary.terminalFailure).toBe(true);
    expect(summary.message).toContain("requires a pull request payload");
    expect(summary.message).not.toContain("ghp_123456");
    expect(summary.message).not.toContain(githubToken);
  });

  it("records failed evaluation summaries without storing job payloads", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const summary = classifyMergeGuardEvaluationFailure({
      error: new Error("GitHub API timeout"),
      deliveryId: "delivery-record-failure",
      attemptsMade: 3,
      maxAttempts: 3,
      failedAt: "2026-05-19T00:00:00.000Z"
    });

    await recordMergeGuardEvaluationFailure({
      prisma: { webhookDelivery: { updateMany } } as never,
      deliveryId: "delivery-record-failure",
      summary
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: { deliveryId: "delivery-record-failure" },
      data: expect.objectContaining({
        evaluationAttemptsMade: 3,
        evaluationTerminalFailure: true,
        lastFailureClass: "Error",
        lastFailureMessage: "GitHub API timeout",
        lastFailureCorrelationId: "delivery-record-failure",
        lastFailedAt: new Date("2026-05-19T00:00:00.000Z")
      })
    });
    expect(JSON.stringify(updateMany.mock.calls)).not.toContain("envelope");
    expect(JSON.stringify(updateMany.mock.calls)).not.toContain("payload");
  });
});

function webhookEnvelope(
  pr: PullRequestInput,
  options: { action?: string; merged?: boolean } = {}
): GithubWebhookEnvelope {
  const [owner = "acme", name = "payments"] = pr.repositoryFullName.split("/");
  return {
    deliveryId: `delivery-${pr.pullRequestNumber}`,
    event: "pull_request",
    action: options.action ?? "opened",
    installationId: 99,
    repository: {
      id: 1,
      fullName: pr.repositoryFullName,
      owner,
      name,
      defaultBranch: pr.baseBranch
    },
    pullRequest: {
      id: pr.pullRequestNumber,
      number: pr.pullRequestNumber,
      title: pr.title,
      authorLogin: pr.authorLogin,
      baseBranch: pr.baseBranch,
      headBranch: pr.headBranch,
      headSha: pr.headSha,
      body: pr.body,
      state: options.action === "closed" ? "closed" : "open",
      merged: options.merged ?? false
    },
    receivedAt: "2026-05-13T00:00:00.000Z"
  };
}

function githubClientForPr(
  pr: PullRequestInput,
  teamMemberships: Record<string, string[]> = {}
): GithubAdapterClient {
  const [owner = "acme", repo = "payments"] = pr.repositoryFullName.split("/");
  return {
    pulls: {
      get: async () => ({
        data: {
          id: pr.pullRequestNumber,
          number: pr.pullRequestNumber,
          title: pr.title,
          body: pr.body,
          user: { login: pr.authorLogin },
          base: { ref: pr.baseBranch, sha: "base-sha" },
          head: {
            ref: pr.headBranch,
            sha: pr.headSha,
            repo: { full_name: `${owner}/${repo}` }
          },
          labels: pr.labels?.map((name) => ({ name })) ?? []
        }
      }),
      listFiles: async () => ({
        data: pr.changedFiles.map((file) => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          patch: file.patch,
          previous_filename: file.previousFilename
        }))
      }),
      listReviews: async () => ({
        data:
          pr.reviews?.map((review) => ({
            state: review.state.toLowerCase(),
            submitted_at: review.submittedAt,
            user: { login: review.reviewer }
          })) ?? []
      }),
      listCommits: async () => ({
        data:
          pr.commits?.map((commit) => ({
            sha: commit.sha,
            commit: { message: commit.message },
            author: commit.authorLogin ? { login: commit.authorLogin } : undefined
          })) ?? []
      })
    },
    teams: {
      getMembershipForUserInOrg: async ({ team_slug, username }) => {
        if (
          typeof username === "string" &&
          typeof team_slug === "string" &&
          teamMemberships[username]?.includes(team_slug)
        ) {
          return { data: { state: "active" } };
        }
        throw new Error("not found");
      }
    }
  };
}
